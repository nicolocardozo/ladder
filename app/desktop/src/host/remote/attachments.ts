// Validation of the phone's attachments: images only, checked without fully decoding them.
import { REMOTE_ATTACHMENT_TYPES, REMOTE_MAX_ATTACHMENT_BYTES, REMOTE_MAX_ATTACHMENTS, REMOTE_MAX_ATTACHMENTS_TOTAL, type Attachment } from '../../shared/protocol.ts'

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/** Decoded bytes of an already verified base64 string (length a multiple of 4). */
export function base64Size(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return (data.length / 4) * 3 - pad
}

/** The magic number of the first bytes matches the declared type. */
export function magicMatches(mediaType: string, head: Uint8Array): boolean {
  const at = (i: number, bytes: number[]) => bytes.every((b, k) => head[i + k] === b)
  if (mediaType === 'image/jpeg') return at(0, [0xff, 0xd8, 0xff])
  if (mediaType === 'image/png') return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (mediaType === 'image/webp') return at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])
  return false
}

/** Basename, at most 120 characters, without control characters; if it ends up empty, `image.<ext>`. */
export function sanitizeName(name: unknown, mediaType: string): string {
  const fallback = `image.${EXT[mediaType] ?? 'jpg'}`
  if (typeof name !== 'string') return fallback
  // eslint-disable-next-line no-control-regex
  const base = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').split(/[\\/]/).pop()!.trim()
  if (base === '' || base === '.' || base === '..') return fallback
  return Array.from(base).slice(0, 120).join('')
}

/** Clean attachments, rebuilt field by field, or null if anything is wrong. */
export function cleanAttachments(value: unknown): Attachment[] | null {
  if (!Array.isArray(value)) return null
  if (value.length > REMOTE_MAX_ATTACHMENTS) return null
  const out: Attachment[] = []
  let total = 0
  for (const a of value) {
    if (typeof a !== 'object' || a === null || Array.isArray(a)) return null
    const { name, mediaType, data } = a as Record<string, unknown>
    if (typeof mediaType !== 'string' || !(REMOTE_ATTACHMENT_TYPES as readonly string[]).includes(mediaType)) return null
    if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) return null
    const size = base64Size(data)
    total += size
    if (size <= 0 || size > REMOTE_MAX_ATTACHMENT_BYTES || total > REMOTE_MAX_ATTACHMENTS_TOTAL) return null
    // Size already verified: decode (at most 1 MiB) and check that the encoding is canonical and the magic number matches.
    const bytes = Buffer.from(data, 'base64')
    if (bytes.toString('base64') !== data || !magicMatches(mediaType, bytes.subarray(0, 12))) return null
    out.push({ name: sanitizeName(name, mediaType), mediaType, data })
  }
  return out
}
