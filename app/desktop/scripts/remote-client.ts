// Client di prova per il canale remoto (LAD-49): fa da telefono da riga di comando. Node 24 lo esegue direttamente.
//
//   LADDER_REMOTE_PORT=7777 node scripts/remote-client.ts [list]
//   LADDER_REMOTE_PORT=7777 node scripts/remote-client.ts watch <sessionId>      pagina finale + item dal vivo
//   LADDER_REMOTE_PORT=7777 node scripts/remote-client.ts approve <sessionId>    approva la prima richiesta aperta (anche una che arriva dopo)
//
// Attraverso il relay (LAD-50), al posto della porta locale:
//   node scripts/remote-client.ts --relay ws://127.0.0.1:8787 --id <id del Mac> [list | watch <id> | approve <id>] [--wait]
// L'id lo stampa l'host all'avvio ("[remote] relay …, id …"). Con --wait, se il Mac è offline il client aspetta che torni (altrimenti esce).
//
// Chiave pubblica del Mac: LADDER_REMOTE_PUBKEY (base64url) oppure il file di identità (LADDER_REMOTE_IDENTITY o --identity <file>).
// Dal file si legge solo `publicKey`: la chiave privata non serve al client e non viene mai letta né stampata.
// Senza indicazioni il file si cerca nella cartella dati di Ladder: ~/Library/Application Support/Ladder/remote-identity.json.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { ChatItem, FromRemoteHost, RemoteCommand, RemotePage, RemoteSnapshot, ToRemoteHost } from '../src/shared/protocol.ts'
import { RelayTransport } from '../src/shared/remote/relay-transport.ts'
import { clientHandshake, type RemoteSession } from '../src/shared/remote/session.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const [, value] = args.splice(i, 2)
  return value
}

const identityFlag = flag('--identity')
const relayFlag = flag('--relay')
const idFlag = flag('--id')
const waitFlag = args.includes('--wait')
if (waitFlag) args.splice(args.indexOf('--wait'), 1)

