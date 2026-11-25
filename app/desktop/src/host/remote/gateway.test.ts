// Prove del gateway remoto in-process: Host finto, collegamenti in memoria, handshake Noise vero.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatItem, FromRemoteHost, HostEvent, RemoteAuthResult, RemoteLogEntry, ToRemoteHost } from '../../shared/protocol.ts'
import { generateKeyPair } from '../../shared/remote/noise.ts'
import { generateDeviceKey, signChannelBinding, toBase64Url, type DeviceKeyPair } from '../../shared/remote/pairing.ts'
import { clientHandshake, type RemoteSession } from '../../shared/remote/session.ts'
import { openDb } from '../db.ts'
import { FAILURE_LIMIT, LOG_MAX_ENTRIES, RemoteAccess } from './access.ts'
import { isRemoteCommandType, parseRemoteMessage } from './allowlist.ts'
import { MAX_CONNECTIONS, MAX_UNAUTHENTICATED, MAX_WATCHED, RATE_BURST, RemoteGateway, toRemoteSnapshot, type RemoteHostApi, type RemoteLink } from './gateway.ts'
import { IDENTITY_FILE, loadOrCreateIdentity } from './identity.ts'

interface End {
  bytes: ((b: Uint8Array) => void) | null
  close: (() => void) | null
  closed: boolean
  peer: End
  link: RemoteLink
}

/** Coppia di collegamenti in memoria: quello che un lato `send`, l'altro lo riceve (in modo asincrono, come una rete). */
function linkPair(): { client: End; server: End } {
  const make = (): End => {
    const end: End = {
      bytes: null,
      close: null,
      closed: false,
      peer: null as unknown as End,
      link: {
        send: (b) => queueMicrotask(() => end.peer.bytes?.(b)),
        close: () => {
          if (end.closed) return
          end.closed = true
          queueMicrotask(() => end.peer.close?.())
        },
        onBytes: (h) => (end.bytes = h),
        onClose: (h) => (end.close = h)
      }
    }
    return end
  }
  const a = make()
  const b = make()
  a.peer = b
  b.peer = a
  return { client: a, server: b }
}

const snapshotEvent = {
  type: 'snapshot',
  projects: [{ id: 'p1', name: 'P', path: '/tmp/p', branch: 'main', isGit: true, addedAt: 1 }],
  sessions: [],
  drafts: { 'draft:1': 'secret draft' },
  ui: { p1: { tabs: ['s1'], activeTab: 's1', scroll: {}, seenAt: 5, groups: [{ id: 'g', name: 'G' }], groupOf: { s1: 'g' }, terminal: { open: true, height: 1, active: null } } },
  agents: [],
  profiles: [],
  connections: [],
  terminals: [],
  shortcuts: { preset: 'default', overrides: {} }
} as unknown as Extract<HostEvent, { type: 'snapshot' }>

function fakeHost() {
  const calls: { command: unknown; origin: object }[] = []
  const closed: object[] = []
  const host: RemoteHostApi = {
    snapshot: async () => snapshotEvent,
    handle: async (command, origin) => {
      calls.push({ command, origin })
      if ((command as { type: string }).type === 'subagent.list') throw new Error('boom')
      return { ok: command.type }
    },
    pageItems: (sessionId, before, limit) => ({ sessionId, items: [], hasMore: before === 1 && limit === 2 }),
    connectionClosed: (origin) => closed.push(origin)
  }
  return { host, calls, closed }
}

function newAccess(options: ConstructorParameters<typeof RemoteAccess>[1] = {}): RemoteAccess {
  const access = new RemoteAccess(openDb(':memory:'), options)
  access.enabled = true
  return access
}

const route = (mac: { publicKey: Uint8Array }) => ({ macName: 'Test Mac', key: mac.publicKey, ws: 'ws://127.0.0.1:1' })

/** Gateway + Mac + database in memoria: più connessioni possono condividerli. */
function setup(options: { host?: RemoteHostApi; idleTimeoutMs?: number; access?: RemoteAccess; log?: RemoteLogEntry[]; now?: () => number } = {}) {
  const mac = generateKeyPair()
  const fake = fakeHost()
  const access = options.access ?? newAccess()
  const gateway = new RemoteGateway({
    host: options.host ?? fake.host,
    identity: mac,
    access,
    macName: 'Test Mac',
    appVersion: '9.9.9',
    idleTimeoutMs: options.idleTimeoutMs,
    now: options.now,
    onLog: options.log ? (entry) => options.log!.push(entry) : undefined
  })
  return { mac, fake, access, gateway }
}

type Env = ReturnType<typeof setup>

interface ConnectOptions {
  env?: Env
  helloV?: number
  /** false: ci si ferma dopo l'handshake, il primo messaggio lo manda il test. */
  authenticate?: boolean
  /** Dispositivo già abbinato: si manda `auth` invece di `pair`. */
  device?: { key: DeviceKeyPair; id: string }
  password?: string
  token?: string
  name?: string
  /** Lingua dichiarata nell'hello. */
  locale?: 'en' | 'it'
}

