// RemoteSession: handshake Noise + messaggi JSON cifrati, uguale sui due lati (Mac e telefono).
// Il trasporto (WebSocket, relay) porta i byte: un messaggio Noise per messaggio di trasporto.
import {
  REMOTE_MAX_COMMAND,
  REMOTE_MAX_MESSAGE,
  REMOTE_NOISE_PROLOGUE,
  REMOTE_PROTOCOL_VERSION,
  type RemoteClientHello,
  type RemoteServerHello
} from '../protocol.ts'
import { FrameReassembler, splitFrames } from './frames.ts'
import { NoiseInitiator, NoiseResponder, type NoiseKeyPair, type NoiseTransport } from './noise.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const prologue = encoder.encode(REMOTE_NOISE_PROLOGUE)

function toJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T
}

/** Una sessione cifrata già stabilita. Qualunque errore di `open` va trattato chiudendo la connessione. */
export class RemoteSession {
  private readonly transport: NoiseTransport
  private readonly reassembler: FrameReassembler

  constructor(transport: NoiseTransport, maxMessage: number = REMOTE_MAX_MESSAGE) {
    this.transport = transport
    this.reassembler = new FrameReassembler(maxMessage)
  }

  /** JSON → messaggi Noise da spedire, nell'ordine. */
  seal(message: unknown): Uint8Array[] {
    return splitFrames(JSON.stringify(message)).map((frame) => this.transport.encrypt(frame))
  }

  /** Un messaggio Noise ricevuto → il JSON ricomposto, o null se il messaggio continua nel frame dopo. */
  open<T>(bytes: Uint8Array): T | null {
    const text = this.reassembler.push(this.transport.decrypt(bytes))
    return text === null ? null : (JSON.parse(text) as T)
  }

  get handshakeHash(): Uint8Array {
    return this.transport.handshakeHash
  }
}

/** Lato telefono. `start()` dà il primo messaggio; `finish(msg2)` dà la sessione e l'hello del Mac. */
export function clientHandshake(options: { macPublicKey: Uint8Array; hello: Omit<RemoteClientHello, 'v'>; ephemeral?: NoiseKeyPair }) {
  const noise = new NoiseInitiator({ prologue, remoteStatic: options.macPublicKey, ephemeral: options.ephemeral })
  return {
    start(): Uint8Array {
      const hello: RemoteClientHello = { v: REMOTE_PROTOCOL_VERSION, ...options.hello }
      return noise.writeMessage1(encoder.encode(JSON.stringify(hello)))
    },
    finish(message2: Uint8Array): { session: RemoteSession; hello: RemoteServerHello } {
      const { payload, transport } = noise.readMessage2(message2)
      const hello = toJson<RemoteServerHello>(payload)
      if (hello.v !== REMOTE_PROTOCOL_VERSION) throw new Error('Remote: versione del protocollo non supportata')
      return { session: new RemoteSession(transport), hello }
    }
  }
}

/** Lato Mac: legge il primo messaggio, controlla la versione e risponde con il proprio hello. */
export function serverHandshake(options: { identity: NoiseKeyPair; hello: Omit<RemoteServerHello, 'v'>; ephemeral?: NoiseKeyPair; maxInbound?: number }) {
  const noise = new NoiseResponder({ prologue, staticKey: options.identity, ephemeral: options.ephemeral })
  return {
    accept(message1: Uint8Array): { reply: Uint8Array; session: RemoteSession; client: RemoteClientHello } {
      const client = toJson<RemoteClientHello>(noise.readMessage1(message1))
      if (client.v !== REMOTE_PROTOCOL_VERSION) throw new Error('Remote: versione del protocollo non supportata')
      const hello: RemoteServerHello = { v: REMOTE_PROTOCOL_VERSION, ...options.hello }
      const { message, transport } = noise.writeMessage2(encoder.encode(JSON.stringify(hello)))
      return { reply: message, session: new RemoteSession(transport, options.maxInbound ?? REMOTE_MAX_COMMAND), client }
    }
  }
}
