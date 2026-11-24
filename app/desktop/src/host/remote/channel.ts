// Canale remoto dell'host: tiene insieme gateway, WebSocket locale di prova (LADDER_REMOTE_PORT) e relay (LAD-50).
// Il gateway (e quindi l'identità) esiste finché almeno uno dei due trasporti è acceso.
import { hostname } from 'node:os'
import { REMOTE_DEFAULT_RELAY_URL, type HostCommand, type HostPrefs, type RemoteDeviceInfo, type RemoteLogEntry, type RemoteLogPage, type RemotePairStart, type RemoteStatus } from '../../shared/protocol.ts'
import { t } from '../../shared/i18n.ts'
import { keyFingerprint } from '../../shared/remote/pairing.ts'
import type { NoiseKeyPair } from '../../shared/remote/noise.ts'
import type { Db } from '../db.ts'
import { RemoteAccess } from './access.ts'
import { RemoteGateway, type RemoteHostApi } from './gateway.ts'
import { loadOrCreateIdentity, loadOrCreateRelayKey, peekIdentityKey, regenerateIdentity, regenerateRelayKey, type RelayKeyPair } from './identity.ts'
import { RelayClient } from './relay-client.ts'
import { startLocalWsServer } from './ws-server.ts'
import type { MacLiveState } from '../../shared/remote/relay-protocol.ts'

export interface RemoteChannelOptions {
  host: RemoteHostApi
  /** Database dell'host: dispositivi abbinati e log delle azioni remote (LAD-51). */
  db: Db
  /** Cartella dati dell'app (identità e chiave del relay). */
  dataDir: string
  appVersion: string
  /** LAD-54: telefoni collegati, a ogni cambiamento (il canale ne riporta anche lo zero quando si spegne). */
  onClients?: (count: number) => void
  /** LAD-51: lo stato è cambiato (canale acceso o spento, dispositivi, collegamenti, QR, password, "Allow Full"). */
  onStatus?: (status: RemoteStatus) => void
  /** LAD-51: un telefono si è appena abbinato. */
  onPaired?: (device: RemoteDeviceInfo) => void
  /** LAD-51: nuova voce nel log delle azioni remote. */
  onLog?: (entry: RemoteLogEntry) => void
}

/** Comandi `remote.*` della finestra (LAD-51). */
export type RemoteWindowCommand = Extract<HostCommand, { type: `remote.${string}` }>

export const isRemoteWindowCommand = (command: HostCommand): command is RemoteWindowCommand => command.type.startsWith('remote.')

/** Nome del Mac senza caratteri di controllo e di lunghezza limitata. */
export function macNameOf(): string {
  return hostname().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'Mac'
}