async function connect(options: ConnectOptions & { idleTimeoutMs?: number; host?: RemoteHostApi } = {}) {
  const env = options.env ?? setup({ host: options.host, idleTimeoutMs: options.idleTimeoutMs })
  const { mac, gateway, fake, access } = env
  const { client, server } = linkPair()
  gateway.accept(server.link)
  const hs = clientHandshake({ macPublicKey: mac.publicKey, hello: { device: 'Phone', ...(options.locale ? { locale: options.locale } : {}), ...(options.helloV ? { v: options.helloV } : {}) } as { device: string } })
  const events: FromRemoteHost[] = []
  const auths: RemoteAuthResult[] = []
  const waiters = new Map<string, (m: FromRemoteHost) => void>()
  let authWaiter: ((r: RemoteAuthResult) => void) | null = null
  let session: RemoteSession | null = null
  let closedByPeer = false
  const opened = new Promise<void>((resolve) => {
    client.link.onBytes((bytes) => {
      if (!session) {
        const done = hs.finish(bytes)
        session = done.session
        assert.equal(done.hello.mac, 'Test Mac')
        assert.equal(done.hello.app, '9.9.9')
        return resolve()
      }
      const message = session.open<FromRemoteHost>(bytes)
      if (!message) return
      if (message.kind === 'result') waiters.get(message.rid)?.(message)
      else if (message.kind === 'auth') {
        auths.push(message)
        authWaiter?.(message)
      } else events.push(message)
    })
    client.link.onClose(() => (closedByPeer = true))
  })
  client.link.send(hs.start())
  await opened
  const hash = () => session!.handshakeHash
  const sendRaw = (message: unknown) => {
    for (const m of session!.seal(message)) client.link.send(m)
  }
  const nextAuth = () => new Promise<RemoteAuthResult>((resolve) => (authWaiter = resolve))
  /** Manda pair (codice nuovo o `token`) o auth e aspetta l'esito. */
  const authenticate = async (extra: { token?: string; password?: string; device?: { key: DeviceKeyPair; id: string }; name?: string; key?: DeviceKeyPair } = {}) => {
    const dev = extra.device ?? options.device
    const result = nextAuth()
    if (dev) sendRaw({ type: 'auth', deviceId: dev.id, sig: signChannelBinding(dev.key.secretKey, 'auth', hash()) })
    else {
      const key = extra.key ?? generateDeviceKey()
      const token = extra.token ?? options.token ?? access.startPairing(route(mac)).payload.token
      sendRaw({
        type: 'pair',
        token,
        device: { publicKey: toBase64Url(key.publicKey), name: extra.name ?? options.name ?? 'Test iPhone', platform: 'ios' },
        ...(extra.password ?? options.password ? { password: extra.password ?? options.password } : {}),
        sig: signChannelBinding(key.secretKey, 'pair', hash())
      })
    }
    return result
  }
  if (options.authenticate !== false) {
    const result = await authenticate()
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  let n = 0
  const call = (command: unknown, extra: Record<string, unknown> = {}) =>
    new Promise<FromRemoteHost>((resolve) => {
      const rid = `r${++n}`
      waiters.set(rid, resolve)
      sendRaw({ rid, command, ...extra })
    })
  const flush = () => new Promise((r) => setTimeout(r, 10))
  return { mac, gateway, fake, access, client, server, events, auths, call, flush, sendRaw, authenticate, hash, closed: () => closedByPeer, session: () => session! }
}

test('hello: snapshot ridotto (niente bozze, terminali, scorciatoie, profili; della UI solo gruppi e seenAt)', async () => {
  const c = await connect()
  const result = await c.call({ type: 'hello' })
  assert.equal(result.kind, 'result')
  const data = (result as { data: Record<string, unknown> }).data
  assert.deepEqual(Object.keys(data).sort(), ['agents', 'defaults', 'permissionsMax', 'prefs', 'profiles', 'projects', 'sessions', 'type', 'ui'])
  assert.deepEqual((data as { prefs: unknown }).prefs, { busySend: 'steer', allowFull: true })
  assert.deepEqual(data.ui, { p1: { groups: [{ id: 'g', name: 'G' }], groupOf: { s1: 'g' }, seenAt: 5 } })
  // Lo snapshot viaggia una volta sola, come risultato: nessun evento duplicato.
  await c.flush()
  assert.equal(c.events.filter((e) => e.kind === 'event' && e.event.type === 'snapshot').length, 0)
  assert.deepEqual(toRemoteSnapshot(snapshotEvent, { permissionsMax: {}, prefs: { busySend: 'steer', allowFull: true } }), data)
})

test('allowlist: comandi non ammessi respinti prima di Host.handle', async () => {
  const c = await connect()
  for (const type of ['project.remove', 'terminal.input', 'session.archive', 'draft.set', 'fs.read', 'ui.set', 'session.open', '__proto__', 'toString']) {
    const r = await c.call({ type, sessionId: 's1' })
    assert.equal(r.kind === 'result' && r.ok, false, type)
    assert.match((r as { error: string }).error, /not available from the phone/)
  }
  assert.equal(c.fake.calls.length, 0)
})

test('allowlist: forma non valida respinta con errore e rid', async () => {
  const c = await connect()
  for (const command of [{ type: 'session.send', sessionId: 's1' }, { type: 'session.watch', sessionId: 's1', on: 'yes' }, { type: 'session.respond', sessionId: 's1' }, 'nope']) {
    const r = await c.call(command)
    assert.equal(r.kind === 'result' && r.ok, false)
  }
  assert.equal(c.fake.calls.length, 0)
})

test('session.permission.set accetta solo livelli validi', async () => {
  const c = await connect()
  for (const permission of ['x', '', 'toString', 'FULL', 1, null]) {
    const r = await c.call({ type: 'session.permission.set', sessionId: 's1', permission })
    assert.equal(r.kind === 'result' && r.ok, false, String(permission))
  }
  assert.equal(c.fake.calls.length, 0)
  for (const permission of ['plan', 'ask', 'edit', 'full']) await c.call({ type: 'session.permission.set', sessionId: 's1', permission })
  assert.equal(c.fake.calls.length, 4)
})

test('session.respond: forma della risposta controllata a fondo', async () => {
  const c = await connect()
  const bad: unknown[] = [
    {},
    { optionId: 5 },
    { optionId: '' },
    { optionId: 'a', extra: 1 },
    { optionId: 'a', message: 7 },
    { optionId: 'a', message: 'x'.repeat(200_001) },
    { optionId: 'x'.repeat(300) },
    { answers: 'no' },
    { answers: { q: 1 } },
    { answers: { q: 'a' }, optionId: 'a' },
    { answers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`q${i}`, 'a'])) },
    [],
    'allow'
  ]
  for (const response of bad) {
    const r = await c.call({ type: 'session.respond', sessionId: 's1', requestId: 'q', response })
    assert.equal(r.kind === 'result' && r.ok, false, JSON.stringify(response)?.slice(0, 60))
  }
  assert.equal(c.fake.calls.length, 0)
  await c.call({ type: 'session.respond', sessionId: 's1', requestId: 'q', response: { optionId: 'allow', message: 'ok' } })
  await c.call({ type: 'session.respond', sessionId: 's1', requestId: 'q', response: { answers: { a: 'b' } } })
  assert.equal(c.fake.calls.length, 2)
})

test('session.queue.set: solo id e testo, con limiti', async () => {
  const c = await connect()
  const bad: unknown[] = ['x', [{ id: 1, text: 'a' }], [{ id: 'a' }], [null], Array.from({ length: 51 }, (_, i) => ({ id: `${i}`, text: 'a' })), [{ id: 'a', text: 'x'.repeat(200_001) }]]
  for (const queue of bad) {
    const r = await c.call({ type: 'session.queue.set', sessionId: 's1', queue })
    assert.equal(r.kind === 'result' && r.ok, false)
  }
  assert.equal(c.fake.calls.length, 0)
  await c.call({ type: 'session.queue.set', sessionId: 's1', queue: [{ id: 'a', text: 'ciao', attachments: [{ name: 'f', mediaType: 'x', data: 'AAAA' }], evil: true }] })
  assert.deepEqual(c.fake.calls[0].command, { type: 'session.queue.set', sessionId: 's1', queue: [{ id: 'a', text: 'ciao' }] })
})

test('rid non valido: connessione chiusa', async () => {
  for (const rid of [5, '', 'x'.repeat(129), {}]) {
    const c = await connect()
    for (const m of c.session().seal({ rid, command: { type: 'session.read', sessionId: 's1' } })) c.client.link.send(m)
    await c.flush()
    assert.equal(c.gateway.size, 0, JSON.stringify(rid)?.slice(0, 20))
    assert.equal(c.fake.calls.length, 0)
  }
})

test('limite di richieste: oltre la raffica errore, poi chiusura se si insiste', async () => {
  const c = await connect()
  const results: FromRemoteHost[] = []
  for (let i = 0; i < RATE_BURST + 10; i++) results.push(await c.call({ type: 'session.read', sessionId: 's1' }))
  const failed = results.filter((r) => r.kind === 'result' && !r.ok)
  assert.ok(failed.length >= 8 && failed.length <= 10, `rifiutate: ${failed.length}`)
  assert.match((failed[0] as { error: string }).error, /Too many requests/)
  assert.ok(c.fake.calls.length >= RATE_BURST && c.fake.calls.length <= RATE_BURST + 2)
  for (let i = 0; i < 200; i++) for (const m of c.session().seal({ rid: `x${i}`, command: { type: 'session.read', sessionId: 's1' } })) c.client.link.send(m)
  await c.flush()
  assert.equal(c.gateway.size, 0)
})

test('session.items con replace: true arriva ridotto all’ultima pagina', async () => {
  const c = await connect()
  await c.call({ type: 'session.watch', sessionId: 's1', on: true })
  const many = Array.from({ length: 500 }, (_, i) => ({ ...item, id: `i${i}`, seq: i }) as ChatItem)
  c.gateway.broadcast({ type: 'session.items', sessionId: 's1', items: many, replace: true })
  await c.flush()
  const event = c.events.at(-1)
  assert.ok(event && event.kind === 'event' && event.event.type === 'session.items')
  // Il pageItems del Host finto restituisce una pagina vuota: i 500 item non sono passati.
  assert.deepEqual(event.event, { type: 'session.items', sessionId: 's1', items: [], replace: true })
})

test('al massimo 8 connessioni contemporanee', async () => {
  const env = setup()
  for (let i = 0; i < MAX_CONNECTIONS; i++) await connect({ env })
  const extra = linkPair()
  env.gateway.accept(extra.server.link)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(env.gateway.size, MAX_CONNECTIONS)
  assert.equal(extra.server.closed, true)
  env.gateway.close()
})

test('connessioni non autenticate: al massimo 4, a quella nuova fa posto la più vecchia', async () => {
  const env = setup()
  const pairs = Array.from({ length: MAX_UNAUTHENTICATED + 2 }, () => linkPair())
  for (const p of pairs) env.gateway.accept(p.server.link)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(env.gateway.size, MAX_UNAUTHENTICATED)
  // Le due più vecchie sono state chiuse, le ultime restano.
  assert.deepEqual(pairs.map((p) => p.server.closed), [true, true, false, false, false, false])
  env.gateway.close()
})

test('connessioni piene: un telefono vero entra anche se chi occupa i posti non si autentica', async () => {
  const env = setup()
  for (let i = 0; i < MAX_UNAUTHENTICATED; i++) env.gateway.accept(linkPair().server.link)
  const c = await connect({ env })
  assert.ok(c.auths[0].ok)
  env.gateway.close()
})

