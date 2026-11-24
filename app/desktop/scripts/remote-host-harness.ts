// Host finto per provare il relay a mano (LAD-50): RemoteGateway vero + RelayClient vero + Host finto con una sessione e una richiesta aperta.
//
//   node scripts/remote-host-harness.ts [--relay ws://127.0.0.1:8787] [--port 7777] [--data <cartella>]
//
// Almeno uno tra --relay e --port (WebSocket locale). Stampa il link di abbinamento `ladder://pair#…` (LAD-51): si passa a
// `scripts/remote-client.ts pair <link>`. Comandi da stdin: "pair [password]" (nuovo link, con password opzionale), "devices" (anche token push, preferenze, primo piano), "revoke <id>",
// "log", "regen" (rigenera la chiave), "sleep" / "wake".
// Stampa anche l'id del Mac e il file di identità da passare a scripts/remote-client.ts (--id, --identity). La cartella dati conserva le chiavi:
// con la stessa cartella l'id resta uguale tra un avvio e l'altro. Ctrl+C / SIGTERM: avvisa il relay ("quit") ed esce.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatItem, HostEvent } from '../src/shared/protocol.ts'
import { openDb } from '../src/host/db.ts'
import { RemoteAccess } from '../src/host/remote/access.ts'
import { RemoteGateway, type RemoteHostApi } from '../src/host/remote/gateway.ts'
import { IDENTITY_FILE, loadOrCreateIdentity, loadOrCreateRelayKey, regenerateIdentity, regenerateRelayKey } from '../src/host/remote/identity.ts'
import { RelayClient } from '../src/host/remote/relay-client.ts'
import { startLocalWsServer } from '../src/host/remote/ws-server.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const relayUrl = flag('--relay')
const portFlag = flag('--port')
if (!relayUrl && !portFlag) {
  console.error('Uso: remote-host-harness.ts [--relay <url>] [--port <n>] [--data <cartella>]')
  process.exit(1)
}
const dataDir = flag('--data') ?? mkdtempSync(join(tmpdir(), 'ladder-harness-'))

const base = { turnId: 't1', at: Date.now() }
const items: ChatItem[] = [
  { ...base, id: 'i1', seq: 1, kind: 'user', text: 'Add a relay for the phone app' } as unknown as ChatItem,
  { ...base, id: 'i2', seq: 2, kind: 'assistant', text: 'I will start with the Worker and its Durable Object.', streaming: false } as unknown as ChatItem,
  { ...base, id: 'i3', seq: 3, kind: 'request', requestId: 'rq1', requestType: 'permission', toolName: 'Bash', title: 'Run pnpm test', command: 'pnpm test', path: null, reason: null, options: [{ id: 'yes', label: 'Allow', kind: 'allow' }, { id: 'no', label: 'Deny', kind: 'deny' }], questions: null, state: 'open', resolution: null } as unknown as ChatItem
]
const snapshot = {
  type: 'snapshot',
  projects: [{ id: 'p1', name: 'Demo project', path: '/tmp/demo', branch: 'main', isGit: true, addedAt: 1 }],
  sessions: [{ id: 's1', projectId: 'p1', title: 'Relay demo', agent: 'claude', run: 'waiting', waitingLabel: 'Needs approval' }],
  ui: {},
  agents: [],
  drafts: {},
  profiles: [],
  connections: [],
  terminals: [],
  shortcuts: { preset: 'default', overrides: {} }
} as unknown as Extract<HostEvent, { type: 'snapshot' }>

const host: RemoteHostApi = {
  snapshot: async () => snapshot,
  handle: async (command) => {
    if (command.type === 'session.respond') {
      console.log(`[harness] respond to ${command.requestId}: ${JSON.stringify(command.response)} (via ${command.via})`)
      ;(items[2] as { state: string }).state = 'resolved'
      gateway.broadcast({ type: 'session.items', sessionId: 's1', items: [items[2]], replace: false } as unknown as HostEvent)
    }
    return null
  },
  pageItems: (sessionId) => ({ sessionId, items, hasMore: false }),
  connectionClosed: () => undefined
}

