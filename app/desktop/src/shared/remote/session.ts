// RemoteSession: Noise handshake + encrypted JSON messages, identical on both sides (Mac and phone).
// The transport (WebSocket, relay) carries the bytes: one Noise message per transport message.
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

/** An already established encrypted session. Any `open` error must be handled by closing the connection. */
export class RemoteSession {
  private readonly transport: NoiseTransport
  private readonly reassembler: FrameReassembler

  constructor(transport: NoiseTransport, maxMessage: number = REMOTE_MAX_MESSAGE) {
    this.transport = transport
    this.reassembler = new FrameReassembler(maxMessage)
  }

  /** JSON → Noise messages to send, in order. */
  seal(message: unknown): Uint8Array[] {
    return splitFrames(JSON.stringify(message)).map((frame) => this.transport.encrypt(frame))
  }

  /** Bytes (UTF-8) of the last message reassembled by `open`, as counted by the reassembler. */
  lastSize = 0

  /** Changes the limit on incoming messages; the gateway raises it after authentication. */
  setMaxInbound(maxMessage: number): void {
    this.reassembler.setMax(maxMessage)
  }

  /** A received Noise message → the reassembled JSON, or null if the message continues in the next frame. */
  open<T>(bytes: Uint8Array): T | null {
    const text = this.reassembler.push(this.transport.decrypt(bytes))
    if (text === null) return null
    this.lastSize = this.reassembler.lastSize
    return JSON.parse(text) as T
  }

  get handshakeHash(): Uint8Array {
    return this.transport.handshakeHash
  }
}

/** Phone side. `start()` gives the first message; `finish(msg2)` gives the session and the Mac's hello. */
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

/** Mac side: reads the first message, checks the version and replies with its own hello. */
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
