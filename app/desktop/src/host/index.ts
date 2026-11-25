// Host delle sessioni: gira in un utilityProcess di Electron, separato dalla UI.
// Il processo main gli passa una MessagePort per ogni finestra; l'host risponde ai comandi e trasmette gli eventi.
import type { MessagePortMain } from 'electron'
import { t } from '@shared/i18n'
import type { FromHost, HostEvent, HostToMain, MainToHost, ToHost } from '@shared/protocol'
import '@shared/locales/it'
import { dirname } from 'node:path'
import { socketPathFor } from '../cli/socket-path.ts'
import { shellPath } from './agents/common'
import { CliInstall } from './cli-install'
import { CliSocket } from './cli-socket'
import { openDb } from './db'
import { CLI_ORIGIN, Host } from './sessions'

const ports = new Set<MessagePortMain>()
let hostRef: Host | null = null
let cliSocket: CliSocket | null = null

/** Porta chiusa o non più raggiungibile: via dall'elenco e via le sue iscrizioni (git.watch, fs.watch), che l'host non ricorda per finestra. */
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
  // CLI clients subscribed to a session receive its lines.
  cliSocket?.publish(event)
}

/** Un evento a una sola finestra (la mappa dei branch va solo a chi è iscritto al progetto). */
function sendTo(origin: object, event: HostEvent): void {
  if (ports.has(origin as MessagePortMain)) post(origin as MessagePortMain, { kind: 'event', event })
}

async function main(): Promise<void> {
  const dbPath = process.env.LADDER_DB_PATH
  if (!dbPath) throw new Error('LADDER_DB_PATH mancante')
  // Notifiche e badge li mostra il main: qui partono solo gli eventi.
  const toMain = (message: HostToMain) => process.parentPort.postMessage(message)
  const host = new Host(openDb(dbPath), broadcast, toMain, sendTo)
  hostRef = host
  // Le preferenze arrivano prima dell'avvio (variabile d'ambiente) e poi a ogni cambio.
  if (process.env.LADDER_HOST_PREFS) host.setPrefs(JSON.parse(process.env.LADDER_HOST_PREFS))
  await host.init()
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
      host.setPrefs(message.prefs)
      return
    }
    // LAD-57 parte 2: risposte e avvisi del main sul browser dell'agente.
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
        const result = await host.handle(command, port)
        if (rid) post(port, { kind: 'result', rid, ok: true, data: result })
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
    cliSocket?.close()
    host.shutdown()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main().catch((error) => {
  console.error('[host] avvio non riuscito', error)
  process.exit(1)
})
