// Test client for the remote channel: acts as a phone from the command line. Node 24 runs it directly.
//
// Pairing (once): the `ladder://pair#…` link is printed by the test host (remote-host-harness) or given by the Mac (QR).
//   node scripts/remote-client.ts pair 'ladder://pair#…' [--password <password>]
// Saves the device key, the Mac key and the address in the --device file (or LADDER_REMOTE_DEVICE, or ~/.ladder-remote-client.json, 0600).
// After that the commands authenticate by themselves with that file (no other setting is needed):
//   node scripts/remote-client.ts [list]
//   node scripts/remote-client.ts watch <sessionId>      last page + live items
//   node scripts/remote-client.ts approve <sessionId>    approves the first open request (even one that arrives later)
//   node scripts/remote-client.ts create <projectId> "<text>" [--agent <id>] [--permission <level>]   new session, then follows it
//   node scripts/remote-client.ts usage [agentId] [profileId]   plan limits; twice in a row: the second one comes from the cache
//   node scripts/remote-client.ts defaults               new-session defaults per project and account
// The route is chosen from what the link contained: `ws` (local WebSocket, development) if present, otherwise the relay.
// It can be forced: LADDER_REMOTE_PORT=7777 or --relay ws://127.0.0.1:8787 --id <Mac id>. With --wait, if the Mac is offline the client waits for it to come back (otherwise it exits).
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { AgentId, ChatItem, FromRemoteHost, PermissionLevel, RemoteAgentStatus, SessionSummary, RemoteFirstMessage, RemotePairingPayload, RemoteCommand, RemotePage, RemoteSnapshot, ToRemoteHost } from '../src/shared/protocol.ts'
import { decodePairingUrl, fromBase64Url, generateDeviceKey, keyFingerprint, signChannelBinding, toBase64Url } from '../src/shared/remote/pairing.ts'
import { RelayTransport } from '../src/shared/remote/relay-transport.ts'
import { clientHandshake, type RemoteSession } from '../src/shared/remote/session.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const [, value] = args.splice(i, 2)
  return value
}

const deviceFlag = flag('--device')
const passwordFlag = flag('--password')
let relayFlag = flag('--relay')
let idFlag = flag('--id')
const waitFlag = args.includes('--wait')
if (waitFlag) args.splice(args.indexOf('--wait'), 1)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

/** Paired device: the Ed25519 key of the "phone" (for tests only) and how to reach the Mac. */
interface DeviceFile {
  v: 1
  mac: string
  /** X25519 public key of the Mac, base64url. */
  macKey: string
  relay?: string
  id?: string
  ws?: string
  deviceId: string
  secretKey: string
  publicKey: string
}
const devicePath = deviceFlag ?? process.env.LADDER_REMOTE_DEVICE ?? join(homedir(), '.ladder-remote-client.json')
const loadDevice = (): DeviceFile | null => (existsSync(devicePath) ? (JSON.parse(readFileSync(devicePath, 'utf8')) as DeviceFile) : null)

const agentFlag = flag('--agent')
const permissionFlag = flag('--permission')
const [cmd = 'list', target, extraArg] = args
const pairing = cmd === 'pair'
if (!pairing && ((cmd === 'watch' || cmd === 'approve') && !target)) fail(`Usage: remote-client.ts ${cmd} <sessionId>`)
if (cmd === 'create' && (!target || !extraArg)) fail('Usage: remote-client.ts create <projectId> "<text>" [--agent <id>] [--permission <level>]')
if (!['list', 'watch', 'approve', 'pair', 'create', 'usage', 'defaults'].includes(cmd)) fail('Commands: pair <link> | list | watch <sessionId> | approve <sessionId> | create <projectId> "<text>" | usage [agentId] [profileId] | defaults')