test('silenzio dopo l’handshake: connessione chiusa', async () => {
  const c = await connect({ idleTimeoutMs: 60 })
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(c.gateway.size, 0)
  assert.equal(c.fake.closed.length, 1)
})

test('isRemoteCommandType e parseRemoteMessage', () => {
  assert.equal(isRemoteCommandType('session.page'), true)
  assert.equal(isRemoteCommandType('session.send'), true)
  assert.equal(isRemoteCommandType('session.open'), false)
  assert.equal(isRemoteCommandType(undefined), false)
  const m = { invalid: 'i', notAllowed: 'n' }
  assert.throws(() => parseRemoteMessage(null, m), /i/)
  assert.throws(() => parseRemoteMessage({ rid: 'x', command: { type: 'project.add', path: '/' } }, m), /n/)
  assert.equal(parseRemoteMessage({ rid: 'x', command: { type: 'hello' } }, m).rid, 'x')
})

test('session.respond vale sempre via phone; session.send perde gli allegati', async () => {
  const c = await connect()
  await c.call({ type: 'session.respond', sessionId: 's1', requestId: 'q', response: { optionId: 'allow' }, via: 'chat' })
  await c.call({ type: 'session.send', sessionId: 's1', text: 'hi', attachments: [{ name: 'x' }] })
  await c.call({ type: 'session.interrupt', sessionId: 's1' })
  const [respond, send, interrupt] = c.fake.calls
  assert.equal((respond.command as { via: string }).via, 'phone')
  assert.deepEqual(send.command, { type: 'session.send', sessionId: 's1', text: 'hi' })
  assert.equal('attachments' in (send.command as object), false)
  assert.equal((interrupt.command as { type: string }).type, 'session.interrupt')
  // Stessa origin per tutti i comandi di una connessione.
  assert.equal(respond.origin, send.origin)
})

test('errori di Host.handle tornano come result ok:false', async () => {
  const c = await connect()
  const r = await c.call({ type: 'subagent.list', sessionId: 's1' })
  assert.deepEqual(r, { kind: 'result', rid: 'r1', ok: false, error: 'boom' })
})

test('session.page passa before e limit all’host', async () => {
  const c = await connect()
  const r = await c.call({ type: 'session.page', sessionId: 's1', before: 1, limit: 2 })
  assert.deepEqual(r, { kind: 'result', rid: 'r1', ok: true, data: { sessionId: 's1', items: [], hasMore: true } })
  assert.equal(c.fake.calls.length, 0)
})

const item = { id: 'i', seq: 1, kind: 'user', text: 't' } as unknown as ChatItem

test('eventi: solo i tipi ammessi, e session.items solo per le sessioni seguite', async () => {
  const c = await connect()
  const items = (sessionId: string): HostEvent => ({ type: 'session.items', sessionId, items: [item], replace: false })
  c.gateway.broadcast(items('s1'))
  c.gateway.broadcast({ type: 'terminal.data', id: 't', data: 'x' } as HostEvent)
  c.gateway.broadcast({ type: 'shortcuts.changed', state: {} } as unknown as HostEvent)
  c.gateway.broadcast({ type: 'project.removed', projectId: 'p1' })
  await c.flush()
  assert.deepEqual(c.events.map((e) => e.kind === 'event' && e.event.type), ['project.removed'])

  await c.call({ type: 'session.watch', sessionId: 's1', on: true })
  c.gateway.broadcast(items('s1'))
  c.gateway.broadcast(items('s2'))
  c.gateway.broadcast({ type: 'session.subagents', sessionId: 's1', subagents: [] })
  c.gateway.broadcast({ type: 'session.subagents', sessionId: 's2', subagents: [] })
  await c.flush()
  assert.deepEqual(c.events.slice(1).map((e) => e.kind === 'event' && `${e.event.type}:${'sessionId' in e.event ? e.event.sessionId : ''}`), ['session.items:s1', 'session.subagents:s1'])

  await c.call({ type: 'session.watch', sessionId: 's1', on: false })
  c.gateway.broadcast(items('s1'))
  await c.flush()
  assert.equal(c.events.length, 3)
})

test('session.watch: al massimo 8, la meno recente smette', async () => {
  const c = await connect()
  for (let i = 0; i < MAX_WATCHED; i++) await c.call({ type: 'session.watch', sessionId: `s${i}`, on: true })
  await c.call({ type: 'session.watch', sessionId: 's0', on: true }) // s0 diventa la più recente
  await c.call({ type: 'session.watch', sessionId: 'nuova', on: true }) // esce s1
  for (const id of ['s0', 's1', 'nuova']) c.gateway.broadcast({ type: 'session.items', sessionId: id, items: [item], replace: true })
  await c.flush()
  assert.deepEqual(
    c.events.map((e) => e.kind === 'event' && e.event.type === 'session.items' && e.event.sessionId),
    ['s0', 'nuova']
  )
})

test('chiusura: host.connectionClosed con la stessa origin dei comandi', async () => {
  const c = await connect()
  await c.call({ type: 'session.read', sessionId: 's1' })
  c.client.link.close()
  await c.flush()
  assert.equal(c.fake.closed.length, 1)
  assert.equal(c.fake.closed[0], c.fake.calls[0].origin)
  assert.equal(c.gateway.size, 0)
})

test('messaggio manomesso o riprodotto: il gateway chiude la connessione', async () => {
  const c = await connect()
  const [sealed] = c.session().seal({ rid: 'a', command: { type: 'session.read', sessionId: 's1' } })
  c.client.link.send(sealed)
  c.client.link.send(sealed) // replay
  await c.flush()
  assert.equal(c.gateway.size, 0)
  assert.equal(c.fake.closed.length, 1)
})

test('messaggio oltre REMOTE_MAX_MESSAGE: connessione chiusa', async () => {
  const c = await connect()
  for (const m of c.session().seal({ rid: 'a', command: { type: 'session.send', sessionId: 's1', text: 'a'.repeat(16 * 1024 * 1024) } })) c.client.link.send(m)
  await c.flush()
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(c.gateway.size, 0)
  assert.equal(c.fake.calls.length, 0)
})

test('versione del protocollo diversa: connessione chiusa nell’handshake', async () => {
  const mac = generateKeyPair()
  const gateway = new RemoteGateway({ host: fakeHost().host, identity: mac, access: newAccess(), macName: 'm', appVersion: '1' })
  const { client, server } = linkPair()
  gateway.accept(server.link)
  const hs = clientHandshake({ macPublicKey: mac.publicKey, hello: { device: 'p', v: 99 } as { device: string } })
  client.link.send(hs.start())
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(gateway.size, 0)
  assert.equal(server.closed, true)
})

test('handshake con la chiave sbagliata o spazzatura: connessione chiusa', async () => {
  const gateway = new RemoteGateway({ host: fakeHost().host, identity: generateKeyPair(), access: newAccess(), macName: 'm', appVersion: '1' })
  const { client, server } = linkPair()
  gateway.accept(server.link)
  client.link.send(clientHandshake({ macPublicKey: generateKeyPair().publicKey, hello: { device: 'p' } }).start())
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(gateway.size, 0)
  const pair2 = linkPair()
  gateway.accept(pair2.server.link)
  pair2.client.link.send(new Uint8Array(10))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(gateway.size, 0)
})

