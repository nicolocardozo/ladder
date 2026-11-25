// Remote channel of the host: ties together the gateway, the local test WebSocket (LADDER_REMOTE_PORT) and the relay.
// The gateway (and therefore the identity) exists as long as at least one of the two transports is on.
import { hostname } from 'node:os'
import { REMOTE_DEFAULT_RELAY_URL, type HostCommand, type HostPrefs, type PushEvent, type RemoteDeviceInfo, type RemoteLogEntry, type RemoteLogPage, type RemotePairStart, type RemoteStatus } from '../../shared/protocol.ts'
import { t } from '../../shared/i18n.ts'
import { keyFingerprint, pushMacId, toBase64Url } from '../../shared/remote/pairing.ts'
import type { NoiseKeyPair } from '../../shared/remote/noise.ts'
import type { Db } from '../db.ts'
import { RemoteAccess } from './access.ts'
import { PushService } from './push.ts'
import { RemoteGateway, type RemoteHostApi } from './gateway.ts'
import { loadOrCreateIdentity, loadOrCreateRelayKey, peekIdentityKey, regenerateIdentity, regenerateRelayKey, type RelayKeyPair } from './identity.ts'
import { RelayClient } from './relay-client.ts'
import { startLocalWsServer } from './ws-server.ts'
import type { MacLiveState } from '../../shared/remote/relay-protocol.ts'

export interface RemoteChannelOptions {
  host: RemoteHostApi
  /** Host database: paired devices and the log of remote actions. */
  db: Db
  /** App data folder (identity and relay key). */
  dataDir: string
  appVersion: string
  /** Connected phones, on every change (the channel also reports zero when it turns off). */
  onClients?: (count: number) => void
  /** The state changed (channel on or off, devices, connections, QR, password, "Allow Full"). */
  onStatus?: (status: RemoteStatus) => void
  /** A phone has just paired. */
  onPaired?: (device: RemoteDeviceInfo) => void
  /** New entry in the log of remote actions. */
  onLog?: (entry: RemoteLogEntry) => void
}

/** Window `remote.*` commands. */
export type RemoteWindowCommand = Extract<HostCommand, { type: `remote.${string}` }>

export const isRemoteWindowCommand = (command: HostCommand): command is RemoteWindowCommand => command.type.startsWith('remote.')

/** Mac name without control characters and of limited length. */
export function macNameOf(): string {
  return hostname().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'Mac'
}

/** Relay to use: LADDER_RELAY_URL (development only) takes precedence over the preferences; off if neither asks for it. */
/** How long to wait for the relay, at most, to notify it of the new key. */
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
  /** Push notifications to the phones, via Expo. */
  private readonly push: PushService
  private localStarted = false
  private busy: Promise<void> = Promise.resolve()
  /** The Mac is sleeping or quitting (setMacState): also applies to a new relay, if the address changes. */
  private macPaused = false

  constructor(options: RemoteChannelOptions) {
    this.options = options
    this.access = new RemoteAccess(options.db, {
      onChange: () => this.emitStatus(),
      onPaired: (device) => options.onPaired?.(this.access.infoOf(device, true))
    })
    this.push = new PushService({
      access: this.access,
      macId: () => this.macId(),
      foreground: () => this.gateway_?.foregroundDevices() ?? new Set<string>(),
      log: (message) => console.log(`[remote] ${message}`)
    })
  }

  /** Mac id in the push data: derived from the Mac key (pushMacId), the same on every transport and without revealing the relay id. */
  private macId(): string {
    return this.identity ? pushMacId(toBase64Url(this.identity.publicKey)) : ''
  }

  /** The main process decided the event goes to the phones; with the channel off nothing is sent. */
  notifyPhones(event: PushEvent): void {
    void this.push.notify(event)
  }

  /** State for the window (Settings → Devices and the indicator in the top bar). */
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

  /** Window `remote.*` commands. They do not go through the gateway: the phone cannot reach them. */
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
    // A QR with no route to the Mac (relay not started and no local WebSocket) would be rejected by the phone.
    if (!(this.relay && this.relayUrl) && !this.local) throw new Error(t('Cannot reach the relay right now. Check the relay address in Settings and try again.'))
    const start = this.access.startPairing({
      macName: macNameOf(),
      key: this.identity.publicKey,
      ...(this.relay && this.relayUrl ? { relay: this.relayUrl, id: this.relay.id } : {}),
      // The local WebSocket exists only in development (LADDER_REMOTE_PORT is removed from the environment in packaged builds).
      ...(this.local ? { ws: `ws://127.0.0.1:${this.local.port}` } : {})
    })
    this.emitStatus()
    return start
  }

  /**
   * "Regenerate key": new identity and new relay key (hence a new id), cancels the QR, revokes every device and
   * closes every connection; the relay restarts with the new key. Queued with `configure`.
   */
  regenerateKey(): Promise<void> {
    return this.queued(async () => {
      this.access.cancelPairing()
      this.access.revokeAll()
      this.gateway_?.disconnectAll()
      // The relay remembers on the old id that the key changed: a phone that connects later knows, instead of believing
      // the Mac is just off. Best effort: with the relay unreachable, regeneration is not blocked.
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

  /** Tells the relay (on the old id) that the Mac is changing key; waits at most REKEY_NOTICE_MS and never throws. */
  private async announceRekey(): Promise<void> {
    const relay = this.relay
    if (!relay) return
    try {
      await Promise.race([relay.setMacState('rekeyed'), new Promise<void>((resolve) => setTimeout(resolve, REKEY_NOTICE_MS))])
    } catch {
      // relay unreachable: regenerate anyway
    }
  }

  /** Runs `fn` queued with configure, regeneration and QR creation (the QR is never created with a half-built identity); the error goes to the caller. */
  private queued<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.busy.then(fn)
    this.busy = run.then(
      () => undefined,
      (error) => console.error('[remote] operazione non riuscita', error instanceof Error ? error.message : String(error))
    )
    return run
  }

  /** The gateway for host events, or null when the channel is off. */
  get gateway(): RemoteGateway | null {
    return this.gateway_
  }

  /** Mac id on the relay, if the relay is on (for pairing). */
  get relayId(): string | null {
    return this.relay?.id ?? null
  }

  /** Brings the channel to the wanted state; calls are queued. */
  configure(remote: HostPrefs['remote']): Promise<void> {
    this.busy = this.busy.then(() => this.apply(remote)).catch((error) => console.error('[remote] configurazione non riuscita', error instanceof Error ? error.message : String(error)))
    return this.busy
  }

  /** For power management: tells the relay whether the Mac is sleeping, quitting or awake. */
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
    this.push.stop()
  }

  private async apply(remote: HostPrefs['remote']): Promise<void> {
    this.lastRemote = remote
    const allowFull = remote?.allowFull !== false
    const allowFullChanged = allowFull !== this.access.allowFull
    this.access.allowFull = allowFull
    const url = relayUrlFor(remote, process.env.LADDER_RELAY_URL)
    const localPort = this.localPort()
    this.access.enabled = url !== null || localPort !== null
    // Gateway and identity only if at least one transport is needed.
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

  /** Port of the local test WebSocket, or null if LADDER_REMOTE_PORT is missing or invalid. */
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
