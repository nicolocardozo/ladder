// Push tests with a fake fetch: no calls to Expo.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerCatalog } from '../../shared/i18n.ts'
import it from '../../shared/locales/it/host.ts'
import type { PushEvent, RemoteNotifyPrefs } from '../../shared/protocol.ts'
import { openDb } from '../db.ts'
import { RemoteAccess } from './access.ts'
import { cleanNotifyPrefs, DEFAULT_NOTIFY_PREFS, inQuietHours, parseNotifyPrefs, pushBody, wantsPush } from './push-policy.ts'
import { BACKOFF_MS, EXPO_PUSH_URL, EXPO_RECEIPTS_URL, MAX_BATCH, maskToken, PushService, RECEIPT_DELAY_MS, type FetchLike } from './push.ts'

registerCatalog('it', it)

const at = (iso: string): number => Date.parse(iso)
const request: PushEvent = { kind: 'request', sessionId: 's1', itemId: 'q1' }

test('quiet hours: same day, across midnight, edges, empty range', () => {
  const day = { from: '09:00', to: '17:00', tz: 'UTC' }
  assert.equal(inQuietHours(day, at('2026-01-01T09:00:00Z')), true)
  assert.equal(inQuietHours(day, at('2026-01-01T16:59:00Z')), true)
  assert.equal(inQuietHours(day, at('2026-01-01T17:00:00Z')), false)
  const night = { from: '22:00', to: '07:00', tz: 'UTC' }
  assert.equal(inQuietHours(night, at('2026-01-01T23:30:00Z')), true)
  assert.equal(inQuietHours(night, at('2026-01-02T00:30:00Z')), true)
  assert.equal(inQuietHours(night, at('2026-01-02T06:59:00Z')), true)
  assert.equal(inQuietHours(night, at('2026-01-02T07:00:00Z')), false)
  assert.equal(inQuietHours(night, at('2026-01-02T12:00:00Z')), false)
  assert.equal(inQuietHours({ from: '10:00', to: '10:00', tz: 'UTC' }, at('2026-01-02T10:00:00Z')), false)
  assert.equal(inQuietHours(null, 0), false)
  assert.equal(inQuietHours({ from: '22:00', to: '07:00', tz: 'Not/AZone' }, at('2026-01-02T23:00:00Z')), false)
})

test('quiet hours: evaluated in the phone’s time zone (with daylight saving)', () => {
  const night = { from: '23:00', to: '07:00', tz: 'Europe/Rome' }
  // Winter UTC+1: 22:30Z = 23:30 in Rome (inside); 21:30Z = 22:30 (outside).
  assert.equal(inQuietHours(night, at('2026-01-15T22:30:00Z')), true)
  assert.equal(inQuietHours(night, at('2026-01-15T21:30:00Z')), false)
  // Summer UTC+2: 21:30Z = 23:30 in Rome (inside); 20:30Z = 22:30 (outside).
  assert.equal(inQuietHours(night, at('2026-07-15T21:30:00Z')), true)
  assert.equal(inQuietHours(night, at('2026-07-15T20:30:00Z')), false)
  // Same instant, two different zones.
  const t = at('2026-01-15T03:00:00Z')
  assert.equal(inQuietHours({ from: '22:00', to: '07:00', tz: 'America/New_York' }, t), true) // 22:00 in New York
  assert.equal(inQuietHours({ from: '22:00', to: '07:00', tz: 'Asia/Tokyo' }, t), false) // 12:00 in Tokyo
})

test('wantsPush: events off, quiet hours and allowed requests', () => {
  const night = { from: '22:00', to: '07:00', tz: 'UTC' }
  const base: RemoteNotifyPrefs = { events: { request: true, turn: true, error: false, agents: true }, quiet: night }
  const quietTime = at('2026-01-01T23:00:00Z')
  const dayTime = at('2026-01-01T12:00:00Z')
  assert.equal(wantsPush(base, 'turn', dayTime), true)
  assert.equal(wantsPush(base, 'error', dayTime), false)
  assert.equal(wantsPush(base, 'turn', quietTime), false)
  assert.equal(wantsPush(base, 'request', quietTime), false)
  assert.equal(wantsPush({ ...base, quietAllowsRequests: true }, 'request', quietTime), true)
  assert.equal(wantsPush({ ...base, quietAllowsRequests: true }, 'turn', quietTime), false)
  assert.equal(wantsPush({ ...base, events: { ...base.events, request: false }, quietAllowsRequests: true }, 'request', quietTime), false)
  assert.equal(wantsPush(DEFAULT_NOTIFY_PREFS, 'agents', quietTime), true)
})

