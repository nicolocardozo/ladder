// Prove del client del relay in-process: un relay finto (ws, stesso formato dei messaggi) e il gateway vero.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import type { FromRemoteHost, HostEvent, ToRemoteHost } from '../../shared/protocol.ts'
import { generateKeyPair } from '../../shared/remote/noise.ts'
import {
  decodeFrame,
  encodeFrame,
  RELAY_CLOSE,
  RELAY_FRAME_CLOSE,
  RELAY_FRAME_DATA,
  RELAY_FRAME_OPEN,
  relayEndpoint,
  relayIdFromPublicKey,
  relayOrigin,
  verifyAuth
} from '../../shared/remote/relay-protocol.ts'
import { RelayTransport } from '../../shared/remote/relay-transport.ts'
import { clientHandshake } from '../../shared/remote/session.ts'
import { RemoteGateway, type RemoteHostApi, type RemoteLink } from './gateway.ts'
import { loadOrCreateRelayKey, RELAY_KEY_FILE } from './identity.ts'
import { RelayClient } from './relay-client.ts'

const dirs: string[] = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** Relay finto: sfida il Mac, verifica la firma, e dà al test i socket autenticati e i frame ricevuti. */
async function fakeRelay(port = 0) {
  const server = new WebSocketServer({ host: '127.0.0.1', port })
  await new Promise<void>((resolve) => server.on('listening', () => resolve()))
  const state = {
    macs: [] as WsSocket[],
    frames: [] as { type: number; connId: number; payload: Uint8Array }[],
    texts: [] as string[],
    ids: [] as string[],
    onMac: null as ((ws: WsSocket) => void) | null,
    reject: false
  }
  server.on('connection', (ws, request) => {
    state.ids.push(request.url ?? '')
    const nonce = 'nonce-' + Math.random().toString(36).slice(2)
    ws.send(JSON.stringify({ t: 'challenge', nonce }))
    let authed = false
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString()
        if (text === 'ping') return ws.send('pong')
        state.texts.push(text)
        const message = JSON.parse(text) as { t: string; key: string; sig: string }
        const id = (request.url ?? '').split('/')[2].split('?')[0]
        if (message.t === 'auth') {
          if (state.reject || !verifyAuth(relayOrigin(`ws://${request.headers.host}`), id, nonce, message)) return ws.close(RELAY_CLOSE.authFailed)
          authed = true
          state.macs.push(ws)
          ws.send(JSON.stringify({ t: 'ready', maxPhones: 8 }))
          state.onMac?.(ws)
        }
        return
      }
      if (!authed) return
      const buf = data as Buffer
      const frame = decodeFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.length))!
      state.frames.push({ ...frame, payload: frame.payload.slice() })
    })
  })
  const until = async <T>(check: () => T | undefined | false, ms = 5000): Promise<T> => {
    const end = Date.now() + ms
    for (;;) {
      const v = check()
      if (v) return v
      if (Date.now() > end) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const address = server.address() as { port: number }
  return {
    ...state,
    state,
    url: `ws://127.0.0.1:${address.port}`,
    port: address.port,
    until,
    close: () => {
      for (const c of server.clients) c.terminate()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

function fakeLink() {
  const received: Uint8Array[] = []
  let closedCount = 0
  const accepted: RemoteLink[] = []
  return {
    received,
    accepted,
    get closedCount() {
      return closedCount
    },
    gateway: {
      accept(link: RemoteLink) {
        accepted.push(link)
        link.onBytes((b) => {
          received.push(b)
          link.send(Uint8Array.from([...b].reverse()))
        })
        link.onClose(() => closedCount++)
      }
    }
  }
}

const key = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ladder-relaykey-'))
  dirs.push(dir)
  return { dir, key: loadOrCreateRelayKey(dir) }
}

test('la chiave del relay si crea una volta, 0600, e cambia l\'id se si cambia la chiave', () => {
  const { dir, key: k } = key()
  assert.equal(statSync(join(dir, RELAY_KEY_FILE)).mode & 0o777, 0o600)
  assert.deepEqual(loadOrCreateRelayKey(dir), k)
  assert.equal(relayIdFromPublicKey(k.publicKey).length, 32)
  assert.notEqual(relayIdFromPublicKey(key().key.publicKey), relayIdFromPublicKey(k.publicKey))
})

test('indirizzi: ws:// solo verso questo computer', () => {
  assert.equal(relayEndpoint('wss://relay.example.com', 'abc', 'mac'), 'wss://relay.example.com/v1/abc?role=mac')
  assert.equal(relayEndpoint('https://relay.example.com/base/', 'abc', 'phone'), 'wss://relay.example.com/base/v1/abc?role=phone')
  assert.equal(relayEndpoint('ws://localhost:8787', 'abc', 'mac'), 'ws://localhost:8787/v1/abc?role=mac')
  assert.throws(() => relayEndpoint('ws://relay.example.com', 'abc', 'mac'))
  assert.throws(() => relayEndpoint('ftp://x', 'abc', 'mac'))
})

test('si autentica, apre un link per telefono e inoltra i byte nei due versi', async () => {
  const relay = await fakeRelay()
  const { key: k } = key()
  const fake = fakeLink()
  const client = new RelayClient({ gateway: fake.gateway, relayUrl: relay.url, key: k })
  client.start()
  const mac = await relay.until(() => relay.macs[0])
  assert.ok(relay.ids[0].startsWith(`/v1/${client.id}?role=mac`))
  await relay.until(() => client.status === 'connected')

  mac.send(encodeFrame(RELAY_FRAME_OPEN, 7))
  mac.send(encodeFrame(RELAY_FRAME_OPEN, 8))
  await relay.until(() => fake.accepted.length === 2)
  mac.send(encodeFrame(RELAY_FRAME_DATA, 7, Uint8Array.from([1, 2, 3])))
  await relay.until(() => relay.frames.find((f) => f.type === RELAY_FRAME_DATA))
  const echoed = relay.frames.find((f) => f.type === RELAY_FRAME_DATA)!
  assert.equal(echoed.connId, 7)
  assert.deepEqual([...echoed.payload], [3, 2, 1])

  // Il relay chiude un telefono: il gateway lo sa. Il gateway ne chiude un altro: il relay riceve CLOSE.
  mac.send(encodeFrame(RELAY_FRAME_CLOSE, 7))
  await relay.until(() => fake.closedCount === 1)
  fake.accepted[1].close()
  await relay.until(() => relay.frames.find((f) => f.type === RELAY_FRAME_CLOSE && f.connId === 8))
  await client.stop()
  assert.equal(client.status, 'stopped')
  await relay.close()
})

test('un relay che rifiuta l\'autenticazione: il client riprova con il backoff', async () => {
  const relay = await fakeRelay()
  relay.state.reject = true
  const { key: k } = key()
  const client = new RelayClient({ gateway: fakeLink().gateway, relayUrl: relay.url, key: k, minBackoffMs: 20, maxBackoffMs: 40 })
  client.start()
  await relay.until(() => relay.ids.length >= 3)
  assert.notEqual(client.status, 'connected')
  relay.state.reject = false
  await relay.until(() => client.status === 'connected')
  await client.stop()
  await relay.close()
})

test('si riconnette da solo quando il relay cade e quando cade la rete (silenzio)', async () => {
  const relay = await fakeRelay()
  const { key: k } = key()
  const fake = fakeLink()
  const logs: string[] = []
  const client = new RelayClient({ gateway: fake.gateway, relayUrl: relay.url, key: k, minBackoffMs: 20, maxBackoffMs: 100, log: (m) => logs.push(m) })
  client.start()
  await relay.until(() => relay.macs.length === 1)
  relay.macs[0].send(encodeFrame(RELAY_FRAME_OPEN, 1))
  await relay.until(() => fake.accepted.length === 1)

  // Il relay riparte (stessa porta): il link cade, il client si ripresenta.
  const port = relay.port
  await relay.close()
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(fake.closedCount, 1)
  assert.notEqual(client.status, 'connected')
  const again = await fakeRelay(port)
  await again.until(() => again.macs.length === 1)
  await again.until(() => client.status === 'connected')

  await client.stop()
  await again.close()
})

test('silenzio dal relay (nessun pong): il client lo dà per morto e rifà la connessione', async () => {
  const relay = await fakeRelay()
  const logs: string[] = []
  // Dopo l'autenticazione il relay non risponde più a niente, come quando la rete sparisce senza chiudere il socket.
  relay.state.onMac = (ws) => ws.removeAllListeners('message')
  const client = new RelayClient({ gateway: fakeLink().gateway, relayUrl: relay.url, key: key().key, minBackoffMs: 20, maxBackoffMs: 50, pingMs: 30, deadMs: 120, log: (m) => logs.push(m) })
  client.start()
  await relay.until(() => relay.ids.length >= 2)
  assert.ok(logs.some((l) => l.includes('relay silent')))
  await client.stop()
  await relay.close()
})

test('setMacState: asleep avvisa il relay e sospende la riconnessione, awake la riprende', async () => {
  const relay = await fakeRelay()
  const { key: k } = key()
  const client = new RelayClient({ gateway: fakeLink().gateway, relayUrl: relay.url, key: k, minBackoffMs: 20, maxBackoffMs: 50 })
  client.start()
  await relay.until(() => client.status === 'connected')
  await client.setMacState('asleep')
  assert.ok(relay.texts.some((t) => t.includes('"state":"asleep"')))
  assert.equal(client.status, 'paused')
  const count = relay.ids.length
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(relay.ids.length, count, 'in pausa non si riconnette')
  await client.setMacState('awake')
  await relay.until(() => client.status === 'connected')
  assert.equal(relay.ids.length, count + 1)
  await client.setMacState('quit')
  assert.ok(relay.texts.some((t) => t.includes('"state":"quit"')))
  await client.stop()
  await relay.close()
})

test('parte in pausa se richiesto (Mac che dorme) e si connette solo con awake', async () => {
  const relay = await fakeRelay()
  const client = new RelayClient({ gateway: fakeLink().gateway, relayUrl: relay.url, key: key().key, paused: true })
  client.start()
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(client.status, 'paused')
  assert.equal(relay.ids.length, 0)
  await client.setMacState('awake')
  await relay.until(() => client.status === 'connected')
  await client.stop()
  await relay.close()
})

test('backoff: ritardi esponenziali con tetto e jitter', async () => {
  // Nessun server in ascolto: ogni tentativo fallisce. Si misura la distanza tra i tentativi con random fisso a 1 (niente riduzione).
  const { key: k } = key()
  const times: number[] = []
  const client = new RelayClient({ gateway: fakeLink().gateway, relayUrl: 'ws://127.0.0.1:9', key: k, minBackoffMs: 30, maxBackoffMs: 120, random: () => 1, log: () => times.push(Date.now()) })
  client.start()
  await new Promise((r) => setTimeout(r, 700))
  await client.stop()
  const gaps = times.slice(1).map((t, i) => t - times[i])
  assert.ok(times.length >= 4, `tentativi: ${times.length}`)
  assert.ok(gaps[1] > gaps[0] * 1.4, `crescono: ${gaps}`)
  assert.ok(gaps.every((g) => g < 120 + 60), `con tetto: ${gaps}`)
})

test('end to end con il gateway vero: handshake Noise, richiesta e risposta tra RelayTransport e host finto', async () => {
  const relay = await fakeRelay()
  const { key: k } = key()
  const noise = generateKeyPair()
  const snapshot = { type: 'snapshot', projects: [], sessions: [], ui: {}, agents: [], drafts: {}, profiles: [], connections: [], terminals: [], shortcuts: { preset: 'default', overrides: {} } } as unknown as Extract<HostEvent, { type: 'snapshot' }>
  const host: RemoteHostApi = { snapshot: async () => snapshot, handle: async () => null, pageItems: (sessionId) => ({ sessionId, items: [], hasMore: false }), connectionClosed: () => undefined }
  const gateway = new RemoteGateway({ host, identity: noise, macName: 'Mac', appVersion: '1' })
  const client = new RelayClient({ gateway, relayUrl: relay.url, key: k })
  client.start()
  const mac = await relay.until(() => relay.macs[0])

  // Il "relay" fa da inoltro tra un telefono (RelayTransport su un secondo server) e il Mac: qui basta emulare un telefono con OPEN/DATA.
  const phoneId = 42
  mac.send(encodeFrame(RELAY_FRAME_OPEN, phoneId))
  const hs = clientHandshake({ macPublicKey: noise.publicKey, hello: { device: 'Phone' } })
  mac.send(encodeFrame(RELAY_FRAME_DATA, phoneId, hs.start()))
  const reply = await relay.until(() => relay.frames.find((f) => f.type === RELAY_FRAME_DATA))
  const done = hs.finish(reply.payload)
  assert.equal(done.hello.mac, 'Mac')
  relay.frames.length = 0
  for (const bytes of done.session.seal({ rid: 'r1', command: { type: 'hello' } } satisfies ToRemoteHost)) mac.send(encodeFrame(RELAY_FRAME_DATA, phoneId, bytes))
  const answer = await relay.until(() => relay.frames.find((f) => f.type === RELAY_FRAME_DATA))
  const message = done.session.open<FromRemoteHost>(answer.payload)
  assert.equal(message?.kind, 'result')
  await client.stop()
  gateway.close()
  await relay.close()
})

test('RelayTransport: stato del Mac, byte e chiusura', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.on('listening', () => resolve()))
  const port = (server.address() as { port: number }).port
  let peer: WsSocket | null = null
  server.on('connection', (ws) => {
    peer = ws
    ws.send(JSON.stringify({ t: 'mac', online: false, since: 123, reason: 'asleep' }))
    ws.on('message', (data, isBinary) => {
      if (!isBinary && data.toString() === 'ping') ws.send('pong')
      else ws.send(data, { binary: isBinary })
    })
  })
  const transport = new RelayTransport({ relayUrl: `ws://127.0.0.1:${port}`, macId: 'a'.repeat(32) })
  const statuses: unknown[] = []
  const bytes: Uint8Array[] = []
  let closed: number | null = null
  transport.onStatus((s) => statuses.push(s))
  transport.onBytes((b) => bytes.push(b))
  transport.onClose((code) => (closed = code))
  await new Promise<void>((resolve) => transport.onOpen(resolve))
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(statuses, [{ online: false, since: 123, reason: 'asleep' }])
  assert.deepEqual(transport.status, { online: false, since: 123, reason: 'asleep' })
  peer!.send(JSON.stringify({ t: 'mac', online: true }))
  transport.send(Uint8Array.from([4, 5]))
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(statuses[1], { online: true })
  assert.deepEqual([...bytes[0]], [4, 5])
  transport.close()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(closed, 1000)
  assert.throws(() => transport.send(Uint8Array.of(1)))
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