test('identità: creata una volta, 0600, stessa chiave alla seconda lettura', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ladder-identity-'))
  try {
    const a = loadOrCreateIdentity(dir)
    assert.equal(statSync(join(dir, IDENTITY_FILE)).mode & 0o777, 0o600)
    const b = loadOrCreateIdentity(dir)
    assert.equal(toBase64Url(a.publicKey), toBase64Url(b.publicKey))
    assert.deepEqual(a.secretKey, b.secretKey)
    // Nessun file temporaneo rimasto.
    assert.deepEqual(readdirSync(dir), [IDENTITY_FILE])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identità: file illeggibile → errore generico, senza pezzi del contenuto', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ladder-identity-'))
  try {
    writeFileSync(join(dir, IDENTITY_FILE), '{"secretKey":"SEGRETO-SEGRETO", broken')
    assert.throws(
      () => loadOrCreateIdentity(dir),
      (error: Error) => error.message === 'Remote identity file is not valid.' && !error.message.includes('SEGRETO')
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Il tipo del messaggio che il client manda è quello del contratto.
const _check: ToRemoteHost = { rid: 'x', command: { type: 'session.page', sessionId: 's' } }
void _check

// ── LAD-51: autenticazione dei dispositivi ───────────────────────────────────

const expectClosed = async (c: { flush: () => Promise<unknown>; closed: () => boolean; server: End }) => {
  await c.flush()
  assert.equal(c.server.closed, true)
}

test('abbinamento: il telefono entra, compare nell’elenco, vede le sessioni', async () => {
  const c = await connect({ name: 'Zoë’s iPhone' })
  const auth = c.auths[0]
  assert.ok(auth.ok)
  assert.equal(auth.name, 'Zoë’s iPhone')
  assert.equal(auth.allowFull, true)
  const devices = c.access.devices()
  assert.equal(devices.length, 1)
  assert.equal(devices[0].id, auth.deviceId)
  assert.equal(devices[0].platform, 'ios')
  assert.deepEqual([...c.gateway.connectedDevices()], [auth.deviceId])
  const hello = await c.call({ type: 'hello' })
  assert.ok(hello.kind === 'result' && hello.ok)
  // Il codice è monouso: lo stato non ne ha più uno.
  assert.equal(c.access.pairing(), null)
})

test('comandi prima dell’autenticazione: respinti e connessione chiusa', async () => {
  for (const first of [{ rid: 'a', command: { type: 'hello' } }, { type: 'pair' }, { type: 'auth' }, 'x', { type: 'pair', token: 5 }]) {
    const c = await connect({ authenticate: false })
    const result = new Promise<RemoteAuthResult>((resolve) => c.sendRaw(first) ?? resolve({ kind: 'auth', ok: false, code: 'invalid-request', error: '' }))
    void result
    await c.flush()
    await expectClosed(c)
    assert.equal(c.fake.calls.length, 0)
    assert.equal(c.events.length, 0)
    assert.ok(c.auths.every((a) => !a.ok), JSON.stringify(first))
    assert.equal(c.gateway.size, 0)
  }
})

test('un secondo messaggio mentre si autentica chiude la connessione', async () => {
  const c = await connect({ authenticate: false })
  c.sendRaw({ type: 'auth', deviceId: 'x', sig: 'y' })
  c.sendRaw({ rid: 'a', command: { type: 'hello' } })
  await c.flush()
  assert.equal(c.gateway.size, 0)
  assert.equal(c.fake.calls.length, 0)
})

test('codice sbagliato, scaduto, già usato, annullato', async () => {
  let now = 1_000_000
  const env = setup({ access: newAccess({ now: () => now }) })
  const bad = await connect({ env, authenticate: false })
  const r1 = await bad.authenticate({ token: 'nope' })
  assert.deepEqual(r1.ok === false && r1.code, 'bad-token')
  // Il testo è per l'utente e tradotto.
  assert.ok(!r1.ok && r1.error.length > 5)

  const token = env.access.startPairing(route(env.mac)).payload.token
  const good = await connect({ env, token })
  assert.ok(good.auths[0].ok)
  const again = await connect({ env, authenticate: false })
  const r2 = await again.authenticate({ token })
  assert.equal(r2.ok === false && r2.code, 'token-used')

  const expiring = env.access.startPairing(route(env.mac)).payload.token
  now += 5 * 60 * 1000 + 1
  const late = await connect({ env, authenticate: false })
  const r3 = await late.authenticate({ token: expiring })
  assert.equal(r3.ok === false && r3.code, 'token-expired')

  const cancelled = env.access.startPairing(route(env.mac)).payload.token
  env.access.cancelPairing()
  const c4 = await connect({ env, authenticate: false })
  assert.equal((await c4.authenticate({ token: cancelled })).ok, false)
  assert.equal(env.access.devices().length, 1)
})

test('un solo codice attivo: uno nuovo sostituisce il precedente', async () => {
  const env = setup()
  const first = env.access.startPairing(route(env.mac)).payload.token
  env.access.startPairing(route(env.mac))
  const c = await connect({ env, authenticate: false })
  const r = await c.authenticate({ token: first })
  assert.equal(r.ok, false)
})

test('password: obbligatoria, sbagliata, limite di tentativi che brucia il codice', async () => {
  const env = setup()
  await env.access.setPassword('hunter22')
  assert.equal(env.access.hasPassword(), true)
  const { token, pw } = (() => {
    const start = env.access.startPairing(route(env.mac))
    return { token: start.payload.token, pw: start.payload.pw }
  })()
  assert.equal(pw, true)
  const code = async (password?: string) => {
    const c = await connect({ env, authenticate: false })
    const r = await c.authenticate({ token, password })
    return r.ok ? 'ok' : r.code
  }
  assert.equal(await code(), 'password-required')
  assert.equal(await code('wrong-1'), 'wrong-password')
  assert.equal(await code('wrong-2'), 'wrong-password')
  assert.equal(await code('wrong-3'), 'wrong-password')
  // Il quinto errore brucia il codice.
  assert.equal(await code('wrong-4'), 'too-many-attempts')
  // Ora nemmeno la password giusta serve.
  assert.equal(await code('hunter22'), 'token-used')
  assert.equal(env.access.devices().length, 0)

  // Con codice nuovo e password giusta si entra.
  const t2 = env.access.startPairing(route(env.mac)).payload.token
  const c = await connect({ env, authenticate: false })
  assert.equal((await c.authenticate({ token: t2, password: 'hunter22' })).ok, true)
  // Tolta la password, il codice non la chiede più.
  await env.access.setPassword(null)
  assert.equal(env.access.startPairing(route(env.mac)).payload.pw, false)
})

test('password: lunghezza controllata e salvata solo come hash', async () => {
  const env = setup()
  await assert.rejects(() => env.access.setPassword('abc'), /between 4 and 128/)
  await env.access.setPassword('correct horse')
  const db = openDb(':memory:')
  void db
  const row = (env.access as unknown as { db: { prepare(sql: string): { get(key: string): { value: string } } } }).db.prepare('select value from kv where key = ?').get('remote.password')
  assert.ok(!row.value.includes('correct horse'))
})

test('dispositivo noto: auth con la sua chiave; sconosciuto e firma sbagliata respinti', async () => {
  const env = setup()
  const key = generateDeviceKey()
  const first = await connect({ env, authenticate: false })
  const paired = await first.authenticate({ key })
  assert.ok(paired.ok)
  const device = { key, id: paired.ok ? paired.deviceId : '' }
  const second = await connect({ env, device })
  assert.ok(second.auths[0].ok)
  assert.equal(env.gateway.clients, 2)

  const unknown = await connect({ env, authenticate: false })
  const r1 = await unknown.authenticate({ device: { key, id: 'nope' } })
  assert.equal(r1.ok === false && r1.code, 'unknown-device')

  const forged = await connect({ env, authenticate: false })
  const r2 = await forged.authenticate({ device: { key: generateDeviceKey(), id: device.id } })
  assert.equal(r2.ok === false && r2.code, 'bad-signature')
})

test('firma riusata su un’altra connessione: respinta (hash dell’handshake diverso)', async () => {
  const env = setup()
  const key = generateDeviceKey()
  const first = await connect({ env, authenticate: false })
  const paired = await first.authenticate({ key })
  assert.ok(paired.ok)
  const deviceId = paired.ok ? paired.deviceId : ''
  const a = await connect({ env, authenticate: false })
  const sigA = signChannelBinding(key.secretKey, 'auth', a.hash())
  const b = await connect({ env, authenticate: false })
  const result = new Promise<RemoteAuthResult>((resolve) => {
    const timer = setInterval(() => {
      if (b.auths.length) {
        clearInterval(timer)
        resolve(b.auths[0])
      }
    }, 2)
  })
  b.sendRaw({ type: 'auth', deviceId, sig: sigA })
  const r = await result
  assert.equal(r.ok === false && r.code, 'bad-signature')
  // Una firma di tipo `pair` non vale come `auth`, nemmeno sulla stessa connessione.
  const c = await connect({ env, authenticate: false })
  const wrongKind = new Promise<RemoteAuthResult>((resolve) => {
    const timer = setInterval(() => {
      if (c.auths.length) {
        clearInterval(timer)
        resolve(c.auths[0])
      }
    }, 2)
  })
  c.sendRaw({ type: 'auth', deviceId, sig: signChannelBinding(key.secretKey, 'pair', c.hash()) })
  assert.equal((await wrongKind).ok, false)
})

test('revoca: la connessione si chiude subito, il telefono è avvisato e non rientra', async () => {
  const env = setup()
  const key = generateDeviceKey()
  const first = await connect({ env, authenticate: false })
  const paired = await first.authenticate({ key })
  assert.ok(paired.ok)
  const device = { key, id: paired.ok ? paired.deviceId : '' }
  const live = await connect({ env, device })
  const other = await connect({ env })
  assert.equal(env.gateway.clients, 3)

  assert.equal(env.access.revoke(device.id), true)
  env.gateway.disconnectDevice(device.id)
  await live.flush()
  assert.equal(live.server.closed, true)
  assert.equal(first.server.closed, true)
  const notice = live.auths.at(-1)
  assert.ok(notice && !notice.ok && notice.code === 'device-revoked')
  // L'altro telefono non è toccato.
  assert.equal(other.server.closed, false)
  assert.equal(env.gateway.clients, 1)
  assert.equal(env.access.devices().length, 1)

  // Con lo stesso abbinamento non si ricollega.
  const retry = await connect({ env, authenticate: false })
  const r = await retry.authenticate({ device })
  assert.equal(r.ok === false && r.code, 'device-revoked')
  // Con la chiave stessa ma un QR nuovo si può abbinare di nuovo: è un altro abbinamento.
  const again = await connect({ env, authenticate: false })
  const r2 = await again.authenticate({ key })
  assert.ok(r2.ok && r2.deviceId !== device.id)
})

test('rigenerare la chiave: tutti i dispositivi revocati e le connessioni chiuse', async () => {
  const env = setup()
  const a = await connect({ env })
  const b = await connect({ env })
  env.access.cancelPairing()
  env.access.revokeAll()
  env.gateway.disconnectAll()
  await a.flush()
  assert.ok(a.server.closed && b.server.closed)
  assert.equal(env.access.devices().length, 0)
  assert.equal(env.gateway.size, 0)
})

test('canale spento: nessuna autenticazione', async () => {
  const env = setup()
  env.access.enabled = false
  const c = await connect({ env, authenticate: false })
  const r = await c.authenticate({ token: 'x' })
  assert.equal(r.ok === false && r.code, 'remote-disabled')
  assert.throws(() => env.access.startPairing(route(env.mac)), /turned off/)
})

test('allowFull spento: Full dal telefono rifiutato, gli altri livelli no', async () => {
  const entries: RemoteLogEntry[] = []
  const env = setup({ log: entries })
  env.access.allowFull = false
  const c = await connect({ env })
  assert.equal(c.auths[0].ok && c.auths[0].allowFull, false)
  const blocked = await c.call({ type: 'session.permission.set', sessionId: 's1', permission: 'full' })
  assert.ok(blocked.kind === 'result' && !blocked.ok)
  assert.match((blocked as { error: string }).error, /Full access cannot be turned on from the phone/)
  assert.equal(env.fake.calls.length, 0)
  const ok = await c.call({ type: 'session.permission.set', sessionId: 's1', permission: 'edit' })
  assert.ok(ok.kind === 'result' && ok.ok)
  assert.equal(env.fake.calls.length, 1)
  assert.deepEqual(entries.map((e) => e.detail), ['Permission → Full (blocked)', 'Permission → Edit'])
  // Riacceso, Full passa.
  env.access.allowFull = true
  const full = await c.call({ type: 'session.permission.set', sessionId: 's1', permission: 'full' })
  assert.ok(full.kind === 'result' && full.ok)
})

test('log delle azioni remote: respond, send, queue, interrupt, permission, senza testo dei messaggi', async () => {
  const entries: RemoteLogEntry[] = []
  const env = setup({ log: entries })
  env.fake.host.requestInfo = (_s, requestId) => (requestId === 'q' ? { title: 'Run command', options: [{ id: 'allow', kind: 'allow' }, { id: 'no', kind: 'deny' }] } : null)
  env.fake.host.handle = async (command, origin) => {
    env.fake.calls.push({ command, origin })
    return command.type === 'session.permission.set' ? { permission: 'edit', appliesFrom: 'now' } : null
  }
  const c = await connect({ env, name: 'Phone A' })
  await c.call({ type: 'session.respond', sessionId: 's1', requestId: 'q', response: { optionId: 'allow' } })
  await c.call({ type: 'session.respond', sessionId: 's1', requestId: 'q', response: { optionId: 'no', message: 'secret reason' } })
  await c.call({ type: 'session.send', sessionId: 's1', text: 'my secret prompt!' })
  await c.call({ type: 'session.queue.deliver', sessionId: 's1', id: 'm', how: 'now' })
  await c.call({ type: 'session.interrupt', sessionId: 's1' })
  // Il telefono chiede Full ma il tetto del progetto dà Edit: nel log il livello vero.
  await c.call({ type: 'session.permission.set', sessionId: 's1', permission: 'full' })
  // Comandi che non sono azioni non scrivono nel log.
  await c.call({ type: 'session.read', sessionId: 's1' })
  const page = env.access.list()
  assert.deepEqual(
    page.entries.map((e) => [e.action, e.detail]).reverse(),
    [
      ['respond', 'Approved: Run command'],
      ['respond', 'Denied: Run command'],
      ['send', 'Message (17 chars)'],
      ['queue', 'Queued message sent now'],
      ['interrupt', 'Stopped'],
      ['permission', 'Permission → Edit']
    ]
  )
  assert.ok(page.entries.every((e) => e.deviceName === 'Phone A' && e.sessionId === 's1'))
  assert.ok(!JSON.stringify(page).includes('secret'))
  assert.equal(entries.length, 6)
  // La risposta porta il nome del telefono (viaDevice).
  assert.equal((env.fake.calls[0].command as { viaDevice?: string }).viaDevice, 'Phone A')
  // Paginazione: dalla più recente, `before` esclusivo.
  const first = env.access.list(undefined, 2)
  assert.equal(first.entries.length, 2)
  assert.equal(first.hasMore, true)
  const next = env.access.list(first.entries[1].id, 10)
  assert.equal(next.entries.length, 4)
  assert.equal(next.hasMore, false)
})

test('log: si tengono al massimo 1000 voci e 30 giorni', () => {
  let now = 100 * 86_400_000
  const access = newAccess({ now: () => now })
  const device = { id: 'd', name: 'D' }
  access.record(device, 'send', null, 'old')
  now += 31 * 86_400_000
  for (let i = 0; i < LOG_MAX_ENTRIES + 60; i++) access.record(device, 'send', null, `m${i}`)
  const all = access.list(undefined, 200)
  assert.ok(!all.entries.some((e) => e.detail === 'old'))
  const count = (access as unknown as { db: { prepare(s: string): { get(): { n: number } } } }).db.prepare('select count(*) as n from remote_log').get().n
  assert.ok(count <= LOG_MAX_ENTRIES + 50, String(count))
})

test('device.push.set salva il token sul dispositivo e non passa dall’host', async () => {
  const env = setup()
  const c = await connect({ env })
  const id = env.access.devices()[0].id
  const r = await c.call({ type: 'device.push.set', token: 'ExponentPushToken[abc]', platform: 'android' })
  assert.ok(r.kind === 'result' && r.ok)
  assert.equal(env.access.device(id)?.pushToken, 'ExponentPushToken[abc]')
  assert.equal(env.access.device(id)?.platform, 'android')
  assert.equal(env.fake.calls.length, 0)
  await c.call({ type: 'device.push.set', token: null, platform: 'android' })
  assert.equal(env.access.device(id)?.pushToken, null)
  for (const bad of [{ token: 5, platform: 'ios' }, { token: '', platform: 'ios' }, { token: 'x', platform: 'web' }, { token: 'x'.repeat(513), platform: 'ios' }]) {
    const e = await c.call({ type: 'device.push.set', ...bad })
    assert.ok(e.kind === 'result' && !e.ok)
  }
  // Un token si toglie anche con la revoca.
  await c.call({ type: 'device.push.set', token: 'T', platform: 'ios' })
  env.access.revoke(id)
  assert.equal(env.access.device(id)?.pushToken, null)
})

test('device.notify.set e device.state (LAD-53): validazione, salvataggio, primo piano per connessione, lingua', async () => {
  const env = setup()
  const c = await connect({ env, locale: 'it' })
  const id = env.access.devices()[0].id
  // Lingua dell'hello salvata dopo l'autenticazione; predefinite le preferenze.
  assert.equal(env.access.device(id)?.locale, 'it')
  assert.deepEqual(env.access.device(id)?.notify, { events: { request: true, turn: true, error: true, agents: true }, quiet: null })
  const prefs = { events: { request: true, turn: false, error: true, agents: true }, quiet: { from: '22:00', to: '07:00', tz: 'Europe/Rome' }, quietAllowsRequests: true }
  const r = await c.call({ type: 'device.notify.set', prefs: { ...prefs, extra: 'x' } })
  assert.ok(r.kind === 'result' && r.ok)
  assert.deepEqual(env.access.device(id)?.notify, prefs)
  for (const bad of [{}, { events: { request: true } }, { ...prefs, quiet: { from: '25:00', to: '07:00', tz: 'UTC' } }, { ...prefs, quiet: { from: '22:00', to: '07:00', tz: 'Nope/Zone' } }]) {
    const e = await c.call({ type: 'device.notify.set', prefs: bad })
    assert.ok(e.kind === 'result' && !e.ok)
  }
  assert.deepEqual(env.access.device(id)?.notify, prefs)
  // Primo piano: per connessione e solo in memoria.
  assert.equal(env.gateway.foregroundDevices().size, 0)
  assert.ok((await c.call({ type: 'device.state', foreground: true })).kind === 'result')
  assert.deepEqual([...env.gateway.foregroundDevices()], [id])
  const bad = await c.call({ type: 'device.state', foreground: 'yes' })
  assert.ok(bad.kind === 'result' && !bad.ok)
  await c.call({ type: 'device.state', foreground: false })
  assert.equal(env.gateway.foregroundDevices().size, 0)
  await c.call({ type: 'device.state', foreground: true })
  c.client.link.close()
  await c.flush()
  assert.equal(env.gateway.foregroundDevices().size, 0)
  assert.equal(env.fake.calls.length, 0)
})

test('foreground (LAD-53): scade senza battito né traffico; l’ultimo stato del dispositivo vince; connessione caduta non conta', async () => {
  let clock = 1_000_000
  const env = setup({ now: () => clock })
  const a = await connect({ env })
  const id = env.access.devices()[0].id
  await a.call({ type: 'device.state', foreground: true })
  assert.deepEqual([...env.gateway.foregroundDevices()], [id])
  clock += 29_000
  assert.equal(env.gateway.foregroundDevices().size, 1)
  clock += 2_000
  // Né battito né comandi da 31 secondi: i push ripartono.
  assert.equal(env.gateway.foregroundDevices().size, 0)
  // Traffico di comandi sulla connessione: torna valido.
  await a.call({ type: 'session.read', sessionId: 's1' })
  assert.equal(env.gateway.foregroundDevices().size, 1)
  // L'ultimo stato del dispositivo vince.
  await a.call({ type: 'device.state', foreground: false })
  assert.equal(env.gateway.foregroundDevices().size, 0)
  await a.call({ type: 'device.state', foreground: true })
  a.client.link.close()
  await a.flush()
  assert.equal(env.gateway.foregroundDevices().size, 0)
})

test('setPushToken: lo stesso token su un altro dispositivo non revocato viene tolto', () => {
  const access = newAccess()
  const db = (access as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
  for (const id of ['x', 'y']) db.prepare('insert into devices (id, name, platform, public_key, created_at) values (?, ?, ?, ?, ?)').run(id, id, 'ios', `k${id}`, 1)
  let changes = 0
  ;(access as unknown as { options: { onChange?: () => void } }).options.onChange = () => changes++
  access.setPushToken('x', 'ExponentPushToken[t]', 'ios')
  access.setPushToken('y', 'ExponentPushToken[t]', 'ios')
  assert.equal(access.device('x')?.pushToken, null)
  assert.equal(access.device('y')?.pushToken, 'ExponentPushToken[t]')
  access.clearPushToken('ExponentPushToken[t]')
  assert.equal(access.device('y')?.pushToken, null)
  assert.equal(changes, 1)
  access.clearPushToken('ExponentPushToken[t]')
  assert.equal(changes, 1)
})

test('istantanea: tetti di permesso, preferenze e sessioni archiviate (project.sessions.archived)', async () => {
  const env = setup()
  env.fake.host.remoteExtras = async () => ({ permissionsMax: { p1: 'edit', p2: null }, busySend: 'queue' })
  const archived: unknown[] = []
  env.fake.host.archivedSessions = (projectId, before, limit) => {
    archived.push([projectId, before, limit])
    return [{ id: 'old' } as never]
  }
  env.access.allowFull = false
  const c = await connect({ env })
  const hello = await c.call({ type: 'hello' })
  const data = (hello as { data: { permissionsMax: unknown; prefs: unknown } }).data
  assert.deepEqual(data.permissionsMax, { p1: 'edit', p2: null })
  assert.deepEqual(data.prefs, { busySend: 'queue', allowFull: false })
  const r = await c.call({ type: 'project.sessions.archived', projectId: 'p1', before: 5, limit: 10 })
  assert.deepEqual(r, { kind: 'result', rid: 'r2', ok: true, data: [{ id: 'old' }] })
  assert.deepEqual(archived, [['p1', 5, 10]])
  const bad = await c.call({ type: 'project.sessions.archived', projectId: 5 })
  assert.ok(bad.kind === 'result' && !bad.ok)
  assert.equal(env.fake.calls.length, 0)
})

test('lo stato cambia: onDevices a ogni collegamento e scollegamento', async () => {
  let changes = 0
  const mac = generateKeyPair()
  const access = newAccess()
  const gateway = new RemoteGateway({ host: fakeHost().host, identity: mac, access, macName: 'Test Mac', appVersion: '9.9.9', onDevices: () => changes++ })
  const env = { mac, fake: fakeHost(), access, gateway } as Env
  const c = await connect({ env })
  assert.equal(changes, 1)
  c.client.link.close()
  await c.flush()
  assert.equal(changes, 2)
})

// ── Limiti: l'`auth` valido non si blocca mai ────────────────────────────────

test('auth: un telefono valido entra anche dopo mille errori di altri; revocato o sconosciuto che insiste non blocca nessuno', async () => {
  const env = setup()
  const key = generateDeviceKey()
  const first = await connect({ env, authenticate: false })
  const paired = await first.authenticate({ key })
  assert.ok(paired.ok)
  const device = { key, id: paired.ok ? paired.deviceId : '' }
  for (let i = 0; i < FAILURE_LIMIT + 10; i++) {
    const bad = await connect({ env, authenticate: false })
    await bad.authenticate({ device: { key: generateDeviceKey(), id: i % 2 ? device.id : 'unknown' } })
  }
  const good = await connect({ env, device })
  assert.ok(good.auths[0].ok)
  // I tentativi di `pair` sbagliati invece sì: dopo il limite si rifiuta senza guardare.
  for (let i = 0; i < FAILURE_LIMIT; i++) {
    const bad = await connect({ env, authenticate: false })
    await bad.authenticate({ token: 'nope' })
  }
  const blocked = await connect({ env, authenticate: false })
  const r = await blocked.authenticate({ token: env.access.startPairing(route(env.mac)).payload.token })
  assert.equal(r.ok === false && r.code, 'too-many-attempts')
  // E l'auth di un dispositivo valido passa comunque.
  const again = await connect({ env, device })
  assert.ok(again.auths[0].ok)
})

test('rinomina: le connessioni aperte usano il nome nuovo nel log', async () => {
  const entries: RemoteLogEntry[] = []
  const env = setup({ log: entries })
  const c = await connect({ env, name: 'Old' })
  const id = env.access.devices()[0].id
  env.gateway.deviceRenamed(id, env.access.rename(id, ' New name '))
  await c.call({ type: 'session.interrupt', sessionId: 's1' })
  assert.equal(entries[0].deviceName, 'New name')
})

test('allowFull cambia: i telefoni collegati ricevono remote.prefs', async () => {
  const env = setup()
  env.fake.host.remoteExtras = async () => ({ permissionsMax: {}, busySend: 'queue' })
  const c = await connect({ env })
  env.access.allowFull = false
  await env.gateway.pushPrefs()
  await c.flush()
  assert.deepEqual(c.events.find((e) => e.kind === 'event' && e.event.type === 'remote.prefs'), { kind: 'event', event: { type: 'remote.prefs', prefs: { busySend: 'queue', allowFull: false } } })
})

// ── LAD-89 / LAD-90 ──────────────────────────────────────────────────────────

const createBase = { type: 'session.create', projectId: 'p1', agent: 'claude-code', text: 'do the thing', model: null, effort: null, permission: 'edit' }

/** Host con i controlli di creazione veri (simulati): progetto p1, agenti claude-code (modello m1 con effort low/high) e codex non ammesso. */
function createHost(extra: Partial<RemoteHostApi> = {}) {
  const env = fakeHost()
  env.host.checkCreate = async (command) => {
    if (command.projectId !== 'p1') throw new Error('Project not found.')
    if (command.agent !== 'claude-code') throw new Error('not allowed in this project')
    if (command.model !== null && command.model !== 'm1') throw new Error('Unknown model')
    if (command.effort !== null && !['low', 'high'].includes(command.effort)) throw new Error('effort')
    return { agent: 'Claude Code', project: 'P' }
  }
  env.host.handle = async (command, origin) => {
    env.calls.push({ command, origin })
    return command.type === 'session.create' ? { id: 'new1', projectId: command.projectId } : { ok: command.type }
  }
  Object.assign(env.host, extra)
  return env
}

test('session.create: forma e campi in più (allegati, terminale, worktree, command) respinti prima dell’host', async () => {
  const env = setup({ host: createHost().host })
  const c = await connect({ env })
  const bad: Record<string, unknown>[] = [
    { ...createBase, text: '' },
    { ...createBase, text: '   ' },
    { ...createBase, text: 'x'.repeat(200_001) },
    { ...createBase, projectId: '' },
    { ...createBase, permission: 'root' },
    { ...createBase, effort: 'turbo' },
    { ...createBase, mode: 'terminal' },
    { ...createBase, command: 'rm -rf /' },
    { ...createBase, worktree: true },
    { ...createBase, branch: { name: 'x', existing: false } },
    { ...createBase, attachments: [{ id: 'a' }] },
    { ...createBase, attachments: 'x' },
    { ...createBase, profileId: 5 }
  ]
  for (const command of bad) {
    const r = await c.call(command)
    assert.ok(r.kind === 'result' && !r.ok, JSON.stringify(command).slice(0, 80))
    assert.match((r as { error: string }).error, /Invalid request/)
  }
  assert.equal(env.fake.calls.length, 0)
})

test('session.create: ok, comando ricostruito (chat, nessun campo extra), risposta e log senza testo', async () => {
  const entries: RemoteLogEntry[] = []
  const fake = createHost()
  const env = setup({ host: fake.host, log: entries })
  const c = await connect({ env })
  const r = await c.call({ ...createBase, text: 'my secret prompt', model: 'm1', effort: 'high', mode: 'chat', profileId: 'prof1' })
  assert.ok(r.kind === 'result' && r.ok)
  assert.deepEqual((r as { data: unknown }).data, { id: 'new1', projectId: 'p1' })
  assert.deepEqual(fake.calls[0].command, { type: 'session.create', projectId: 'p1', agent: 'claude-code', text: 'my secret prompt', model: 'm1', effort: 'high', permission: 'edit', profileId: 'prof1', mode: 'chat' })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].action, 'create')
  assert.equal(entries[0].sessionId, 'new1')
  assert.equal(entries[0].detail, 'New session: Claude Code in P')
  assert.ok(!JSON.stringify(entries).includes('secret'))
  // model/effort assenti = null.
  const d = await c.call({ type: 'session.create', projectId: 'p1', agent: 'claude-code', text: 'hi', permission: 'plan' })
  assert.ok(d.kind === 'result' && d.ok)
  assert.deepEqual(fake.calls[1].command, { type: 'session.create', projectId: 'p1', agent: 'claude-code', text: 'hi', model: null, effort: null, permission: 'plan', mode: 'chat' })
})

test('session.create: progetto, agente, modello, effort non validi (controlli dell’host) = errore e nessuna sessione', async () => {
  const fake = createHost()
  let clock = 5_000_000
  const c = await connect({ env: setup({ host: fake.host, now: () => clock }) })
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...createBase, projectId: 'nope' }, /Project not found/],
    [{ ...createBase, agent: 'codex' }, /not allowed/],
    [{ ...createBase, model: 'zzz' }, /Unknown model/],
    [{ ...createBase, effort: 'max' }, /effort/]
  ]
  for (const [command, re] of cases) {
    clock += 60_000 // fuori dal limite delle nuove sessioni
    const r = await c.call(command)
    assert.ok(r.kind === 'result' && !r.ok)
    assert.match((r as { error: string }).error, re)
  }
  assert.equal(fake.calls.length, 0)
})

