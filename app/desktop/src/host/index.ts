// Host delle sessioni: gira in un utilityProcess di Electron, separato dalla UI.
// Il processo main gli passa una MessagePort per ogni finestra; l'host risponde ai comandi e trasmette gli eventi.
import type { MessagePortMain } from 'electron'
import type { FromHost, HostEvent, HostToMain, MainToHost, ToHost } from '@shared/protocol'
import '@shared/locales/it'
import { openDb } from './db'
import { Host } from './sessions'

const ports = new Set<MessagePortMain>()

function post(port: MessagePortMain, message: FromHost): void {
  try {
    port.postMessage(message)
  } catch {
    ports.delete(port)
  }
}

function broadcast(event: HostEvent): void {
  for (const port of ports) post(port, { kind: 'event', event })
}

async function main(): Promise<void> {
  const dbPath = process.env.LADDER_DB_PATH
  if (!dbPath) throw new Error('LADDER_DB_PATH mancante')
  // Notifiche e badge li mostra il main: qui partono solo gli eventi.
  const toMain = (message: HostToMain) => process.parentPort.postMessage(message)
  const host = new Host(openDb(dbPath), broadcast, toMain)
  // Le preferenze arrivano prima dell'avvio (variabile d'ambiente) e poi a ogni cambio.
  if (process.env.LADDER_HOST_PREFS) host.setPrefs(JSON.parse(process.env.LADDER_HOST_PREFS))
  await host.init()

  process.parentPort.on('message', (event) => {
    const message = event.data as MainToHost | undefined
    if (message?.type === 'prefs') {
      host.setPrefs(message.prefs)
      return
    }
    const [port] = event.ports
    if (!port) return
    ports.add(port)
    port.on('message', async ({ data }) => {
      const { rid, command } = data as ToHost
      try {
        const result = await host.handle(command)
        if (rid) post(port, { kind: 'result', rid, ok: true, data: result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[host] ${command.type}: ${message}`)
        if (rid) post(port, { kind: 'result', rid, ok: false, error: message })
      }
    })
    port.on('close', () => ports.delete(port))
    port.start()
  })

  const stop = () => {
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