// With `pair` the route and the Mac key come from the link; otherwise from the device file.
let payload: RemotePairingPayload | null = null
let device: DeviceFile | null = null
if (pairing) {
  if (!target) fail('Usage: remote-client.ts pair <ladder://pair#…> [--password <password>]')
  try {
    payload = decodePairingUrl(target)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  if (payload.exp < Date.now()) fail('Pairing code expired.')
  console.log(`pairing with "${payload.mac}", key ${keyFingerprint(fromBase64Url(payload.key))}, via ${payload.ws ?? payload.relay}`)
  if (payload.pw && !passwordFlag) fail('This Mac asks for a password: add --password <password>.')
} else {
  device = loadDevice()
  if (!device) fail(`No paired device (${devicePath}): run "pair <link>" first.`)
}
const route = payload ?? device!
const useLocal = !relayFlag && !process.env.LADDER_REMOTE_PORT ? Boolean(route.ws) : false
if (!useLocal && !process.env.LADDER_REMOTE_PORT && !relayFlag) {
  relayFlag = route.relay
  idFlag = route.id
}
const port = process.env.LADDER_REMOTE_PORT ? Number(process.env.LADDER_REMOTE_PORT) : useLocal ? Number(new URL(route.ws!).port) : 0
if (relayFlag) {
  if (!idFlag) fail('--relay also needs --id <Mac id>.')
} else if (!Number.isInteger(port) || port <= 0) fail('No route to the Mac: a link with ws or relay is needed (or LADDER_REMOTE_PORT, or --relay and --id).')

const macKey = fromBase64Url(payload?.key ?? device!.macKey)
const deviceKey = device ? { secretKey: fromBase64Url(device.secretKey), publicKey: fromBase64Url(device.publicKey) } : generateDeviceKey()
const newHandshake = () => clientHandshake({ macPublicKey: macKey, hello: { device: 'ladder remote-client (test)', locale: 'en' } })
let handshake = newHandshake()
// One transport at a time: local WebSocket or relay; the rest of the client only uses ws.send / ws.close.
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

/** Approves the first open request that does not have refusal as its only option: first 'allow', then 'allow-always'. */
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
  else if (event.type === 'session.items' && cmd === 'create') printItems(event.items)
  else if (event.type === 'session.upsert' && cmd === 'create') console.log(`  [session] ${event.session.id} ${event.session.run}`)
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
  if (cmd === 'defaults') {
    for (const p of snapshot.projects) console.log(`${p.name} (${p.id}): ${JSON.stringify(snapshot.defaults[p.id])}  max=${snapshot.permissionsMax[p.id] ?? 'none'}`)
    console.log('accounts:', snapshot.profiles.map((x) => `${x.id}=${x.agent}/${x.name}${x.isDefault ? ' (default)' : ''}`).join(', ') || 'none')
    for (const a of snapshot.agents) console.log(`agent ${a.agent}${a.profileId ? `#${a.profileId}` : ''}: ${a.account ?? 'no plan'} · models ${a.models.map((m) => m.id).join(',') || 'none'}`)
    ws.close()
    return
  }
  if (cmd === 'usage') {
    // For each agent (or the requested one): two reads in a row, the second must come from the cache.
    const targets = snapshot.agents.filter((a) => (!target || a.agent === target) && (!extraArg || a.profileId === extraArg))
    for (const a of targets) {
      for (const round of [1, 2]) {
        const t0 = Date.now()
        const status = await request<RemoteAgentStatus | null>({ type: 'agents.usage', agent: a.agent as AgentId, ...(a.profileId ? { profileId: a.profileId } : {}) })
        console.log(`usage ${a.agent}${a.profileId ? `#${a.profileId}` : ''} read ${round} (${Date.now() - t0} ms): ${status?.account ?? 'no plan'} · ${(status?.usage ?? []).map((w) => `${w.label ?? `${w.minutes}m`} ${w.percent ?? '?'}%`).join(', ') || 'no windows'} · at ${status?.usageAt ?? '-'}`)
      }
    }
    ws.close()
    return
  }
  if (cmd === 'create') {
    const project = snapshot.projects.find((p) => p.id === target)
    if (!project) fail(`Project ${target} not found (try "list").`)
    const d = snapshot.defaults[project.id]
    const agent = (agentFlag ?? d?.agent ?? 'claude-code') as AgentId
    const launch = d?.launch[agent]
    const permission = (permissionFlag ?? d?.permission ?? 'edit') as PermissionLevel
    console.log(`create in "${project.name}": ${agent} model=${launch?.model ?? 'default'} effort=${launch?.effort ?? 'default'} permission=${permission}`)
    // Follows the session just created through the session.upsert event (it arrives before the result), then reads the first page.
    const created = await request<SessionSummary>({ type: 'session.create', projectId: project.id, agent, text: extraArg!, model: launch?.model ?? null, effort: launch?.effort ?? null, permission })
    console.log(`created ${created.id} "${created.title}" (${created.run})`)
    await request({ type: 'session.watch', sessionId: created.id, on: true })
    const page = await request<RemotePage>({ type: 'session.page', sessionId: created.id, limit: 20 })
    printItems(page.items)
    console.log('listening for live items (Ctrl+C to stop)')
    return
  }
  const known = currentSnapshot.sessions.find((s) => s.id === target)
  if (!known) fail(`Session ${target} not found (try "list").`)
  console.log(`${cmd} "${known.title}" (${known.run})`)
  // Follow first (so nothing is missed), then read the last page.
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
      console.log(`connected to ${done.hello.mac} (Ladder ${done.hello.app || 'dev'}), authenticating`)
      // After the handshake the connection is not authenticated: the first message is `pair` or `auth`, signed over the handshake hash.
      const hash = session.handshakeHash
      const first: RemoteFirstMessage = device
        ? { type: 'auth', deviceId: device.deviceId, sig: signChannelBinding(deviceKey.secretKey, 'auth', hash) }
        : {
            type: 'pair',
            token: payload!.token,
            device: { publicKey: toBase64Url(deviceKey.publicKey), name: 'ladder remote-client (test)', platform: 'ios' },
            ...(passwordFlag ? { password: passwordFlag } : {}),
            sig: signChannelBinding(deviceKey.secretKey, 'pair', hash)
          }
      for (const out of session.seal(first)) ws.send(out)
      return
    }
    const message = session.open<FromRemoteHost>(bytes)
    if (!message) return
    if (message.kind === 'auth') return onAuth(message)
    if (message.kind === 'event') return onEvent(message)
    const waiter = pending.get(message.rid)
    pending.delete(message.rid)
    if (message.ok) waiter?.resolve(message.data)
    else waiter?.reject(new Error(message.error))
  } catch (error) {
    fail(`connection error: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Outcome of pair/auth, or a revocation notice on an open connection. */
function onAuth(message: Extract<FromRemoteHost, { kind: 'auth' }>): void {
  if (!message.ok) {
    console.error(`authentication refused (${message.code}): ${message.error}`)
    process.exit(4)
  }
  console.log(`authenticated as "${message.name}" (${message.deviceId}), Full access from phone: ${message.allowFull ? 'allowed' : 'blocked'}`)
  if (pairing) {
    const file: DeviceFile = {
      v: 1,
      mac: payload!.mac,
      macKey: payload!.key,
      ...(payload!.relay ? { relay: payload!.relay, id: payload!.id } : {}),
      ...(payload!.ws ? { ws: payload!.ws } : {}),
      deviceId: message.deviceId,
      secretKey: toBase64Url(deviceKey.secretKey),
      publicKey: toBase64Url(deviceKey.publicKey)
    }
    writeFileSync(devicePath, JSON.stringify(file, null, 2), { mode: 0o600 })
    chmodSync(devicePath, 0o600)
    console.log(`paired: saved device in ${devicePath}`)
    ws.close()
    return
  }
  run().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
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
      // Each "online" is a new link with the Mac: session and handshake start over.
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
