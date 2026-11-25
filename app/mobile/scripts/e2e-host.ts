// E2E harness: the host's real RemoteGateway (Noise, frames, allowlist, limits) with a fake host fed by the app's fixtures,
// on a local WebSocket. The simulator connects as to a real Mac, without touching the user's Ladder app.
//
//   node scripts/e2e-host.ts [port]          # default port 7788; prints the address and the public key
//
// The identity is in a temporary file (/tmp), so it survives a harness restart. With `--speed 0.3` the agent simulation is faster.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { generateKeyPair, keyPairFromSecret } from '../../desktop/src/shared/remote/noise.ts'
import { RemoteGateway, type RemoteHostApi } from '../../desktop/src/host/remote/gateway.ts'
import { WebSocketServer } from '../../desktop/node_modules/ws/wrapper.mjs'
import type { RemoteLink } from '../../desktop/src/host/remote/gateway.ts'
import type { HostEvent } from '../../desktop/src/shared/protocol.ts'
import { FakeHost } from '../src/demo/fake-host.ts'

const args = process.argv.slice(2)
const speedAt = args.indexOf('--speed')
const speed = speedAt >= 0 ? Number(args.splice(speedAt, 2)[1]) : 1
const port = Number(args[0] ?? 7788)

const fake = new FakeHost({ speed, autoplay: true })
// Stable identity across restarts (temporary file, never the user's): used to test reconnection.
const IDENTITY_FILE = '/tmp/ladder-harness-identity.txt'
const identity = existsSync(IDENTITY_FILE)
  ? keyPairFromSecret(new Uint8Array(Buffer.from(readFileSync(IDENTITY_FILE, 'utf8').trim(), 'base64url')))
  : (() => {
      const pair = generateKeyPair()
      writeFileSync(IDENTITY_FILE, Buffer.from(pair.secretKey).toString('base64url'), { mode: 0o600 })
      return pair
    })()

const api: RemoteHostApi = {
  async snapshot() {
    const s = fake.snapshot()
    return { type: 'snapshot', projects: s.projects, sessions: s.sessions, drafts: {}, ui: s.ui as never, projectGroups: s.projectGroups, agents: s.agents, profiles: s.profiles.map((p) => ({ ...p, configDir: null, addedAt: 1 })), terminals: [] } as unknown as Extract<HostEvent, { type: 'snapshot' }>
  },
  handle: (command) => fake.handle(command as never),
  // New-session defaults, permission ceilings and preferences: as the Mac sends them.
  remoteExtras: async () => ({ permissionsMax: fake.snapshot().permissionsMax, busySend: 'queue' as const, defaults: fake.snapshot().defaults }),
  pageItems: (sessionId, before, limit) => fake.pageItems(sessionId, before, limit),
  connectionClosed: () => {}
}

const gateway = new RemoteGateway({ host: api, identity, macName: "Zoë's MacBook Pro (harness)", appVersion: 'harness', log: (m) => console.log(`[harness] ${m}`) })
fake.onEvent((event) => gateway.broadcast(event as unknown as HostEvent))

// The harness WebSocket server. Like host/remote/ws-server.ts, but it also accepts an Origin equal to the server's address:
// React Native's WebSocket (iOS and Android) always sends `Origin: http://<host>:<port>`, and ws-server.ts rejects every Origin.
const wss = new WebSocketServer({
  host: '127.0.0.1',
  port,
  maxPayload: 65535,
  verifyClient: ({ origin, req }: { origin: string; req: { headers: { host?: string } } }) => {
    console.log(`[harness] connection attempt, Origin: ${origin || '(none)'}`)
    return !origin || origin === `http://${req.headers.host}`
  }
})
wss.on('connection', (ws: any) => {
  const link: RemoteLink = {
    send: (bytes) => ws.send(bytes, { binary: true }),
    close: () => ws.close(),
    onBytes: (h) => ws.on('message', (data: Buffer, isBinary: boolean) => (isBinary ? h(new Uint8Array(data.buffer, data.byteOffset, data.length)) : ws.close(1003))),
    onClose: (h) => {
      ws.on('close', h)
      ws.on('error', h)
    },
    buffered: () => ws.bufferedAmount,
    onAlive: (h) => ws.on('pong', h)
  }
  gateway.accept(link)
})
// Ping every 15 s, like the host's server (30 s).
setInterval(() => wss.clients.forEach((c: any) => c.ping()), 15_000).unref()
const server = { port, stop: () => wss.close() }
const key = Buffer.from(identity.publicKey).toString('base64url')
console.log(`[harness] ws://127.0.0.1:${server.port}`)
console.log(`[harness] public key: ${key}`)
console.log(`[harness] pairing url: ladder://pair?k=${key}&u=${encodeURIComponent(`ws://127.0.0.1:${server.port}`)}&n=${encodeURIComponent('Harness Mac')}`)
process.on('SIGINT', () => {
  server.stop()
  fake.dispose()
  process.exit(0)
})