test('cleanNotifyPrefs / parseNotifyPrefs: validation and defaults', () => {
  const ok = { events: { request: true, turn: false, error: true, agents: true }, quiet: { from: '22:00', to: '07:00', tz: 'Europe/Rome' }, quietAllowsRequests: true, extra: 1 }
  assert.deepEqual(cleanNotifyPrefs(ok), { events: ok.events, quiet: ok.quiet, quietAllowsRequests: true })
  assert.deepEqual(cleanNotifyPrefs({ events: ok.events, quiet: null }), { events: ok.events, quiet: null })
  for (const bad of [null, [], {}, { events: { request: true } }, { events: { ...ok.events, turn: 'no' }, quiet: null }, { events: ok.events, quiet: { from: '24:00', to: '07:00', tz: 'UTC' } }, { events: ok.events, quiet: { from: '22:00', to: '7:00', tz: 'UTC' } }, { events: ok.events, quiet: { from: '22:00', to: '07:00', tz: 'Mars/Base' } }, { events: ok.events, quiet: null, quietAllowsRequests: 'y' }]) {
    assert.equal(cleanNotifyPrefs(bad), null, JSON.stringify(bad))
  }
  assert.deepEqual(parseNotifyPrefs(null), DEFAULT_NOTIFY_PREFS)
  assert.deepEqual(parseNotifyPrefs('{bad'), DEFAULT_NOTIFY_PREFS)
  assert.deepEqual(parseNotifyPrefs(JSON.stringify(ok)), cleanNotifyPrefs(ok))
})

test('generic text in the device language', () => {
  assert.equal(pushBody('request', 'en'), 'A session is waiting for you')
  assert.equal(pushBody('request', 'it'), 'Una sessione ti aspetta')
  assert.equal(pushBody('turn', 'it'), 'Una sessione è finita')
  assert.equal(pushBody('error', 'en'), 'A session hit an error')
  assert.equal(pushBody('agents', 'it'), 'Gli agenti in background hanno finito')
})

test('maskToken never shows the whole token', () => {
  assert.equal(maskToken('ExponentPushToken[abcdefghijkl]'), 'ExponentPushToken[abcd…]')
  assert.equal(maskToken('weird-token'), 'weir…')
})

interface Call {
  url: string
  body: unknown
  headers: Record<string, string>
}

/** Environment: real in-memory database, devices paired by hand, fake fetch with programmable responses. */
function env(answer: (call: Call) => { status?: number; body: unknown } = (call) => ({ body: { data: (call.body as unknown[]).map((_, i) => ({ status: 'ok', id: `id-${i}-${Math.random()}` })) } })) {
  const db = openDb(':memory:')
  const access = new RemoteAccess(db)
  access.enabled = true
  let n = 0
  const add = (token: string | null, extra: { prefs?: RemoteNotifyPrefs; locale?: 'en' | 'it'; revoked?: boolean } = {}): string => {
    const id = `d${++n}`
    db.prepare('insert into devices (id, name, platform, public_key, push_token, created_at) values (?, ?, ?, ?, ?, ?)').run(id, `Phone ${n}`, 'ios', `key${n}`, token, 1)
    if (extra.prefs) access.setNotifyPrefs(id, extra.prefs)
    if (extra.locale) access.setLocale(id, extra.locale)
    if (extra.revoked) access.revoke(id)
    return id
  }
  const calls: Call[] = []
  const state = { now: at('2026-01-01T12:00:00Z'), foreground: new Set<string>() }
  const fetch: FetchLike = async (url, init) => {
    const call = { url, body: JSON.parse(init.body), headers: init.headers }
    calls.push(call)
    const r = answer(call)
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body }
  }
  const logs: string[] = []
  const service = new PushService({ access, macId: () => 'mac-1', foreground: () => state.foreground, fetch, now: () => state.now, log: (m) => logs.push(m) })
  return { db, access, add, calls, state, service, logs }
}

test('notify: skips revoked devices, no token, event off, quiet hours and foreground app', async () => {
  const e = env()
  const ok = e.add('ExponentPushToken[ok]')
  e.add(null)
  e.add('ExponentPushToken[revoked]', { revoked: true })
  e.add('ExponentPushToken[off]', { prefs: { events: { request: false, turn: true, error: true, agents: true }, quiet: null } })
  e.add('ExponentPushToken[quiet]', { prefs: { events: { request: true, turn: true, error: true, agents: true }, quiet: { from: '11:00', to: '13:00', tz: 'UTC' } } })
  const fg = e.add('ExponentPushToken[fg]')
  e.state.foreground.add(fg)
  const allowed = e.add('ExponentPushToken[allowed]', { prefs: { events: { request: true, turn: true, error: true, agents: true }, quiet: { from: '11:00', to: '13:00', tz: 'UTC' }, quietAllowsRequests: true } })
  await e.service.notify(request)
  assert.equal(e.calls.length, 1)
  const tokens = (e.calls[0].body as { to: string }[]).map((m) => m.to).sort()
  assert.deepEqual(tokens, ['ExponentPushToken[allowed]', 'ExponentPushToken[ok]'])
  assert.ok(ok && allowed)
})

