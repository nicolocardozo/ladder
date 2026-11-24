// Frame del canale remoto: il testo in chiaro di ogni messaggio Noise è 1 byte di flag (END/MORE) + un pezzo del JSON in UTF-8.
// Solo Uint8Array e TextEncoder/TextDecoder: gira anche su React Native.
import { REMOTE_FRAME_END, REMOTE_FRAME_MORE, REMOTE_MAX_MESSAGE } from '../protocol.ts'
import { NOISE_MAX_MESSAGE, NOISE_TAG_LEN } from './noise.ts'

/** Testo in chiaro massimo di un messaggio Noise (65535 meno il tag), flag compreso. */
export const REMOTE_MAX_FRAME = NOISE_MAX_MESSAGE - NOISE_TAG_LEN

const encoder = new TextEncoder()

/** Spezza un JSON in frame da al massimo REMOTE_MAX_FRAME byte (flag compreso). Il taglio è sui byte: si ricompone prima di decodificare. */
export function splitFrames(json: string): Uint8Array[] {
  const bytes = encoder.encode(json)
  const chunk = REMOTE_MAX_FRAME - 1
  const frames: Uint8Array[] = []
  let at = 0
  do {
    const end = Math.min(at + chunk, bytes.length)
    const frame = new Uint8Array(1 + end - at)
    frame[0] = end === bytes.length ? REMOTE_FRAME_END : REMOTE_FRAME_MORE
    frame.set(bytes.subarray(at, end), 1)
    frames.push(frame)
    at = end
  } while (at < bytes.length)
  return frames
}

/** Ricompone i frame in messaggi JSON; lancia se il flag è sbagliato, un frame MORE non è pieno o il messaggio supera `maxMessage`. */
export class FrameReassembler {
  private parts: Uint8Array[] = []
  private size = 0
  private readonly maxMessage: number

  constructor(maxMessage: number = REMOTE_MAX_MESSAGE) {
    this.maxMessage = maxMessage
  }

  /** Restituisce il testo del messaggio quando arriva il frame END, altrimenti null. */
  push(frame: Uint8Array): string | null {
    if (frame.length < 1) throw new Error('Remote: frame vuoto')
    const flag = frame[0]
    if (flag !== REMOTE_FRAME_END && flag !== REMOTE_FRAME_MORE) throw new Error('Remote: flag del frame non valido')
    // Un frame MORE è sempre pieno: senza questo, milioni di frame vuoti riempirebbero la memoria senza toccare il limite.
    if (flag === REMOTE_FRAME_MORE && frame.length !== REMOTE_MAX_FRAME) throw new Error('Remote: frame MORE non pieno')
    this.size += frame.length - 1
    if (this.size > this.maxMessage || this.parts.length >= Math.ceil(this.maxMessage / (REMOTE_MAX_FRAME - 1)) + 1) throw new Error('Remote: messaggio troppo grande')
    this.parts.push(frame.slice(1))
    if (flag === REMOTE_FRAME_MORE) return null
    const bytes = new Uint8Array(this.size)
    let at = 0
    for (const part of this.parts) {
      bytes.set(part, at)
      at += part.length
    }
    this.parts = []
    this.size = 0
    // fatal: un UTF-8 non valido è un errore di protocollo, non un carattere sostitutivo.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
}