test('session.create: Full con allowFull spento = rifiutato (nessuna riduzione silenziosa), con voce di log; edit passa', async () => {
  const entries: RemoteLogEntry[] = []
  const fake = createHost()
  const env = setup({ host: fake.host, log: entries })
  env.access.allowFull = false
  const c = await connect({ env })
  const blocked = await c.call({ ...createBase, permission: 'full' })
  assert.ok(blocked.kind === 'result' && !blocked.ok)
  assert.match((blocked as { error: string }).error, /Full access cannot be turned on from the phone/)
  assert.equal(fake.calls.length, 0)
  assert.deepEqual(entries.map((e) => e.detail), ['New session: Claude Code in P (blocked)'])
  const ok = await c.call({ ...createBase, permission: 'edit' })
  assert.ok(ok.kind === 'result' && ok.ok)
  env.access.allowFull = true
  const full = await c.call({ ...createBase, permission: 'full' })
  assert.ok(full.kind === 'result' && full.ok)
  // Il tetto del progetto lo applica l'host (createSession): il gateway passa il livello chiesto.
  assert.equal((fake.calls[1].command as { permission: string }).permission, 'full')
})

test('agents.usage: ammesso, senza email né percorso, al massimo una lettura al minuto per agente+profilo e connessione', async () => {
  let reads = 0
  let clock = 1_000_000
  const fake = createHost()
  fake.host.handle = async (command, origin) => {
    fake.calls.push({ command, origin })
    reads++
    return { agent: 'claude-code', name: 'Claude Code', kind: 'native', available: true, version: '1', account: 'Claude Max', email: 'me@example.com', path: '/usr/bin/claude', models: [], error: null, usage: [{ key: 'w', minutes: 300, model: null, percent: 10, resetsAt: null, state: 'ok' }], usageAt: reads }
  }
  const env = setup({ host: fake.host, now: () => clock })
  const c = await connect({ env })
  assert.ok(isRemoteCommandType('agents.usage'))
  const first = await c.call({ type: 'agents.usage', agent: 'claude-code' })
  assert.ok(first.kind === 'result' && first.ok)
  const data = (first as { data: Record<string, unknown> }).data
  assert.equal(data.account, 'Claude Max')
  assert.ok(!('email' in data) && !('path' in data))
  assert.ok(!JSON.stringify(first).includes('example.com'))
  // Entro 60 secondi: valore in cache, il provider non si tocca.
  clock += 30_000
  const second = await c.call({ type: 'agents.usage', agent: 'claude-code' })
  assert.deepEqual((second as { data: unknown }).data, data)
  assert.equal(reads, 1)
  // Altro profilo = altra chiave; un'altra connessione ha il suo limite.
  await c.call({ type: 'agents.usage', agent: 'claude-code', profileId: 'p2' })
  assert.equal(reads, 2)
  const other = await connect({ env })
  await other.call({ type: 'agents.usage', agent: 'claude-code' })
  assert.equal(reads, 3)
  // Passati i 60 secondi: lettura vera.
  clock += 31_000
  const third = await c.call({ type: 'agents.usage', agent: 'claude-code' })
  assert.equal((third as { data: { usageAt: number } }).data.usageAt, 4)
  assert.equal(reads, 4)
  // Forma non valida.
  const bad = await c.call({ type: 'agents.usage', agent: '' })
  assert.ok(bad.kind === 'result' && !bad.ok)
})

