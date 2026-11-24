// Prove del gateway remoto in-process: Host finto, collegamenti in memoria, handshake Noise vero.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatItem, FromRemoteHost, HostEvent, ToRemoteHost } from '../../shared/protocol.ts'
import { generateKeyPair } from '../../shared/remote/noise.ts'
import { clientHandshake, type RemoteSession } from '../../shared/remote/session.ts'
import { isRemoteCommandType, parseRemoteMessage } from './allowlist.ts'
import { MAX_CONNECTIONS, MAX_WATCHED, RATE_BURST, RemoteGateway, toRemoteSnapshot, type RemoteHostApi, type RemoteLink } from './gateway.ts'
import { IDENTITY_FILE, loadOrCreateIdentity, toBase64Url } from './identity.ts'

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

async function connect(options: { host?: RemoteHostApi; helloV?: number; idleTimeoutMs?: number } = {}) {
  const mac = generateKeyPair()
  const fake = fakeHost()
  const gateway = new RemoteGateway({ host: options.host ?? fake.host, identity: mac, macName: 'Test Mac', appVersion: '9.9.9', idleTimeoutMs: options.idleTimeoutMs })
  const { client, server } = linkPair()
  gateway.accept(server.link)
  const hs = clientHandshake({ macPublicKey: mac.publicKey, hello: { device: 'Phone', ...(options.helloV ? { v: options.helloV } : {}) } as { device: string } })
  const events: FromRemoteHost[] = []
  const waiters = new Map<string, (m: FromRemoteHost) => void>()
  let session: RemoteSession | null = null
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
      else events.push(message)
    })
  })
  client.link.send(hs.start())
  await opened
  let n = 0
  const call = (command: unknown, extra: Record<string, unknown> = {}) =>
    new Promise<FromRemoteHost>((resolve) => {
      const rid = `r${++n}`
      waiters.set(rid, resolve)
      for (const m of session!.seal({ rid, command, ...extra })) client.link.send(m)
    })
  const flush = () => new Promise((r) => setTimeout(r, 10))
  return { mac, gateway, fake, client, server, events, call, flush, session: () => session! }
}

test('hello: snapshot ridotto (niente bozze, terminali, scorciatoie, profili; della UI solo gruppi e seenAt)', async () => {
  const c = await connect()
  const result = await c.call({ type: 'hello' })
  assert.equal(result.kind, 'result')
  const data = (result as { data: Record<string, unknown> }).data
  assert.deepEqual(Object.keys(data).sort(), ['agents', 'projects', 'sessions', 'type', 'ui'])
  assert.deepEqual(data.ui, { p1: { groups: [{ id: 'g', name: 'G' }], groupOf: { s1: 'g' }, seenAt: 5 } })
  // Lo snapshot viaggia una volta sola, come risultato: nessun evento duplicato.
  await c.flush()
  assert.equal(c.events.filter((e) => e.kind === 'event' && e.event.type === 'snapshot').length, 0)
  assert.deepEqual(toRemoteSnapshot(snapshotEvent), data)
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
  const gateway = new RemoteGateway({ host: fakeHost().host, identity: generateKeyPair(), macName: 'm', appVersion: '1' })
  const pairs = Array.from({ length: MAX_CONNECTIONS + 1 }, () => linkPair())
  for (const p of pairs) gateway.accept(p.server.link)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(gateway.size, MAX_CONNECTIONS)
  assert.equal(pairs[MAX_CONNECTIONS].server.closed, true)
  gateway.close()
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
  const gateway = new RemoteGateway({ host: fakeHost().host, identity: mac, macName: 'm', appVersion: '1' })
  const { client, server } = linkPair()
  gateway.accept(server.link)
  const hs = clientHandshake({ macPublicKey: mac.publicKey, hello: { device: 'p', v: 99 } as { device: string } })
  client.link.send(hs.start())
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(gateway.size, 0)
  assert.equal(server.closed, true)
})

test('handshake con la chiave sbagliata o spazzatura: connessione chiusa', async () => {
  const gateway = new RemoteGateway({ host: fakeHost().host, identity: generateKeyPair(), macName: 'm', appVersion: '1' })
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