let identity = loadOrCreateIdentity(dataDir)
let key = loadOrCreateRelayKey(dataDir)
const access = new RemoteAccess(openDb(join(dataDir, 'harness.db')), { onPaired: (d) => console.log(`[harness] paired: ${d.name} (${d.id})`) })
access.enabled = true
const gateway = new RemoteGateway({
  host,
  identity,
  access,
  macName: 'Harness Mac',
  appVersion: 'harness',
  log: (m) => console.log(`[gateway] ${m}`),
  onLog: (e) => console.log(`[harness] log: ${e.deviceName} ${e.action} ${e.detail}`)
})
let client: RelayClient | null = null
const startRelay = () => {
  if (!relayUrl) return
  client = new RelayClient({ gateway, relayUrl, key, log: (m) => console.log(`[relay] ${m}`) })
  client.start()
  console.log(`id: ${client.id}`)
}
startRelay()
const local = portFlag ? await startLocalWsServer(gateway, Number(portFlag)) : null
if (local) console.log(`local: ws://127.0.0.1:${local.port}`)
console.log(`identity: ${join(dataDir, IDENTITY_FILE)}`)

/** Link di abbinamento nuovo, stampato; la password (se c'è) va chiesta dal client con --password. */
const pair = async (password?: string) => {
  if (password !== undefined) await access.setPassword(password || null)
  const start = access.startPairing({ macName: 'Harness Mac', key: identity.publicKey, ...(relayUrl && client ? { relay: relayUrl, id: client.id } : {}), ...(local ? { ws: `ws://127.0.0.1:${local.port}` } : {}) })
  console.log(`fingerprint: ${start.fingerprint}`)
  console.log(`pair: ${start.url}`)
}
await pair()

const stop = () => {
  void (client ? client.setMacState('quit').then(() => client!.stop()) : Promise.resolve()).finally(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
// Comandi da stdin per le prove.
process.stdin.on('data', (data) => {
  const [word, arg] = data.toString().trim().split(/\s+/)
  if (word === 'sleep') void client?.setMacState('asleep')
  else if (word === 'wake') void client?.setMacState('awake')
  else if (word === 'pair') void pair(arg)
  else if (word === 'devices')
    // Token push mai per intero (solo se c'è e il prefisso), preferenze e lingua come le ha mandate il telefono, stato in primo piano.
    for (const d of access.devices())
      console.log(`[harness] device ${d.id} ${d.name} connected=${gateway.connectedDevices().has(d.id)} foreground=${gateway.foregroundDevices().has(d.id)} platform=${d.platform} locale=${d.locale} push=${d.pushToken ? `${d.pushToken.slice(0, 18)}…` : 'none'} notify=${JSON.stringify(d.notify)}`)
  else if (word === 'revoke' && arg) {
    console.log(`[harness] revoke ${arg}: ${access.revoke(arg)}`)
    gateway.disconnectDevice(arg)
  } else if (word === 'log') for (const e of access.list().entries) console.log(`[harness] ${new Date(e.at).toISOString()} ${e.deviceName} ${e.action} ${e.detail}`)
  else if (word === 'regen') {
    access.cancelPairing()
    access.revokeAll()
    gateway.disconnectAll()
    // Come ChannelHost.regenerateKey: il relay ricorda sul vecchio id che la chiave è cambiata ('rekeyed'), al meglio.
    void (client ? Promise.race([client.setMacState('rekeyed'), new Promise<void>((r) => setTimeout(r, 1_500))]).then(() => client!.stop()) : Promise.resolve()).then(() => {
      identity = regenerateIdentity(dataDir)
      key = regenerateRelayKey(dataDir)
      gateway.setIdentity(identity)
      startRelay()
      console.log('[harness] key regenerated; run "pair" for a new link')
    })
  }
})
