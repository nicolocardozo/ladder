// Host delle sessioni: gira in un utilityProcess di Electron, separato dalla UI.
// Il processo main gli passa una MessagePort per ogni finestra; l'host risponde ai comandi e trasmette gli eventi.
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import type { MessagePortMain } from 'electron'
import type { FromHost, HostEvent, HostToMain, MainToHost, ToHost } from '@shared/protocol'
import '@shared/locales/it'
import { openDb } from './db'
import { RemoteGateway } from './remote/gateway'
import { loadOrCreateIdentity } from './remote/identity'
import { startLocalWsServer } from './remote/ws-server'
import { Host } from './sessions'

const ports = new Set<MessagePortMain>()
let hostRef: Host | null = null
// LAD-49: canale remoto per il telefono; esiste solo con LADDER_REMOTE_PORT (solo sviluppo, finché non arrivano abbinamento e relay).
let remote: RemoteGateway | null = null

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
  remote?.broadcast(event)
}

/** Un evento a una sola finestra (la mappa dei branch va solo a chi è iscritto al progetto). */
function sendTo(origin: object, event: HostEvent): void {
  if (ports.has(origin as MessagePortMain)) post(origin as MessagePortMain, { kind: 'event', event })
}

/** Canale remoto di prova: WebSocket su 127.0.0.1, solo se LADDER_REMOTE_PORT è un numero di porta valido. */
async function startRemote(host: Host, dbPath: string): Promise<void> {
  const raw = process.env.LADDER_REMOTE_PORT
  if (!raw) return
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('[remote] LADDER_REMOTE_PORT non valida, canale remoto spento')
    return
  }
  try {
    const identity = loadOrCreateIdentity(dirname(dbPath))
    // Nome del Mac senza caratteri di controllo e di lunghezza limitata.
    const macName = hostname().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'Mac'
    remote = new RemoteGateway({ host, identity, macName, appVersion: process.env.LADDER_APP_VERSION ?? '', log: (message) => console.log(`[remote] ${message}`) })
    const server = await startLocalWsServer(remote, port)
    console.log(`[remote] in ascolto su 127.0.0.1:${server.port}`)
  } catch (error) {
    remote = null
    console.error('[remote] avvio non riuscito', error instanceof Error ? error.message : String(error))
  }
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
  await startRemote(host, dbPath)

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
    remote?.close()
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
