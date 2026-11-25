// Remote channel frames: the plaintext of each Noise message is 1 flag byte (END/MORE) + a piece of UTF-8 JSON.
// Only Uint8Array and TextEncoder/TextDecoder: it also runs on React Native.
import { REMOTE_FRAME_END, REMOTE_FRAME_MORE, REMOTE_MAX_MESSAGE } from '../protocol.ts'
import { NOISE_MAX_MESSAGE, NOISE_TAG_LEN } from './noise.ts'

/** Maximum plaintext of a Noise message (65535 minus the tag), flag included. */
export const REMOTE_MAX_FRAME = NOISE_MAX_MESSAGE - NOISE_TAG_LEN

const encoder = new TextEncoder()

/** Splits a JSON into frames of at most REMOTE_MAX_FRAME bytes (flag included). The cut is on bytes: it is reassembled before decoding. */
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

/** Reassembles frames into JSON messages; throws if the flag is wrong, a MORE frame is not full or the message exceeds `maxMessage`. */
export class FrameReassembler {
  private parts: Uint8Array[] = []
  private size = 0
  private maxMessage: number
  /** Bytes of the last reassembled message (UTF-8, already known: nothing to re-encode). */
  lastSize = 0

  constructor(maxMessage: number = REMOTE_MAX_MESSAGE) {
    this.maxMessage = maxMessage
  }

  /** Changes the limit (wider after authentication). Applies from the next message. */
  setMax(maxMessage: number): void {
    this.maxMessage = maxMessage
  }

  /** Returns the message text when the END frame arrives, otherwise null. */
  push(frame: Uint8Array): string | null {
    if (frame.length < 1) throw new Error('Remote: frame vuoto')
    const flag = frame[0]
    if (flag !== REMOTE_FRAME_END && flag !== REMOTE_FRAME_MORE) throw new Error('Remote: invalid frame flag')
    // A MORE frame is always full: without this, millions of empty frames would fill memory without touching the limit.
    if (flag === REMOTE_FRAME_MORE && frame.length !== REMOTE_MAX_FRAME) throw new Error('Remote: MORE frame not full')
    this.size += frame.length - 1
    if (this.size > this.maxMessage || this.parts.length >= Math.ceil(this.maxMessage / (REMOTE_MAX_FRAME - 1)) + 1) throw new Error('Remote: message too large')
    this.parts.push(frame.slice(1))
    if (flag === REMOTE_FRAME_MORE) return null
    const bytes = new Uint8Array(this.size)
    let at = 0
    for (const part of this.parts) {
      bytes.set(part, at)
      at += part.length
    }
    this.parts = []
    this.lastSize = this.size
    this.size = 0
    // fatal: invalid UTF-8 is a protocol error, not a replacement character.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
}
