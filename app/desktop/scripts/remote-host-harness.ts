// Host finto per provare il relay a mano (LAD-50): RemoteGateway vero + RelayClient vero + Host finto con una sessione e una richiesta aperta.
//
//   node scripts/remote-host-harness.ts --relay ws://127.0.0.1:8787 [--data <cartella>]
//
// Stampa l'id del Mac e il file di identità da passare a scripts/remote-client.ts (--id, --identity). La cartella dati conserva le chiavi:
// con la stessa cartella l'id resta uguale tra un avvio e l'altro. Ctrl+C / SIGTERM: avvisa il relay ("quit") ed esce.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatItem, HostEvent } from '../src/shared/protocol.ts'
import { RemoteGateway, type RemoteHostApi } from '../src/host/remote/gateway.ts'
import { IDENTITY_FILE, loadOrCreateIdentity, loadOrCreateRelayKey } from '../src/host/remote/identity.ts'
import { RelayClient } from '../src/host/remote/relay-client.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => args[args.indexOf(name) + 1]
const relayUrl = flag('--relay')
if (!relayUrl) {
  console.error('Uso: remote-host-harness.ts --relay <url> [--data <cartella>]')
  process.exit(1)
}
const dataDir = flag('--data') ?? mkdtempSync(join(tmpdir(), 'ladder-harness-'))

const base = { turnId: 't1', at: Date.now() }
const items: ChatItem[] = [
  { ...base, id: 'i1', seq: 1, kind: 'user', text: 'Add a relay for the phone app' } as unknown as ChatItem,
  { ...base, id: 'i2', seq: 2, kind: 'assistant', text: 'I will start with the Worker and its Durable Object.', streaming: false } as unknown as ChatItem,
  { ...base, id: 'i3', seq: 3, kind: 'request', requestId: 'rq1', requestType: 'permission', toolName: 'Bash', title: 'Run pnpm test', command: 'pnpm test', path: null, reason: null, options: [{ id: 'yes', label: 'Allow', kind: 'allow' }, { id: 'no', label: 'Deny', kind: 'reject' }], questions: null, state: 'open', resolution: null } as unknown as ChatItem
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

const identity = loadOrCreateIdentity(dataDir)
const key = loadOrCreateRelayKey(dataDir)
const gateway = new RemoteGateway({ host, identity, macName: 'Harness Mac', appVersion: 'harness', log: (m) => console.log(`[gateway] ${m}`) })
const client = new RelayClient({ gateway, relayUrl, key, log: (m) => console.log(`[relay] ${m}`) })
client.start()
console.log(`id: ${client.id}`)
console.log(`identity: ${join(dataDir, IDENTITY_FILE)}`)

const stop = () => {
  void client.setMacState('quit').then(() => client.stop()).finally(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
// Comandi da stdin per le prove: "sleep" / "wake".
process.stdin.on('data', (data) => {
  const word = data.toString().trim()
  if (word === 'sleep') void client.setMacState('asleep')
  else if (word === 'wake') void client.setMacState('awake')
})