test('agent.status inoltrato senza email e percorso; hello senza email, profili senza cartella', async () => {
  const c = await connect()
  c.gateway.broadcast({ type: 'agent.status', status: { agent: 'codex', name: 'Codex', kind: 'native', available: true, version: null, account: 'ChatGPT Plus', email: 'a@b.c', path: '/x/codex', models: [], error: null } })
  await c.flush()
  const ev = c.events.find((e) => e.kind === 'event' && e.event.type === 'agent.status') as unknown as { event: { status: Record<string, unknown> } }
  assert.equal(ev.event.status.account, 'ChatGPT Plus')
  assert.ok(!('email' in ev.event.status) && !('path' in ev.event.status))
  const withProfiles = { ...snapshotEvent, agents: [{ agent: 'codex', name: 'Codex', kind: 'native', available: true, version: null, account: 'Plus', email: 'a@b.c', path: '/x', models: [], error: null }], profiles: [{ id: 'pr', agent: 'codex', name: 'Work', configDir: '/secret/dir', isDefault: false, addedAt: 1 }] } as unknown as typeof snapshotEvent
  const snap = toRemoteSnapshot(withProfiles, { permissionsMax: {}, prefs: { busySend: 'steer', allowFull: true } })
  assert.deepEqual(snap.profiles, [{ id: 'pr', agent: 'codex', name: 'Work', isDefault: false }])
  assert.ok(!JSON.stringify(snap).includes('a@b.c') && !JSON.stringify(snap).includes('/secret'))
})

