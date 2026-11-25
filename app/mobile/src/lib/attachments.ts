// Composer attachments: sizes, byte budget and names. Pure logic only (no React Native), tested with node --test.
// The app always sends JPEG: it resizes, compresses and stays under the limits the Mac checks (protocol.ts, REMOTE_MAX_ATTACH*).
import { REMOTE_MAX_ATTACH_COMMAND, REMOTE_MAX_ATTACHMENTS, REMOTE_MAX_ATTACHMENT_BYTES, REMOTE_MAX_ATTACHMENTS_TOTAL } from '../../../desktop/src/shared/protocol.ts'

export const MAX_ATTACHMENTS = REMOTE_MAX_ATTACHMENTS
/** Maximum long edge: normal photos and screenshots/PNG (text to read, but already sharp at fewer pixels). */
export const EDGE_PHOTO = 1568
export const EDGE_SCREENSHOT = 1280
/**
 * Per-image cap, in decoded bytes: 1 MiB, but with three images the total (2 MiB) counts for more, so a third
 * of the total is targeted. This way three images always fit, whatever order they arrive in.
 */
export const MAX_IMAGE_BYTES = Math.min(REMOTE_MAX_ATTACHMENT_BYTES, Math.floor(REMOTE_MAX_ATTACHMENTS_TOTAL / REMOTE_MAX_ATTACHMENTS))

/** Compression attempts, most faithful first: JPEG quality and long-edge scale. */
export const ATTEMPTS: readonly { quality: number; scale: number }[] = [
  { quality: 0.7, scale: 1 },
  { quality: 0.55, scale: 1 },
  { quality: 0.4, scale: 0.85 },
  { quality: 0.3, scale: 0.7 },
  { quality: 0.3, scale: 0.5 }
]

export interface PickedAsset {
  width: number
  height: number
  mimeType?: string | null
  fileName?: string | null
}

/** Screenshots and PNGs are almost always screens: 1280 is enough and weighs less. */
export function longEdgeFor(asset: Pick<PickedAsset, 'mimeType' | 'fileName'>): number {
  const png = /png/i.test(asset.mimeType ?? '') || /\.png$/i.test(asset.fileName ?? '')
  const shot = /screen\s?shot|schermata/i.test(asset.fileName ?? '')
  return png || shot ? EDGE_SCREENSHOT : EDGE_PHOTO
}

/** Dimensions with the long edge at most `edge`, never enlarging; always integers and at least 1. */
export function fitSize(width: number, height: number, edge: number): { width: number; height: number } {
  const long = Math.max(width, height)
  if (!(long > 0)) return { width: 1, height: 1 }
  const k = Math.min(1, edge / long)
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/** Bytes of a base64 string's content (without decoding it). */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}

/** Slots still free, given the attachments already in the composer. */
export const remainingSlots = (count: number): number => Math.max(0, MAX_ATTACHMENTS - count)

export interface Encoded {
  base64: string
  bytes: number
}

/**
 * Tries the attempts in order and returns the first that fits the limit. `render(quality, scale)` produces the JPEG in base64.
 * Throws 'too-big' if not even the last one fits. An error from `render` propagates as is.
 */
export async function encodeUnderLimit(render: (quality: number, scale: number) => Promise<string>, limit: number = MAX_IMAGE_BYTES): Promise<Encoded> {
  for (const { quality, scale } of ATTEMPTS) {
    const base64 = await render(quality, scale)
    const bytes = base64Bytes(base64)
    if (bytes > 0 && bytes <= limit) return { base64, bytes }
  }
  throw new Error('too-big')
}

/** Name of the file sent: the original without extension or odd characters, plus a suffix that makes it unique, always `.jpg`. */
export function attachmentName(original: string | null | undefined, suffix: string): string {
  const base = (original ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
  return `${base || 'photo'}-${suffix}.jpg`
}

/** UTF-8 bytes of a string, without Buffer (React Native does not have it). */
export function utf8Bytes(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** Bytes of the JSON command: the text as JSON.stringify writes it (with escape sequences), the base64 and a bit of envelope. */
export function commandBytes(text: string, attachments: readonly { base64: string }[]): number {
  return utf8Bytes(JSON.stringify(text)) + attachments.reduce((n, a) => n + a.base64.length, 0) + 1024 + attachments.length * 160
}

/** Does the command fit the limit for messages with attachments? With images near the cap little room is left for the text. */
export const commandFits = (text: string, attachments: readonly { base64: string }[]): boolean => commandBytes(text, attachments) <= REMOTE_MAX_ATTACH_COMMAND

/** Content type from a data URI prefix or an extension: only those the Mac accepts, otherwise null. */
export function imageTypeOf(hint: string | null | undefined): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const h = (hint ?? '').toLowerCase()
  if (/jpe?g/.test(h)) return 'image/jpeg'
  if (/png/.test(h)) return 'image/png'
  if (/webp/.test(h)) return 'image/webp'
  return null
}
