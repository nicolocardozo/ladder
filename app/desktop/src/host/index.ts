// Host delle sessioni: gira in un utilityProcess di Electron, separato dalla UI.
// Il processo main gli passa una MessagePort per ogni finestra; l'host risponde ai comandi e trasmette gli eventi.
import { dirname } from 'node:path'
import type { MessagePortMain } from 'electron'
import type { FromHost, HostEvent, HostPrefs, HostToMain, MainToHost, ToHost } from '@shared/protocol'
import '@shared/locales/it'
import { openDb } from './db'
import { isRemoteWindowCommand, RemoteChannel } from './remote/channel'
import { Host } from './sessions'

const ports = new Set<MessagePortMain>()
let hostRef: Host | null = null
// LAD-49/50: canale remoto per il telefono: relay (HostPrefs.remote, LADDER_RELAY_URL) e WebSocket locale di prova (LADDER_REMOTE_PORT).
let remote: RemoteChannel | null = null

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
  remote?.gateway?.broadcast(event)
}

/** Un evento a una sola finestra (la mappa dei branch va solo a chi è iscritto al progetto). */
function sendTo(origin: object, event: HostEvent): void {
  if (ports.has(origin as MessagePortMain)) post(origin as MessagePortMain, { kind: 'event', event })
}

async function main(): Promise<void> {
  const dbPath = process.env.LADDER_DB_PATH
  if (!dbPath) throw new Error('LADDER_DB_PATH mancante')
  // Notifiche e badge li mostra il main: qui partono solo gli eventi.
  // LAD-54: il numero di sessioni al lavoro e quello dei telefoni viaggiano insieme nel messaggio `activity`.
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
  // Le preferenze arrivano prima dell'avvio (variabile d'ambiente) e poi a ogni cambio.
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
    // LAD-51: stato, abbinamenti e log arrivano alle finestre (mai al telefono: non sono eventi ammessi dal gateway).
    onStatus: (status) => broadcast({ type: 'remote.status', status }),
    onPaired: (device) => broadcast({ type: 'remote.paired', device }),
    onLog: (entry) => broadcast({ type: 'remote.log', entry })
  })
  await remote.configure(initialPrefs?.remote)

  process.parentPort.on('message', (event) => {
    const message = event.data as MainToHost | undefined
    if (message?.type === 'prefs') {
      const busyBefore = busySend
      busySend = message.prefs.busySend ?? busySend
      host.setPrefs(message.prefs)
      void remote?.configure(message.prefs.remote)
      // Il tasto di invio del telefono segue quello del Mac.
      if (busySend !== busyBefore) void remote?.gateway?.pushPrefs().catch(() => undefined)
      // LAD-89: predefiniti globali delle nuove sessioni (e "Allow Full") cambiati: i telefoni ricevono quelli di adesso.
      else remote?.gateway?.pushDefaults()
      return
    }
    // LAD-54: il Mac dorme, si sveglia o l'app sta uscendo; con 'quit' si risponde appena il relay è stato avvisato (al massimo mezzo secondo).
    if (message?.type === 'power') {
      if (message.state === 'quit') {
        const done = remote ? Promise.race([remote.setMacState('quit'), new Promise<void>((resolve) => setTimeout(resolve, 400))]) : Promise.resolve()
        void done.catch(() => undefined).finally(() => process.parentPort.postMessage({ type: 'power-ack', state: 'quit' } satisfies HostToMain))
      } else void remote?.setMacState(message.state).catch(() => undefined)
      return
    }
    // LAD-53: il main ha deciso che un evento va ai telefoni; il filtro per dispositivo è nel canale remoto.
    if (message?.type === 'push') {
      remote?.notifyPhones(message.event)
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
        // LAD-51: i comandi remote.* li gestisce il canale remoto (dispositivi, QR, password); solo dalla finestra.
        const result = isRemoteWindowCommand(command) ? await remote!.handleCommand(command) : await host.handle(command, port)
        if (rid) post(port, { kind: 'result', rid, ok: true, data: result })
        // LAD-89: ultimo agente e predefiniti del progetto vivono nella UI del progetto: i telefoni ne ricevono la versione nuova.
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
    // Si prova a dire al relay che il Mac esce (i telefoni vedono "chiuso", non "offline"), ma al massimo per mezzo secondo e senza
    // bloccare l'uscita. Electron può comunque terminare l'host prima: l'ordine con la chiusura dell'app lo gestisce il main (LAD-54).
    const closing = remote ? Promise.race([remote.setMacState('quit').then(() => remote?.close()), new Promise<void>((resolve) => setTimeout(resolve, 500))]) : Promise.resolve()
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