test('predefiniti: nello snapshot, full ridotto a edit con allowFull spento, evento remote.defaults solo se cambiano', async () => {
  const fake = createHost()
  let max: 'plan' | null = null
  fake.host.remoteExtras = async () => ({ permissionsMax: { p1: max }, busySend: 'steer', defaults: { p1: { allowed: [], agent: 'claude-code', lastAgent: null, launch: {}, permission: 'full' } } })
  const env = setup({ host: fake.host })
  env.access.allowFull = false
  const c = await connect({ env })
  const hello = (await c.call({ type: 'hello' })) as { data: { defaults: Record<string, { permission: string }> } }
  assert.equal(hello.data.defaults.p1.permission, 'edit')
  env.access.allowFull = true
  env.gateway.pushDefaults(true)
  await c.flush()
  const sent = () => c.events.filter((e) => e.kind === 'event' && e.event.type === 'remote.defaults')
  assert.equal(sent().length, 1)
  assert.equal((sent()[0] as { event: { defaults: Record<string, { permission: string }> } }).event.defaults.p1.permission, 'full')
  env.gateway.pushDefaults(true)
  await c.flush()
  assert.equal(sent().length, 1)
  max = 'plan'
  env.gateway.pushDefaults(true)
  await c.flush()
  assert.equal(sent().length, 2)
})

