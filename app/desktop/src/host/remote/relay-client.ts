// Relay client: one outbound connection to the relay, identified by the Mac's id, carrying all the phones.
// Each phone becomes a RemoteLink handed to the gateway: the gateway does not know whether the bytes come from the local WebSocket or from here.
// It reconnects on its own (exponential backoff with jitter); message format: shared/remote/relay-protocol.ts.
// Relative imports (no @shared alias): the file is tested in-process with `node --test`.
import {
  decodeFrame,
  encodeFrame,
  RELAY_FRAME_CLOSE,
  RELAY_FRAME_DATA,
  RELAY_FRAME_OPEN,
  RELAY_MAX_MAC_MESSAGE,
  RELAY_PING,
  RELAY_PING_INTERVAL_MS,
  RELAY_PONG,
  relayEndpoint,
  relayOrigin,
  relayIdFromPublicKey,
  signAuth,
  type MacLiveState,
  type RelayToMac
} from '../../shared/remote/relay-protocol.ts'
import type { RemoteLink } from './gateway.ts'
import type { RelayKeyPair } from './identity.ts'

export type RelayStatus = 'stopped' | 'connecting' | 'connected' | 'paused'

export interface RelayClientOptions {
  /** What the client uses of the gateway. */
  gateway: { accept(link: RemoteLink): void }
  /** Relay address (wss://…). */
  relayUrl: string
  key: RelayKeyPair
  log?: (message: string) => void
  /** Tests only. */
  minBackoffMs?: number
  maxBackoffMs?: number
  pingMs?: number
  /** Maximum silence from the relay before the connection is considered dead. */
  deadMs?: number
  random?: () => number
  /** Starts paused (as after setMacState('asleep')): no connection until 'awake' arrives. */
  paused?: boolean
}

const AUTH_TIMEOUT_MS = 10_000
/** A connection that lasted less than this does not reset the backoff (avoids a rapid loop when the relay drops us right away). */
const STABLE_MS = 5_000
/** Close 4001: another Mac with the same key took over; retry calmly. */
const CLOSE_REPLACED = 4001

/** The phone as seen by the Mac: one DATA frame per Noise message. */
class PhoneLink implements RemoteLink {
  private bytesHandler: ((bytes: Uint8Array) => void) | null = null
  private closeHandler: (() => void) | null = null
  private aliveHandler: (() => void) | null = null
  closed = false
  readonly connId: number
  private readonly client: RelayClient

  // No parameter properties: the file runs with `node --test` (erasable TypeScript syntax only).
  constructor(connId: number, client: RelayClient) {
    this.connId = connId
    this.client = client
  }

  send(bytes: Uint8Array): void {
    if (!this.closed) this.client.sendFrame(RELAY_FRAME_DATA, this.connId, bytes)
  }

  /** Close decided by the gateway: the relay closes the phone. Does not call onClose (the gateway already closed). */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.client.release(this)
    this.client.sendFrame(RELAY_FRAME_CLOSE, this.connId)
  }

  onBytes(handler: (bytes: Uint8Array) => void): void {
    this.bytesHandler = handler
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  onAlive(handler: () => void): void {
    this.aliveHandler = handler
  }

  buffered(): number {
    return this.client.buffered()
  }

  // From the relay
  receive(bytes: Uint8Array): void {
    if (!this.closed) this.bytesHandler?.(bytes)
  }

  alive(): void {
    if (!this.closed) this.aliveHandler?.()
  }

  /** The phone left, or the relay dropped. */
  remoteClosed(): void {
    if (this.closed) return
    this.closed = true
    this.closeHandler?.()
  }
}

export class RelayClient {
  /** Mac id on the relay: derived from the public key. */
  readonly id: string
  private readonly options: RelayClientOptions
  private readonly endpoint: string
  private readonly origin: string
  private readonly links = new Map<number, PhoneLink>()
  private ws: WebSocket | null = null
  private ready = false
  private readyAt = 0
  private lastRx = 0
  private attempts = 0
  private started = false
  private paused = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private authTimer: ReturnType<typeof setTimeout> | null = null
  private replaced = false

  /** Throws if the address is invalid (scheme other than wss://, or non-local ws://). */
  constructor(options: RelayClientOptions) {
    this.options = options
    this.id = relayIdFromPublicKey(options.key.publicKey)
    this.endpoint = relayEndpoint(options.relayUrl, this.id, 'mac')
    this.origin = relayOrigin(options.relayUrl)
  }

  get status(): RelayStatus {
    if (!this.started) return 'stopped'
    if (this.paused) return 'paused'
    return this.ready ? 'connected' : 'connecting'
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.paused = this.options.paused ?? false
    if (!this.paused) this.connect()
  }

