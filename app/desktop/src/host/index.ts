// Sessions host: runs in an Electron utilityProcess, separate from the UI.
// The main process hands it a MessagePort for each window; the host answers commands and streams events.
import { dirname } from 'node:path'
import type { MessagePortMain } from 'electron'
import { t } from '@shared/i18n'
import type { FromHost, HostEvent, HostPrefs, HostToMain, MainToHost, ToHost } from '@shared/protocol'
import '@shared/locales/it'
import { socketPathFor } from '../cli/socket-path.ts'
import { shellPath } from './agents/common'
import { CliInstall } from './cli-install'
import { CliSocket } from './cli-socket'
import { openDb } from './db'
import { isRemoteWindowCommand, RemoteChannel } from './remote/channel'
import { CLI_ORIGIN, Host } from './sessions'

const ports = new Set<MessagePortMain>()
let hostRef: Host | null = null
// Remote channel for the phone: relay (HostPrefs.remote, LADDER_RELAY_URL) and a local test WebSocket (LADDER_REMOTE_PORT).
let remote: RemoteChannel | null = null
let cliSocket: CliSocket | null = null

/** Port closed or no longer reachable: drop it from the list and drop its subscriptions (git.watch, fs.watch), which the host doesn't track per window. */
function dropPort(port: MessagePortMain): void {
  ports.delete(port)
  hostRef?.connectionClosed(port)
}

function post(port: MessagePortMain, message: FromHost): void {
  try {
    port.postMessage(message)
  } catch {
    dropPort(port)
  }
}

function broadcast(event: HostEvent): void {
  for (const port of ports) post(port, { kind: 'event', event })
  remote?.gateway?.broadcast(event)
  // CLI clients subscribed to a session receive its lines.
  cliSocket?.publish(event)
}

/** An event for a single window (the branch map goes only to whoever is subscribed to the project). */
function sendTo(origin: object, event: HostEvent): void {
  if (ports.has(origin as MessagePortMain)) post(origin as MessagePortMain, { kind: 'event', event })
}

async function main(): Promise<void> {
  const dbPath = process.env.LADDER_DB_PATH
  if (!dbPath) throw new Error('LADDER_DB_PATH mancante')
  // Notifications and badges are shown by main: only the events start here.
  // The number of working sessions and the number of phones travel together in the `activity` message.
  let running = 0
  let phones = 0
  let busySend: HostPrefs['busySend'] = 'steer'
  const toMain = (message: HostToMain) => {
    if (message.type === 'activity') running = message.running
    process.parentPort.postMessage(message.type === 'activity' ? { ...message, phones } : message)
  }
  const db = openDb(dbPath)
  const host = new Host(db, broadcast, toMain, sendTo)
  hostRef = host
  // Preferences arrive before startup (environment variable) and then on every change.
  const initialPrefs: HostPrefs | null = process.env.LADDER_HOST_PREFS ? JSON.parse(process.env.LADDER_HOST_PREFS) : null
  if (initialPrefs) host.setPrefs(initialPrefs)
  busySend = initialPrefs?.busySend ?? busySend
  await host.init()
  remote = new RemoteChannel({
    host,
    db,
    dataDir: dirname(dbPath),
    appVersion: process.env.LADDER_APP_VERSION ?? '',
    onClients: (count) => {
      if (count === phones) return
      phones = count
      toMain({ type: 'activity', running })
    },
    // State, pairings and logs reach the windows (never the phone: they are not events the gateway allows).
    onStatus: (status) => broadcast({ type: 'remote.status', status }),
    onPaired: (device) => broadcast({ type: 'remote.paired', device }),
    onLog: (entry) => broadcast({ type: 'remote.log', entry })
  })
  await remote.configure(initialPrefs?.remote)
  // Local socket for the `ladder` CLI and command installation. If the socket fails to start, the rest of the app still works.
  const socketPath = process.env.LADDER_SOCKET_PATH || socketPathFor(dirname(dbPath))
  cliSocket = new CliSocket(socketPath, { handle: (command, signal) => host.handle(command, CLI_ORIGIN, signal) })
  host.setCli(new CliInstall({ bin: process.env.LADDER_CLI_BIN || null, socket: () => cliSocket?.socket ?? null, shellPath, t }))
  await cliSocket.start().catch((error: Error) => {
    console.error(`[host] CLI socket: ${error.message}`)
    cliSocket = null
  })

  process.parentPort.on('message', (event) => {
    const message = event.data as MainToHost | undefined
    if (message?.type === 'prefs') {
      const busyBefore = busySend
      busySend = message.prefs.busySend ?? busySend
      host.setPrefs(message.prefs)
      void remote?.configure(message.prefs.remote)
      // The phone's send key follows the Mac's.
      if (busySend !== busyBefore) void remote?.gateway?.pushPrefs().catch(() => undefined)
      // Global defaults for new sessions (and "Allow Full") changed: phones receive the current ones.
      else remote?.gateway?.pushDefaults()
      return
    }
    // The Mac sleeps, wakes or the app is quitting; on 'quit' we reply as soon as the relay has been told (half a second at most).
    if (message?.type === 'power') {
      if (message.state === 'quit') {
        const done = remote ? Promise.race([remote.setMacState('quit'), new Promise<void>((resolve) => setTimeout(resolve, 400))]) : Promise.resolve()
        void done.catch(() => undefined).finally(() => process.parentPort.postMessage({ type: 'power-ack', state: 'quit' } satisfies HostToMain))
      } else void remote?.setMacState(message.state).catch(() => undefined)
      return
    }
    // Main decided an event goes to the phones; the per-device filter is in the remote channel.
    if (message?.type === 'push') {
      remote?.notifyPhones(message.event)
      return
    }
    // Replies and notices from main about the agent's browser.
    if (message?.type === 'browser-agent-result') {
      host.browserAgentResult(message.rid, message.result)
      return
    }
    if (message?.type === 'browser-agent-closed') {
      host.browserAgentClosed(message.sessionId)
      return
    }
    const [port] = event.ports
    if (!port) return
    ports.add(port)
    port.on('message', async ({ data }) => {
      const { rid, command } = data as ToHost
      try {
        // remote.* commands are handled by the remote channel (devices, QR, password); from the window only.
        const result = isRemoteWindowCommand(command) ? await remote!.handleCommand(command) : await host.handle(command, port)
        if (rid) post(port, { kind: 'result', rid, ok: true, data: result })
        // The project's last agent and defaults live in the project UI: phones receive the new version.
        if (command.type === 'ui.set' || command.type === 'project.worktree.set') remote?.gateway?.pushDefaults()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[host] ${command.type}: ${message}`)
        if (rid) post(port, { kind: 'result', rid, ok: false, error: message })
      }
    })
    port.on('close', () => dropPort(port))
    port.start()
  })

  const stop = () => {
    // The relay is told that the Mac is quitting (phones see "closed", not "offline"), for at most half a second and without
    // blocking the exit. Electron may still kill the host first: main orders it with the app close.
    const closing = remote ? Promise.race([remote.setMacState('quit').then(() => remote?.close()), new Promise<void>((resolve) => setTimeout(resolve, 500))]) : Promise.resolve()
    cliSocket?.close()
    void closing.catch(() => undefined).finally(() => {
      host.shutdown()
      process.exit(0)
    })
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main().catch((error) => {
  console.error('[host] avvio non riuscito', error)
  process.exit(1)
})