test('session.create: attachments [] = nessuno', async () => {
  const fake = createHost()
  const c = await connect({ env: setup({ host: fake.host }) })
  const r = await c.call({ ...createBase, attachments: [] })
  assert.ok(r.kind === 'result' && r.ok)
  assert.ok(!('attachments' in (fake.calls[0].command as object)))
})

test('session.create: limite per dispositivo (raffica 3, poi 5 al minuto), rifiuto nel log', async () => {
  const entries: RemoteLogEntry[] = []
  let clock = 9_000_000
  const fake = createHost()
  const env = setup({ host: fake.host, log: entries, now: () => clock })
  const c = await connect({ env })
  for (let i = 0; i < 3; i++) assert.ok((await c.call(createBase)).kind === 'result')
  assert.equal(fake.calls.length, 3)
  const refused = await c.call(createBase)
  assert.ok(refused.kind === 'result' && !refused.ok)
  assert.match((refused as { error: string }).error, /Too many new sessions/)
  assert.equal(fake.calls.length, 3)
  assert.equal(entries.at(-1)?.detail, 'New session refused: too many requests')
  // Dopo 12 secondi (5 al minuto) un gettone è tornato.
  clock += 12_000
  await c.call(createBase)
  assert.equal(fake.calls.length as number, 4)
  // Il limite è del dispositivo, non della connessione.
  const again = await c.call(createBase)
  assert.ok(again.kind === 'result' && !again.ok)
})

test('agents.usage: account predefinito = una sola chiave, account sconosciuto e agente sconosciuto respinti, limite per dispositivo', async () => {
  let reads = 0
  const fake = createHost()
  fake.host.usageTarget = (agent, profileId) => {
    if (agent !== 'claude-code') throw new Error('Unknown agent')
    if (profileId && !profileId.startsWith('default:') && profileId !== 'real') throw new Error('Account not found.')
    return { agent, ...(profileId && profileId !== 'default:claude-code' && !profileId.startsWith('default:') ? { profileId } : {}) }
  }
  fake.host.handle = async (command, origin) => {
    fake.calls.push({ command, origin })
    reads++
    return { agent: 'claude-code', name: 'C', kind: 'native', available: true, version: null, account: 'Max', models: [], error: 'ENOENT /Users/me/.claude/secret/x failed', usageAt: reads }
  }
  const env = setup({ host: fake.host, now: () => 1_000_000 })
  const c = await connect({ env })
  const first = await c.call({ type: 'agents.usage', agent: 'claude-code' })
  assert.ok(!JSON.stringify(first).includes('/Users/me'))
  await c.call({ type: 'agents.usage', agent: 'claude-code', profileId: 'default:claude-code' })
  await c.call({ type: 'agents.usage', agent: 'claude-code', profileId: 'default:whatever' })
  assert.equal(reads, 1)
  for (const bad of [{ agent: 'nope' }, { agent: 'claude-code', profileId: 'ghost' }]) {
    const r = await c.call({ type: 'agents.usage', ...bad })
    assert.ok(r.kind === 'result' && !r.ok)
  }
  assert.equal(reads, 1)
})

test('predefiniti: invii sovrapposti (vince il più recente), reset senza telefoni, usage-only non ricalcola', async () => {
  const fake = createHost()
  let calls = 0
  const resolvers: ((v: Awaited<ReturnType<NonNullable<RemoteHostApi['remoteExtras']>>>) => void)[] = []
  fake.host.remoteExtras = () => {
    calls++
    return new Promise((resolve) => resolvers.push(resolve))
  }
  const env = setup({ host: fake.host })
  const c = await connect({ env })
  const ext = (permission: 'plan' | 'edit') => ({ permissionsMax: {}, busySend: 'steer' as const, defaults: { p1: { allowed: [], agent: 'claude-code' as const, lastAgent: null, launch: {}, permission } } })
  env.gateway.pushDefaults(true)
  env.gateway.pushDefaults(true)
  resolvers[1](ext('edit'))
  resolvers[0](ext('plan')) // arriva dopo ma è più vecchio: scartato
  await c.flush()
  const sent = c.events.filter((e) => e.kind === 'event' && e.event.type === 'remote.defaults') as unknown as { event: { defaults: Record<string, { permission: string }> } }[]
  assert.equal(sent.length, 1)
  assert.equal(sent[0].event.defaults.p1.permission, 'edit')
  // Solo limiti d'uso cambiati: nessun nuovo calcolo. Cambia un modello: sì.
  const status = (usageAt: number, models: { id: string; label: string }[]) => ({ type: 'agent.status' as const, status: { agent: 'codex' as const, name: 'Codex', kind: 'native' as const, available: true, version: null, account: null, models, error: null, usageAt } })
  env.gateway.broadcast(status(1, [{ id: 'a', label: 'A' }]))
  await new Promise((r) => setTimeout(r, 400))
  const before = calls
  env.gateway.broadcast(status(2, [{ id: 'a', label: 'A' }]))
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(calls, before)
  env.gateway.broadcast(status(3, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]))
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(calls, before + 1)
})

test('account: profile.upsert e profile.removed arrivano ai telefoni senza la cartella di configurazione', async () => {
  const c = await connect()
  c.gateway.broadcast({ type: 'profile.upsert', profile: { id: 'pr', agent: 'codex', name: 'Work', configDir: '/secret/x', isDefault: false, addedAt: 1 } })
  c.gateway.broadcast({ type: 'profile.removed', profileId: 'pr' })
  await c.flush()
  const evs = c.events.filter((e) => e.kind === 'event').map((e) => (e as { event: unknown }).event)
  assert.deepEqual(evs.slice(0, 2), [{ type: 'profile.upsert', profile: { id: 'pr', agent: 'codex', name: 'Work', isDefault: false } }, { type: 'profile.removed', profileId: 'pr' }])
})