/** Relay da usare: LADDER_RELAY_URL (solo sviluppo) vale più delle preferenze; spento se né l'uno né le altre lo chiedono. */
/** Quanto si aspetta il relay, al massimo, per avvisarlo della nuova chiave. */
const REKEY_NOTICE_MS = 1_500

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
  private local: { stop: () => void; port: number } | null = null
  private identity: NoiseKeyPair | null = null
  private lastRemote: HostPrefs['remote'] = undefined
  readonly access: RemoteAccess
  private localStarted = false
  private busy: Promise<void> = Promise.resolve()
  /** Il Mac dorme o sta uscendo (setMacState): vale anche per un relay nuovo, se l'indirizzo cambia. */
  private macPaused = false

  constructor(options: RemoteChannelOptions) {
    this.options = options
    this.access = new RemoteAccess(options.db, {
      onChange: () => this.emitStatus(),
      onPaired: (device) => options.onPaired?.(this.access.infoOf(device, true))
    })
  }

  /** Stato per la finestra (Impostazioni → Dispositivi e indicatore nella barra in alto). */
  status(): RemoteStatus {
    const connected = this.gateway_?.connectedDevices() ?? new Set<string>()
    let key = this.identity?.publicKey ?? null
    if (!key) {
      try {
        key = peekIdentityKey(this.options.dataDir)
      } catch {
        key = null
      }
    }
    return {
      enabled: this.access.enabled,
      relayUrl: this.relay ? this.relayUrl : null,
      relayId: this.relay?.id ?? null,
      macName: macNameOf(),
      fingerprint: key ? keyFingerprint(key) : null,
      hasPassword: this.access.hasPassword(),
      allowFull: this.access.allowFull,
      devices: this.access.info(connected),
      connectedCount: connected.size,
      pairing: this.access.pairing()
    }
  }

  private emitStatus(): void {
    try {
      this.options.onStatus?.(this.status())
    } catch (error) {
      console.error('[remote] stato', error instanceof Error ? error.message : String(error))
    }
  }

  /** Comandi `remote.*` della finestra. Non passano dal gateway: dal telefono non si raggiungono. */
  async handleCommand(command: RemoteWindowCommand): Promise<unknown> {
    switch (command.type) {
      case 'remote.status':
        return this.status()
      case 'remote.pair.start':
        return this.queued(() => this.startPairing())
      case 'remote.pair.cancel':
        this.access.cancelPairing()
        return null
      case 'remote.password.set':
        await this.access.setPassword(command.password)
        this.emitStatus()
        return null
      case 'remote.device.revoke':
        if (!this.access.revoke(command.deviceId)) throw new Error(t('Device not found.'))
        this.gateway_?.disconnectDevice(command.deviceId)
        this.emitStatus()
        return null
      case 'remote.device.rename':
        this.gateway_?.deviceRenamed(command.deviceId, this.access.rename(command.deviceId, command.name))
        this.emitStatus()
        return null
      case 'remote.key.regenerate':
        await this.regenerateKey()
        return null
      case 'remote.log.list':
        return this.logPage(command.before, command.limit)
    }
  }

  private logPage(before?: number, limit?: number): RemoteLogPage {
    return this.access.list(typeof before === 'number' ? before : undefined, typeof limit === 'number' ? limit : undefined)
  }

  private startPairing(): RemotePairStart {
    if (!this.access.enabled || !this.identity) throw new Error(t('Access from your phone is turned off.'))
    // Un QR senza strada per il Mac (relay non partito e niente WebSocket locale) il telefono lo rifiuterebbe.
    if (!(this.relay && this.relayUrl) && !this.local) throw new Error(t('Cannot reach the relay right now. Check the relay address in Settings and try again.'))
    const start = this.access.startPairing({
      macName: macNameOf(),
      key: this.identity.publicKey,
      ...(this.relay && this.relayUrl ? { relay: this.relayUrl, id: this.relay.id } : {}),
      // Il WebSocket locale esiste solo in sviluppo (LADDER_REMOTE_PORT è tolta dall'ambiente nelle build pacchettizzate).
      ...(this.local ? { ws: `ws://127.0.0.1:${this.local.port}` } : {})
    })
    this.emitStatus()
    return start
  }

  /**
   * "Rigenera chiave": nuova identità e nuova chiave del relay (quindi nuovo id), annulla il QR, revoca ogni dispositivo e
   * chiude ogni connessione; il relay riparte con la chiave nuova. In fila con `configure`.
   */
  regenerateKey(): Promise<void> {
    return this.queued(async () => {
      this.access.cancelPairing()
      this.access.revokeAll()
      this.gateway_?.disconnectAll()
      // Il relay ricorda sul vecchio id che la chiave è cambiata: un telefono che si collega più tardi lo sa, invece di credere
      // il Mac solo spento. Al meglio: con il relay irraggiungibile non si blocca la rigenerazione.
      await this.announceRekey()
      await this.relay?.stop()
      this.relay = null
      this.relayUrl = null
      this.identity = regenerateIdentity(this.options.dataDir)
      this.relayKey = regenerateRelayKey(this.options.dataDir)
      this.gateway_?.setIdentity(this.identity)
      await this.apply(this.lastRemote)
    })
  }

  /** Dice al relay (sul vecchio id) che il Mac cambia chiave; attende al massimo REKEY_NOTICE_MS e non lancia mai. */
  private async announceRekey(): Promise<void> {
    const relay = this.relay
    if (!relay) return
    try {
      await Promise.race([relay.setMacState('rekeyed'), new Promise<void>((resolve) => setTimeout(resolve, REKEY_NOTICE_MS))])
    } catch {
      // relay irraggiungibile: si rigenera lo stesso
    }
  }

  /** Esegue `fn` in fila con configure, rigenerazione e creazione del QR (il QR non nasce con l'identità a metà); l'errore va a chi chiama. */
  private queued<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.busy.then(fn)
    this.busy = run.then(
      () => undefined,
      (error) => console.error('[remote] operazione non riuscita', error instanceof Error ? error.message : String(error))
    )
    return run
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
    this.lastRemote = remote
    const allowFull = remote?.allowFull !== false
    const allowFullChanged = allowFull !== this.access.allowFull
    this.access.allowFull = allowFull
    const url = relayUrlFor(remote, process.env.LADDER_RELAY_URL)
    const localPort = this.localPort()
    this.access.enabled = url !== null || localPort !== null
    // Gateway e identità solo se serve almeno un trasporto.
    if (url === null && localPort === null) {
      this.access.cancelPairing()
      await this.relay?.stop()
      this.relay = null
      this.relayUrl = null
      this.local?.stop()
      this.local = null
      this.localStarted = false
      this.gateway_?.close()
      this.gateway_ = null
      this.emitStatus()
      return
    }
    if (!this.gateway_) {
      this.identity ??= loadOrCreateIdentity(this.options.dataDir)
      this.gateway_ = new RemoteGateway({
        host: this.options.host,
        identity: this.identity,
        access: this.access,
        macName: macNameOf(),
        appVersion: this.options.appVersion,
        onClients: this.options.onClients,
        onDevices: () => this.emitStatus(),
        onLog: this.options.onLog,
        log: (message) => console.log(`[remote] ${message}`)
      })
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
    if (allowFullChanged) void this.gateway_?.pushPrefs().catch(() => undefined)
    this.emitStatus()
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