function macPublicKey(): Uint8Array {
  const fromEnv = process.env.LADDER_REMOTE_PUBKEY
  let text = fromEnv
  if (!text) {
    const path = identityFlag ?? process.env.LADDER_REMOTE_IDENTITY ?? join(homedir(), 'Library', 'Application Support', 'Ladder', 'remote-identity.json')
    // Si estrae solo publicKey: il resto del file non entra mai in una variabile.
    text = (JSON.parse(readFileSync(path, 'utf8')) as { publicKey?: string }).publicKey
  }
  const key = text ? new Uint8Array(Buffer.from(text, 'base64url')) : null
  if (!key || key.length !== 32) fail('Chiave pubblica del Mac mancante o non valida (LADDER_REMOTE_PUBKEY o --identity).')
  return key
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const port = Number(process.env.LADDER_REMOTE_PORT)
if (relayFlag) {
  if (!idFlag) fail('Con --relay serve anche --id <id del Mac>.')
} else if (!Number.isInteger(port) || port <= 0) fail('Imposta LADDER_REMOTE_PORT con la porta del canale remoto (oppure usa --relay e --id).')
const [cmd = 'list', target] = args
if ((cmd === 'watch' || cmd === 'approve') && !target) fail(`Uso: remote-client.ts ${cmd} <sessionId>`)
if (!['list', 'watch', 'approve'].includes(cmd)) fail('Comandi: list | watch <sessionId> | approve <sessionId>')

const macKey = macPublicKey()
const newHandshake = () => clientHandshake({ macPublicKey: macKey, hello: { device: 'ladder remote-client (test)', locale: 'en' } })
let handshake = newHandshake()
// Un solo trasporto per volta: WebSocket locale o relay; il resto del client usa solo ws.send / ws.close.
const ws: { send(bytes: Uint8Array): void; close(): void } = relayFlag ? relayLink() : localLink()
let session: RemoteSession | null = null
let nextRid = 0
const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>()
const seen = new Set<string>()
let approved = false
let currentSnapshot: RemoteSnapshot | null = null

function request<T>(command: RemoteCommand): Promise<T> {
  return new Promise((resolve, reject) => {
    const rid = `c${++nextRid}`
    pending.set(rid, { resolve: resolve as (data: unknown) => void, reject })
    const message: ToRemoteHost = { rid, command }
    for (const bytes of session!.seal(message)) ws.send(bytes)
  })
}

const oneLine = (text: string, max = 100): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function describe(item: ChatItem): string {
  switch (item.kind) {
    case 'user':
      return `you: ${oneLine(item.text)}`
    case 'assistant':
      return `agent${item.streaming ? ' (writing)' : ''}: ${oneLine(item.text)}`
    case 'request':
      return `request [${item.state}] ${item.title}${item.command ? ` · ${oneLine(item.command, 60)}` : ''}`
    default:
      return item.kind
  }
}

function printItems(items: ChatItem[]): void {
  for (const item of items) console.log(`  #${item.seq} ${describe(item)}`)
}

/** Approva la prima richiesta aperta che non ha opzione di rifiuto come unica scelta: prima 'allow', poi 'allow-always'. */
async function approveOpen(items: ChatItem[]): Promise<void> {
  if (approved) return
  for (const item of items) {
    if (item.kind !== 'request' || item.state !== 'open') continue
    const option = item.options.find((o) => o.kind === 'allow') ?? item.options.find((o) => o.kind === 'allow-always')
    if (!option) continue
    approved = true
    console.log(`approving "${item.title}" with option "${option.label}"`)
    await request({ type: 'session.respond', sessionId: target!, requestId: item.requestId, response: { optionId: option.id } })
    console.log('approved (via: phone)')
    ws.close()
    return
  }
}

function onEvent(message: Extract<FromRemoteHost, { kind: 'event' }>): void {
  const { event } = message
  if (event.type === 'snapshot') currentSnapshot = event
  else if (event.type === 'session.items' && event.sessionId === target) {
    const fresh = event.items.filter((i) => event.replace || !seen.has(`${i.id}:${i.kind}:${JSON.stringify(i).length}`))
    for (const i of event.items) seen.add(`${i.id}:${i.kind}:${JSON.stringify(i).length}`)
    if (cmd === 'watch') printItems(fresh)
    if (cmd === 'approve') void approveOpen(event.items)
  } else if (event.type === 'session.upsert' && event.session.id === target && cmd === 'watch') {
    console.log(`  [session] ${event.session.run}${event.session.waitingLabel ? ` · ${event.session.waitingLabel}` : ''}`)
  }
}

async function run(): Promise<void> {
  const snapshot = await request<RemoteSnapshot>({ type: 'hello' })
  currentSnapshot = snapshot
  if (cmd === 'list') {
    for (const project of snapshot.projects) {
      console.log(`${project.name}  (${project.path})${project.branch ? `  [${project.branch}]` : ''}`)
      for (const s of snapshot.sessions.filter((x) => x.projectId === project.id)) {
        console.log(`  ${s.id}  ${s.title}  · ${s.agent} · ${s.run}${s.waitingLabel ? ` · ${s.waitingLabel}` : ''}`)
      }
    }
    ws.close()
    return
  }
  const known = currentSnapshot.sessions.find((s) => s.id === target)
  if (!known) fail(`Sessione ${target} non trovata (prova "list").`)
  console.log(`${cmd} "${known.title}" (${known.run})`)
  // Prima si segue (così non si perde nulla), poi si legge l'ultima pagina.
  await request({ type: 'session.watch', sessionId: target!, on: true })
  const page = await request<RemotePage>({ type: 'session.page', sessionId: target!, limit: 20 })
  for (const i of page.items) seen.add(`${i.id}:${i.kind}:${JSON.stringify(i).length}`)
  if (cmd === 'watch') {
    console.log(page.hasMore ? '  … older items available (session.page before)' : '')
    printItems(page.items)
    console.log('listening for live items (Ctrl+C to stop)')
  } else {
    await approveOpen(page.items)
    if (!approved) console.log('no open request: waiting for one (Ctrl+C to stop)')
  }
}

function onBytes(bytes: Uint8Array): void {
  try {
    if (!session) {
      const done = handshake.finish(bytes)
      session = done.session
      console.log(`connected to ${done.hello.mac} (Ladder ${done.hello.app || 'dev'})`)
      run().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
      return
    }
    const message = session.open<FromRemoteHost>(bytes)
    if (!message) return
    if (message.kind === 'event') return onEvent(message)
    const waiter = pending.get(message.rid)
    pending.delete(message.rid)
    if (message.ok) waiter?.resolve(message.data)
    else waiter?.reject(new Error(message.error))
  } catch (error) {
    fail(`connection error: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function localLink() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  socket.binaryType = 'nodebuffer'
  socket.on('open', () => socket.send(handshake.start()))
  socket.on('message', (data: Buffer) => onBytes(new Uint8Array(data.buffer, data.byteOffset, data.length)))
  socket.on('close', () => process.exit(0))
  socket.on('error', (error) => fail(`cannot connect: ${error.message}`))
  return { send: (bytes: Uint8Array) => socket.send(bytes), close: () => socket.close() }
}

function relayLink() {
  const transport = new RelayTransport({ relayUrl: relayFlag!, macId: idFlag! })
  let first = true
  const when = (since: number | null) => (since ? new Date(since).toISOString() : 'never seen')
  transport.onStatus((status) => {
    if (status.online) {
      // Ogni "online" è un collegamento nuovo con il Mac: sessione e handshake da capo.
      console.log(first ? 'relay: Mac online' : 'relay: Mac back online, new handshake')
      first = false
      session = null
      pending.clear()
      handshake = newHandshake()
      transport.send(handshake.start())
      return
    }
    console.log(`relay: Mac offline (reason: ${status.reason}, last seen: ${when(status.since)})`)
    session = null
    if (first && !waitFlag) {
      transport.close()
      process.exit(3)
    }
    first = false
  })
  transport.onBytes(onBytes)
  transport.onClose((code, reason) => {
    if (code === 1000) process.exit(0)
    fail(`relay connection lost (${code}${reason ? `: ${reason}` : ''})`)
  })
  return { send: (bytes: Uint8Array) => transport.send(bytes), close: () => transport.close() }
}
