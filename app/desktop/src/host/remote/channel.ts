// Canale remoto dell'host: tiene insieme gateway, WebSocket locale di prova (LADDER_REMOTE_PORT) e relay (LAD-50).
// Il gateway (e quindi l'identità) esiste finché almeno uno dei due trasporti è acceso.
import { hostname } from 'node:os'
import { REMOTE_DEFAULT_RELAY_URL, type HostPrefs } from '../../shared/protocol.ts'
import { RemoteGateway, type RemoteHostApi } from './gateway.ts'
import { loadOrCreateIdentity, loadOrCreateRelayKey, type RelayKeyPair } from './identity.ts'
import { RelayClient } from './relay-client.ts'
import { startLocalWsServer } from './ws-server.ts'
import type { MacLiveState } from '../../shared/remote/relay-protocol.ts'

export interface RemoteChannelOptions {
  host: RemoteHostApi
  /** Cartella dati dell'app (identità e chiave del relay). */
  dataDir: string
  appVersion: string
  /** LAD-54: telefoni collegati, a ogni cambiamento (il canale ne riporta anche lo zero quando si spegne). */
  onClients?: (count: number) => void
}

/** Relay da usare: LADDER_RELAY_URL (solo sviluppo) vale più delle preferenze; spento se né l'uno né le altre lo chiedono. */
export function relayUrlFor(remote: HostPrefs['remote'], env: string | undefined): string | null {
  if (env) return env
  if (!remote?.enabled) return null
  return remote.relayUrl ?? REMOTE_DEFAULT_RELAY_URL
}

export class RemoteChannel {
  private readonly options: RemoteChannelOptions
  private gateway_: RemoteGateway | null = null
  private relay: RelayClient | null = null
  private relayUrl: string | null = null
  private relayKey: RelayKeyPair | null = null
  private local: { stop: () => void } | null = null
  private localStarted = false
  private busy: Promise<void> = Promise.resolve()
  /** Il Mac dorme o sta uscendo (setMacState): vale anche per un relay nuovo, se l'indirizzo cambia. */
  private macPaused = false

  constructor(options: RemoteChannelOptions) {
    this.options = options
  }

  /** Il gateway per gli eventi dell'host, o null a canale spento. */
  get gateway(): RemoteGateway | null {
    return this.gateway_
  }

  /** Id del Mac sul relay, se il relay è acceso (per l'abbinamento, LAD-51). */
  get relayId(): string | null {
    return this.relay?.id ?? null
  }

  /** Porta il canale allo stato voluto; le chiamate si mettono in fila. */
  configure(remote: HostPrefs['remote']): Promise<void> {
    this.busy = this.busy.then(() => this.apply(remote)).catch((error) => console.error('[remote] configurazione non riuscita', error instanceof Error ? error.message : String(error)))
    return this.busy
  }

  /** Per l'energia (LAD-54): dice al relay se il Mac dorme, esce o è sveglio. */
  setMacState(state: MacLiveState): Promise<void> {
    this.macPaused = state !== 'awake'
    return this.relay?.setMacState(state) ?? Promise.resolve()
  }

  async close(): Promise<void> {
    await this.busy
    await this.relay?.stop()
    this.relay = null
    this.local?.stop()
    this.local = null
    this.gateway_?.close()
    this.gateway_ = null
  }

  private async apply(remote: HostPrefs['remote']): Promise<void> {
    const url = relayUrlFor(remote, process.env.LADDER_RELAY_URL)
    const localPort = this.localPort()
    // Gateway e identità solo se serve almeno un trasporto.
    if (url === null && localPort === null) {
      await this.relay?.stop()
      this.relay = null
      this.relayUrl = null
      this.local?.stop()
      this.local = null
      this.localStarted = false
      this.gateway_?.close()
      this.gateway_ = null
      return
    }
    if (!this.gateway_) {
      const identity = loadOrCreateIdentity(this.options.dataDir)
      // Nome del Mac senza caratteri di controllo e di lunghezza limitata.
      const macName = hostname().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'Mac'
      this.gateway_ = new RemoteGateway({ host: this.options.host, identity, macName, appVersion: this.options.appVersion, onClients: this.options.onClients, log: (message) => console.log(`[remote] ${message}`) })
    }
    if (localPort !== null && !this.localStarted) {
      this.localStarted = true
      try {
        const server = await startLocalWsServer(this.gateway_, localPort)
        this.local = server
        console.log(`[remote] in ascolto su 127.0.0.1:${server.port}`)
      } catch (error) {
        this.localStarted = false
        console.error('[remote] server locale non avviato', error instanceof Error ? error.message : String(error))
      }
    }
    if (url !== this.relayUrl) {
      await this.relay?.stop()
      this.relay = null
      this.relayUrl = url
      if (url !== null) this.startRelay(url)
    }
  }

  private startRelay(url: string): void {
    try {
      this.relayKey ??= loadOrCreateRelayKey(this.options.dataDir)
      const client = new RelayClient({ gateway: this.gateway_!, relayUrl: url, key: this.relayKey, paused: this.macPaused, log: (message) => console.log(`[remote] ${message}`) })
      client.start()
      this.relay = client
      console.log(`[remote] relay ${new URL(url).host}, id ${client.id}`)
    } catch (error) {
      this.relayUrl = null
      console.error('[remote] relay non avviato', error instanceof Error ? error.message : String(error))
    }
  }

  /** Porta del WebSocket locale di prova, o null se LADDER_REMOTE_PORT manca o non è valida. */
  private localPort(): number | null {
    const raw = process.env.LADDER_REMOTE_PORT
    if (!raw) return null
    const port = Number(raw)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error('[remote] LADDER_REMOTE_PORT non valida, WebSocket locale spento')
      return null
    }
    return port
  }
}