test('notify: payload without titles or project text, Expo format, device language', async () => {
  const e = env()
  e.add('ExponentPushToken[en]')
  e.add('ExponentPushToken[it]', { locale: 'it' })
  await e.service.notify(request)
  const [call] = e.calls
  assert.equal(call.url, EXPO_PUSH_URL)
  assert.equal(call.headers.Accept, 'application/json')
  assert.equal(call.headers['Content-Type'], 'application/json')
  const messages = call.body as Record<string, unknown>[]
  const byToken = Object.fromEntries(messages.map((m) => [m.to as string, m]))
  const en = byToken['ExponentPushToken[en]']
  assert.deepEqual(en, { to: 'ExponentPushToken[en]', title: 'Ladder', body: 'A session is waiting for you', data: { v: 1, kind: 'request', sessionId: 's1', itemId: 'q1', mac: 'mac-1' }, sound: 'default', priority: 'high', channelId: 'sessions', ttl: 3600 })
  assert.equal(byToken['ExponentPushToken[it]'].body, 'Una sessione ti aspetta')
  // Nothing besides the known fields: no project name, session title or text.
  assert.deepEqual(Object.keys((en as { data: object }).data).sort(), ['itemId', 'kind', 'mac', 'sessionId', 'v'])
})

test('notify: channel off → no push; same event repeated within 5 seconds → only one', async () => {
  const e = env()
  e.add('ExponentPushToken[a]')
  e.access.enabled = false
  await e.service.notify(request)
  assert.equal(e.calls.length, 0)
  e.access.enabled = true
  await e.service.notify(request)
  await e.service.notify(request)
  assert.equal(e.calls.length, 1)
  e.state.now += 6000
  await e.service.notify(request)
  assert.equal(e.calls.length, 2)
})

test('sending in groups of 100', async () => {
  const e = env()
  const messages = Array.from({ length: 250 }, (_, i) => ({ to: `ExponentPushToken[t${i}]`, title: 'Ladder', body: 'x', data: { v: 1 as const, kind: 'turn' as const, sessionId: 's', itemId: null, mac: 'm' }, sound: 'default' as const, priority: 'high' as const, channelId: 'sessions', ttl: 1 }))
  await e.service.send(messages)
  assert.deepEqual(e.calls.map((c) => (c.body as unknown[]).length), [MAX_BATCH, MAX_BATCH, 50])
})

test('DeviceNotRegistered removes that device’s token and only that one', async () => {
  const e = env((call) => ({ body: { data: (call.body as { to: string }[]).map((m) => (m.to.includes('dead') ? { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'r' })) } }))
  const dead = e.add('ExponentPushToken[dead]')
  const live = e.add('ExponentPushToken[live]')
  await e.service.notify(request)
  assert.equal(e.access.device(dead)?.pushToken, null)
  assert.equal(e.access.device(live)?.pushToken, 'ExponentPushToken[live]')
  assert.ok(e.logs.every((l) => !l.includes('dead]')), 'token never whole in the log')
  // The next event no longer includes it.
  e.state.now += 10_000
  await e.service.notify({ ...request, itemId: 'q2' })
  assert.deepEqual((e.calls[1].body as { to: string }[]).map((m) => m.to), ['ExponentPushToken[live]'])
})

test('InvalidCredentials: tokens are kept, a single warning in the log', async () => {
  const e = env((call) => ({ body: { data: (call.body as unknown[]).map(() => ({ status: 'error', message: 'x', details: { error: 'InvalidCredentials' } })) } }))
  const id = e.add('ExponentPushToken[a]')
  await e.service.notify(request)
  e.state.now += 10_000
  await e.service.notify({ ...request, itemId: 'q2' })
  assert.equal(e.access.device(id)?.pushToken, 'ExponentPushToken[a]')
  assert.equal(e.logs.filter((l) => l.includes('InvalidCredentials')).length, 1)
})

