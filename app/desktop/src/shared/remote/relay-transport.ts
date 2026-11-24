// Trasporto del telefono verso il relay (LAD-50): TypeScript puro sul WebSocket globale (Node 24, React Native).
// Ha la stessa forma di un RemoteLink (send / onBytes / onClose) più lo stato del Mac. È sottile: la riconnessione la decide chi lo usa.
// Uso: crea il trasporto, aspetta `onStatus({ online: true })` e solo allora manda il primo messaggio Noise (clientHandshake().start()).
// Ogni `online: true` successivo è un nuovo collegamento con il Mac (tornato dopo un'assenza): l'handshake riparte da capo.
// Il relay non autentica niente: chi parla davvero con il Mac lo stabilisce l'handshake Noise, con la chiave pubblica del Mac.
import type { RemoteMacStatus } from '../protocol.ts'
import { RELAY_MAX_PHONE_MESSAGE, RELAY_PING, RELAY_PING_INTERVAL_MS, RELAY_PONG, relayEndpoint, type RelayToPhone } from './relay-protocol.ts'

export interface RelayTransportOptions {
  /** Indirizzo del relay (wss://…; ws:// solo verso localhost). */
  relayUrl: string
  /** Id del Mac sul relay (dal QR di abbinamento). */
  macId: string
  /** Solo per le prove o per ambienti senza WebSocket globale. */
  WebSocketImpl?: typeof WebSocket
  /** Silenzio massimo dal relay prima di dare la connessione per morta. */
  deadMs?: number
}

export class RelayTransport {
  private readonly ws: WebSocket
  private readonly options: RelayTransportOptions
  private bytesHandlers: ((bytes: Uint8Array) => void)[] = []
  private statusHandlers: ((status: RemoteMacStatus) => void)[] = []
  private closeHandlers: ((code: number, reason: string) => void)[] = []
  private openHandlers: (() => void)[] = []
  private aliveHandlers: (() => void)[] = []
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private lastRx = Date.now()
  private closed = false
  private macStatus: RemoteMacStatus | null = null

  /** Lancia se l'indirizzo non è valido. */
  constructor(options: RelayTransportOptions) {
    this.options = options
    const Impl = options.WebSocketImpl ?? WebSocket
    this.ws = new Impl(relayEndpoint(options.relayUrl, options.macId, 'phone'))
    this.ws.binaryType = 'arraybuffer'
    this.ws.addEventListener('open', () => {
      this.lastRx = Date.now()
      this.pingTimer = setInterval(() => this.ping(), RELAY_PING_INTERVAL_MS)
      for (const handler of this.openHandlers) handler()
    })
    this.ws.addEventListener('message', (event) => {
      this.lastRx = Date.now()
      if (typeof event.data === 'string') this.onText(event.data)
      else if ((event.data as ArrayBuffer).byteLength <= RELAY_MAX_PHONE_MESSAGE) {
        const bytes = new Uint8Array(event.data as ArrayBuffer)
        for (const handler of this.bytesHandlers) handler(bytes)
      }
    })
    this.ws.addEventListener('close', (event) => this.finish(event.code, event.reason))
    this.ws.addEventListener('error', () => {
      // Dopo un errore arriva sempre un close.
    })
  }

  /** Ultimo stato del Mac noto, o null prima del primo messaggio del relay. */
  get status(): RemoteMacStatus | null {
    return this.macStatus
  }

  /** Un messaggio Noise verso il Mac. Se il Mac è offline il relay lo scarta: aspetta `online: true`. */
  send(bytes: Uint8Array): void {
    if (this.closed || this.ws.readyState !== 1) throw new Error('Relay connection is not open.')
    this.ws.send(bytes as Uint8Array<ArrayBuffer>)
  }

  close(): void {
    if (this.closed) return
    try {
      this.ws.close(1000)
    } catch {
      // già chiuso
    }
    this.finish(1000, 'closed')
  }

  buffered(): number {
    return this.ws.bufferedAmount
  }

  onBytes(handler: (bytes: Uint8Array) => void): void {
    this.bytesHandlers.push(handler)
  }

  /** Stato del Mac: arriva alla connessione e a ogni cambio (partenza, ritorno, sospensione). */
  onStatus(handler: (status: RemoteMacStatus) => void): void {
    this.statusHandlers.push(handler)
  }

  /** Il relay è raggiungibile (il Mac può non esserlo: vedi onStatus). */
  onOpen(handler: () => void): void {
    this.openHandlers.push(handler)
  }

  /** Il relay ha risposto al ping: la connessione è viva. */
  onAlive(handler: () => void): void {
    this.aliveHandlers.push(handler)
  }

  /** Connessione chiusa (da noi, dal relay o per rete sparita), con codice e motivo di chiusura. */
  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandlers.push(handler)
  }

  private onText(text: string): void {
    if (text === RELAY_PONG) {
      for (const handler of this.aliveHandlers) handler()
      return
    }
    let message: RelayToPhone
    try {
      message = JSON.parse(text) as RelayToPhone
    } catch {
      return
    }
    if (message.t !== 'mac') return
    const status: RemoteMacStatus = message.online ? { online: true } : { online: false, since: message.since, reason: message.reason }
    this.macStatus = status
    for (const handler of this.statusHandlers) handler(status)
  }

  /** Keepalive: il relay risponde `pong` da solo; se tace troppo a lungo, la rete è sparita e si chiude. */
  private ping(): void {
    if (Date.now() - this.lastRx > (this.options.deadMs ?? RELAY_PING_INTERVAL_MS * 2.5)) {
      try {
        this.ws.close()
      } catch {
        // già chiuso
      }
      return this.finish(1006, 'relay silent')
    }
    try {
      this.ws.send(RELAY_PING)
    } catch {
      // il close arriva da solo
    }
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    for (const handler of this.closeHandlers) handler(code, reason)
  }
}