  /** Clean shutdown: closes the socket and the phone links, no reconnection. */
  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.clearReconnect()
    await this.shutSocket(1000, 'stopped')
  }

  /**
   * Tells the relay what is about to happen to the Mac (phones see it as a state): 'asleep', 'quit' and 'rekeyed' (the key is about to
   * be regenerated: the Mac will not come back under this id) close the link and suspend reconnection, 'awake' resumes it at once. The caller wires it to powerMonitor and to app exit.
   */
  async setMacState(state: MacLiveState): Promise<void> {
    if (!this.started) return
    if (state === 'awake') {
      if (!this.paused) return
      this.paused = false
      this.attempts = 0
      this.clearReconnect()
      if (!this.ws) this.connect()
      return
    }
    this.paused = true
    this.clearReconnect()
    if (this.ws && this.ready) this.sendJson({ t: 'state', state })
    await this.shutSocket(1000, state)
  }

  // ── Internal, also used by PhoneLink ─────────────────────────────────────

  sendFrame(type: number, connId: number, payload?: Uint8Array): void {
    if (!this.ws || !this.ready) return
    try {
      this.ws.send(encodeFrame(type, connId, payload))
    } catch {
      // socket closing: the reconnection cleans up
    }
  }

  release(link: PhoneLink): void {
    if (this.links.get(link.connId) === link) this.links.delete(link.connId)
  }

  buffered(): number {
    return this.ws?.bufferedAmount ?? 0
  }

  // ── Connection ───────────────────────────────────────────────────────────

  private connect(): void {
    if (!this.started || this.paused || this.ws) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.endpoint)
    } catch (error) {
      this.options.log?.(`relay connection failed: ${error instanceof Error ? error.message : String(error)}`)
      return this.scheduleReconnect()
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.ready = false
    this.replaced = false
    this.authTimer = setTimeout(() => this.abandon(ws, 'auth timeout'), AUTH_TIMEOUT_MS)
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return
      this.lastRx = Date.now()
      if (typeof event.data === 'string') this.onText(ws, event.data)
      else this.onBinary(event.data as ArrayBuffer)
    })
    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return
      this.replaced = event.code === CLOSE_REPLACED
      this.down(ws, event.code === 1000 ? undefined : `closed (${event.code})`)
    })
    ws.addEventListener('error', () => {
      // After an error a close always follows; nothing else to do here.
    })
  }

  private onText(ws: WebSocket, text: string): void {
    if (text === RELAY_PONG) {
      for (const link of this.links.values()) link.alive()
      return
    }
    let message: RelayToMac
    try {
      message = JSON.parse(text) as RelayToMac
    } catch {
      return
    }
    if (message.t === 'challenge' && typeof message.nonce === 'string' && !this.ready) {
      this.sendJson(signAuth(this.options.key.secretKey, this.origin, this.id, message.nonce))
    } else if (message.t === 'ready' && !this.ready) {
      this.ready = true
      this.readyAt = Date.now()
      if (this.authTimer) clearTimeout(this.authTimer)
      this.authTimer = null
      this.lastRx = Date.now()
      this.pingTimer = setInterval(() => this.ping(ws), this.options.pingMs ?? RELAY_PING_INTERVAL_MS)
      this.options.log?.('relay connected')
    }
  }

  private onBinary(data: ArrayBuffer): void {
    if (!this.ready || data.byteLength > RELAY_MAX_MAC_MESSAGE) return
    const frame = decodeFrame(new Uint8Array(data))
    if (!frame) return
    if (frame.type === RELAY_FRAME_OPEN) {
      this.links.get(frame.connId)?.remoteClosed()
      const link = new PhoneLink(frame.connId, this)
      this.links.set(frame.connId, link)
      this.options.gateway.accept(link)
    } else if (frame.type === RELAY_FRAME_DATA) {
      this.links.get(frame.connId)?.receive(frame.payload)
    } else if (frame.type === RELAY_FRAME_CLOSE) {
      const link = this.links.get(frame.connId)
      this.links.delete(frame.connId)
      link?.remoteClosed()
    }
  }

  private sendJson(message: unknown): void {
    try {
      this.ws?.send(JSON.stringify(message))
    } catch {
      // see sendFrame
    }
  }

  /** Keepalive: a text ping, which the relay answers by itself; if nothing arrives any more, the connection is dead. */
  private ping(ws: WebSocket): void {
    if (this.ws !== ws) return
    if (Date.now() - this.lastRx > (this.options.deadMs ?? RELAY_PING_INTERVAL_MS * 2.5)) return this.abandon(ws, 'relay silent')
    try {
      ws.send(RELAY_PING)
    } catch {
      this.abandon(ws, 'send failed')
    }
  }

  /** Connection dead without the close arriving (network vanished): it is dropped without waiting for the closing handshake. */
  private abandon(ws: WebSocket, reason: string): void {
    if (this.ws !== ws) return
    try {
      ws.close()
    } catch {
      // already closed
    }
    this.down(ws, reason)
  }

  /** The socket is gone: phones drop (the gateway closes them) and, unless paused or stopped, it retries. */
  private down(ws: WebSocket, reason?: string): void {
    if (this.ws !== ws) return
    this.ws = null
    const stable = this.ready && Date.now() - this.readyAt >= STABLE_MS
    this.ready = false
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.authTimer) clearTimeout(this.authTimer)
    this.pingTimer = this.authTimer = null
    const links = [...this.links.values()]
    this.links.clear()
    for (const link of links) link.remoteClosed()
    if (reason) this.options.log?.(`relay disconnected: ${reason}`)
    if (stable) this.attempts = 0
    if (this.started && !this.paused) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.started || this.paused) return
    const min = this.options.minBackoffMs ?? 250
    const max = this.options.maxBackoffMs ?? 30_000
    // Exponential with a cap; jitter between half and the whole, so several Macs do not show up together.
    const base = this.replaced ? max : Math.min(max, min * 2 ** this.attempts)
    const delay = Math.round(base * (0.5 + 0.5 * (this.options.random ?? Math.random)()))
    this.attempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  /** Closes the socket (if any) and waits for the close, at most one second. */
  private async shutSocket(code: number, reason: string): Promise<void> {
    const ws = this.ws
    if (!ws) return
    const closed = new Promise<void>((resolve) => {
      ws.addEventListener('close', () => resolve())
      setTimeout(resolve, 1000).unref()
    })
    try {
      ws.close(code, reason)
    } catch {
      // already closed
    }
    await closed
    this.down(ws)
  }
}