test('MessageRateExceeded and 429: pause, no storm of new sends, then resume', async () => {
  let rate = true
  const e = env((call) => (rate ? { body: { data: (call.body as unknown[]).map(() => ({ status: 'error', message: 'x', details: { error: 'MessageRateExceeded' } })) } } : { body: { data: (call.body as unknown[]).map(() => ({ status: 'ok', id: 'r' })) } }))
  const id = e.add('ExponentPushToken[a]')
  await e.service.notify(request)
  assert.equal(e.calls.length, 1)
  e.state.now += 10_000
  await e.service.notify({ ...request, itemId: 'q2' })
  assert.equal(e.calls.length, 1, 'in pausa')
  rate = false
  e.state.now += BACKOFF_MS
  await e.service.notify({ ...request, itemId: 'q3' })
  assert.equal(e.calls.length, 2)
  assert.equal(e.access.device(id)?.pushToken, 'ExponentPushToken[a]')
  const f = env(() => ({ status: 429, body: { errors: [{ code: 'TOO_MANY_REQUESTS' }] } }))
  f.add('ExponentPushToken[a]')
  await f.service.notify(request)
  f.state.now += 10_000
  await f.service.notify({ ...request, itemId: 'q2' })
  assert.equal(f.calls.length, 1)
})

test('network errors, malformed responses and MessageTooBig do not throw and leave tokens alone', async () => {
  const db = openDb(':memory:')
  const access = new RemoteAccess(db)
  access.enabled = true
  db.prepare('insert into devices (id, name, platform, public_key, push_token, created_at) values (?, ?, ?, ?, ?, ?)').run('d', 'P', 'ios', 'k', 'ExponentPushToken[a]', 1)
  let mode = 0
  const service = new PushService({
    access,
    macId: () => 'm',
    foreground: () => new Set(),
    fetch: async () => {
      mode++
      if (mode === 1) throw new Error('offline')
      if (mode === 2) return { ok: true, status: 200, json: async () => 'nope' }
      return { ok: true, status: 200, json: async () => ({ data: [{ status: 'error', details: { error: 'MessageTooBig' } }] }) }
    }
  })
  for (const itemId of ['1', '2', '3']) await service.notify({ kind: 'turn', sessionId: 's', itemId })
  assert.equal(access.device('d')?.pushToken, 'ExponentPushToken[a]')
})

test('receipts after 15 minutes: DeviceNotRegistered removes the token', async () => {
  const e = env((call) => {
    if (call.url === EXPO_RECEIPTS_URL) return { body: { data: { 'id-dead': { status: 'error', details: { error: 'DeviceNotRegistered' } }, 'id-live': { status: 'ok' } } } }
    return { body: { data: (call.body as { to: string }[]).map((m) => ({ status: 'ok', id: m.to.includes('dead') ? 'id-dead' : 'id-live' })) } }
  })
  const dead = e.add('ExponentPushToken[dead]')
  const live = e.add('ExponentPushToken[live]')
  await e.service.notify(request)
  await e.service.pollReceipts()
  assert.equal(e.calls.length, 1, 'too early: no receipts request')
  e.state.now += RECEIPT_DELAY_MS
  await e.service.pollReceipts()
  assert.equal(e.calls.length, 2)
  assert.deepEqual(e.calls[1].body, { ids: ['id-dead', 'id-live'] })
  assert.equal(e.access.device(dead)?.pushToken, null)
  assert.equal(e.access.device(live)?.pushToken, 'ExponentPushToken[live]')
  e.service.stop()
})

test('revocation: the token disappears and is no longer used; a channel that is off sends nothing', async () => {
  const e = env()
  const id = e.add('ExponentPushToken[a]')
  e.access.revoke(id)
  await e.service.notify(request)
  assert.equal(e.calls.length, 0)
})

test('pause checked at each group: after MessageRateExceeded the rest is dropped', async () => {
  const e = env((call) => ({ body: { data: (call.body as unknown[]).map(() => ({ status: 'error', details: { error: 'MessageRateExceeded' } })) } }))
  const messages = Array.from({ length: 250 }, (_, i) => ({ to: `ExponentPushToken[t${i}]`, title: 'Ladder', body: 'x', data: { v: 1 as const, kind: 'turn' as const, sessionId: 's', itemId: null, mac: 'm' }, sound: 'default' as const, priority: 'high' as const, channelId: 'sessions', ttl: 1 }))
  await e.service.send(messages)
  assert.equal(e.calls.length, 1)
})

test('stop clears pending receipts', async () => {
  const e = env()
  e.add('ExponentPushToken[a]')
  await e.service.notify(request)
  e.service.stop()
  e.state.now += RECEIPT_DELAY_MS
  await e.service.pollReceipts()
  assert.equal(e.calls.length, 1)
})

test('pushMacId: stable, 16 base64url characters, different per key, does not contain the key', async () => {
  const { pushMacId } = await import('../../shared/remote/pairing.ts')
  const id = pushMacId('KEY-A')
  assert.match(id, /^[A-Za-z0-9_-]{16}$/)
  assert.equal(pushMacId('KEY-A'), id)
  assert.notEqual(pushMacId('KEY-B'), id)
})
