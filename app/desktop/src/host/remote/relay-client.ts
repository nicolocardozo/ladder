// Client del relay (LAD-50): una connessione in uscita verso il relay, identificata dall'id del Mac, che porta tutti i telefoni.
// Ogni telefono diventa un RemoteLink dato al gateway: il gateway non sa se i byte arrivano dal WebSocket locale o da qui.
// Si riconnette da solo (backoff esponenziale con jitter); formato dei messaggi: shared/remote/relay-protocol.ts.
// Import relativi (niente alias @shared): il file è provato in-process con `node --test`.
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
  /** Quello che il client usa del gateway. */
  gateway: { accept(link: RemoteLink): void }
  /** Indirizzo del relay (wss://…). */
  relayUrl: string
  key: RelayKeyPair
  log?: (message: string) => void
  /** Solo per le prove. */
  minBackoffMs?: number
  maxBackoffMs?: number
  pingMs?: number
  /** Silenzio massimo dal relay prima di considerare la connessione morta. */
  deadMs?: number
  random?: () => number
  /** Parte in pausa (come dopo setMacState('asleep')): niente connessione finché non arriva 'awake'. */
  paused?: boolean
}

const AUTH_TIMEOUT_MS = 10_000
/** Una connessione durata meno di così non azzera il backoff (evita il ciclo rapido quando il relay ci scarta subito). */
const STABLE_MS = 5_000
/** Chiusura 4001: un altro Mac con la stessa chiave ha preso il posto; si riprova con calma. */
const CLOSE_REPLACED = 4001

/** Il telefono visto dal Mac: un frame DATA per ogni messaggio Noise. */
class PhoneLink implements RemoteLink {
  private bytesHandler: ((bytes: Uint8Array) => void) | null = null
  private closeHandler: (() => void) | null = null
  private aliveHandler: (() => void) | null = null
  closed = false
  readonly connId: number
  private readonly client: RelayClient

  // Niente parameter properties: il file gira con `node --test` (solo sintassi TypeScript cancellabile).
  constructor(connId: number, client: RelayClient) {
    this.connId = connId
    this.client = client
  }

  send(bytes: Uint8Array): void {
    if (!this.closed) this.client.sendFrame(RELAY_FRAME_DATA, this.connId, bytes)
  }

  /** Chiusura decisa dal gateway: il relay chiude il telefono. Non richiama onClose (il gateway ha già chiuso). */
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

  // Dal relay
  receive(bytes: Uint8Array): void {
    if (!this.closed) this.bytesHandler?.(bytes)
  }

  alive(): void {
    if (!this.closed) this.aliveHandler?.()
  }

  /** Il telefono se n'è andato, o il relay è caduto. */
  remoteClosed(): void {
    if (this.closed) return
    this.closed = true
    this.closeHandler?.()
  }
}

export class RelayClient {
  /** Id del Mac sul relay: derivato dalla chiave pubblica. */
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

  /** Lancia se l'indirizzo non è valido (schema diverso da wss://, o ws:// non locale). */
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

  /** Spegnimento pulito: chiude il socket e i collegamenti dei telefoni, niente riconnessione. */
  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.clearReconnect()
    await this.shutSocket(1000, 'stopped')
  }

  /**
   * Avvisa il relay di cosa sta per succedere al Mac (i telefoni lo vedono come stato): 'asleep', 'quit' e 'rekeyed' (la chiave sta per
   * essere rigenerata: da questo id il Mac non tornerà) chiudono il collegamento e sospendono la riconnessione, 'awake' la riprende subito. Chi chiama (LAD-54) la collega a powerMonitor e all'uscita dell'app.
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

  // ── Interno, usato anche da PhoneLink ────────────────────────────────────

  sendFrame(type: number, connId: number, payload?: Uint8Array): void {
    if (!this.ws || !this.ready) return
    try {
      this.ws.send(encodeFrame(type, connId, payload))
    } catch {
      // socket in chiusura: la riconnessione ripulisce
    }
  }

  release(link: PhoneLink): void {
    if (this.links.get(link.connId) === link) this.links.delete(link.connId)
  }

  buffered(): number {
    return this.ws?.bufferedAmount ?? 0
  }

  // ── Connessione ──────────────────────────────────────────────────────────

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
      // Dopo un errore segue sempre un close; qui non c'è altro da fare.
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
      // vedi sendFrame
    }
  }

  /** Keepalive: un ping di testo, a cui il relay risponde da solo; se non arriva più nulla, la connessione è morta. */
  private ping(ws: WebSocket): void {
    if (this.ws !== ws) return
    if (Date.now() - this.lastRx > (this.options.deadMs ?? RELAY_PING_INTERVAL_MS * 2.5)) return this.abandon(ws, 'relay silent')
    try {
      ws.send(RELAY_PING)
    } catch {
      this.abandon(ws, 'send failed')
    }
  }

  /** Connessione morta senza che il close arrivi (rete sparita): la si molla senza aspettare l'handshake di chiusura. */
  private abandon(ws: WebSocket, reason: string): void {
    if (this.ws !== ws) return
    try {
      ws.close()
    } catch {
      // già chiuso
    }
    this.down(ws, reason)
  }

  /** Il socket non c'è più: i telefoni cadono (il gateway li chiude) e, salvo pausa o stop, si riprova. */
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
    // Esponenziale con tetto; jitter tra metà e il tutto, così più Mac non si ripresentano insieme.
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

  /** Chiude il socket (se c'è) e aspetta la chiusura, al massimo un secondo. */
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
      // già chiuso
    }
    await closed
    this.down(ws)
  }
}
