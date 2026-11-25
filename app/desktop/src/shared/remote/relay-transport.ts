// Phone transport to the relay: plain TypeScript over the global WebSocket (Node 24, React Native).
// It has the same shape as a RemoteLink (send / onBytes / onClose) plus the Mac's status. It is thin: whoever uses it decides how to reconnect.
// Usage: create the transport, wait for `onStatus({ online: true })` and only then send the first Noise message (clientHandshake().start()).
// Every later `online: true` is a new link with the Mac (back after an absence): the handshake starts over from scratch.
// The relay authenticates nothing: the Noise handshake, with the Mac's public key, decides who is really talking to the Mac.
import type { RemoteMacStatus } from '../protocol.ts'
import { RELAY_MAX_PHONE_MESSAGE, RELAY_PING, RELAY_PING_INTERVAL_MS, RELAY_PONG, relayEndpoint, type RelayToPhone } from './relay-protocol.ts'

export interface RelayTransportOptions {
  /** Relay address (wss://…; ws:// only towards localhost). */
  relayUrl: string
  /** Mac id on the relay (from the pairing QR). */
  macId: string
  /** Only for tests or environments without a global WebSocket. */
  WebSocketImpl?: typeof WebSocket
  /** Maximum silence from the relay before the connection is considered dead. */
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

  /** Throws if the address is not valid. */
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
      // A close always follows an error.
    })
  }

  /** Last known Mac status, or null before the relay's first message. */
  get status(): RemoteMacStatus | null {
    return this.macStatus
  }

  /** A Noise message to the Mac. If the Mac is offline the relay drops it: wait for `online: true`. */
  send(bytes: Uint8Array): void {
    if (this.closed || this.ws.readyState !== 1) throw new Error('Relay connection is not open.')
    this.ws.send(bytes as Uint8Array<ArrayBuffer>)
  }

  close(): void {
    if (this.closed) return
    try {
      this.ws.close(1000)
    } catch {
      // already closed
    }
    this.finish(1000, 'closed')
  }

  buffered(): number {
    return this.ws.bufferedAmount
  }

  onBytes(handler: (bytes: Uint8Array) => void): void {
    this.bytesHandlers.push(handler)
  }

  /** Mac status: arrives on connection and on every change (departure, return, suspension). */
  onStatus(handler: (status: RemoteMacStatus) => void): void {
    this.statusHandlers.push(handler)
  }

  /** The relay is reachable (the Mac may not be: see onStatus). */
  onOpen(handler: () => void): void {
    this.openHandlers.push(handler)
  }

  /** The relay answered the ping: the connection is alive. */
  onAlive(handler: () => void): void {
    this.aliveHandlers.push(handler)
  }

  /** Connection closed (by us, by the relay or because the network vanished), with close code and reason. */
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

  /** Keepalive: the relay answers `pong` on its own; if it stays silent too long, the network is gone and we close. */
  private ping(): void {
    if (Date.now() - this.lastRx > (this.options.deadMs ?? RELAY_PING_INTERVAL_MS * 2.5)) {
      try {
        this.ws.close()
      } catch {
        // already closed
      }
      return this.finish(1006, 'relay silent')
    }
    try {
      this.ws.send(RELAY_PING)
    } catch {
      // the close arrives on its own
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
