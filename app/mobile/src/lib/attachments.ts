// Allegati del composer (LAD-92): dimensioni, budget in byte e nomi. Solo logica pura (niente React Native), provata con node --test.
// L'app manda sempre JPEG: ridimensiona, comprime e sta sotto i limiti che il Mac controlla (protocol.ts, REMOTE_MAX_ATTACH*).
import { REMOTE_MAX_ATTACH_COMMAND, REMOTE_MAX_ATTACHMENTS, REMOTE_MAX_ATTACHMENT_BYTES, REMOTE_MAX_ATTACHMENTS_TOTAL } from '../../../desktop/src/shared/protocol.ts'

export const MAX_ATTACHMENTS = REMOTE_MAX_ATTACHMENTS
/** Lato lungo massimo: foto normali e screenshot/PNG (testo da leggere, ma già nitido a meno pixel). */
export const EDGE_PHOTO = 1568
export const EDGE_SCREENSHOT = 1280
/**
 * Tetto per immagine, in byte decodificati: 1 MiB, ma con tre immagini il totale (2 MiB) vale di più, quindi si punta a un terzo
 * del totale. Così tre immagini entrano sempre, qualunque sia l'ordine in cui arrivano.
 */
export const MAX_IMAGE_BYTES = Math.min(REMOTE_MAX_ATTACHMENT_BYTES, Math.floor(REMOTE_MAX_ATTACHMENTS_TOTAL / REMOTE_MAX_ATTACHMENTS))

/** Tentativi di compressione, dal più fedele: qualità JPEG e scala del lato lungo. */
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

/** Screenshot e PNG sono quasi sempre schermate: 1280 basta e pesa meno. */
export function longEdgeFor(asset: Pick<PickedAsset, 'mimeType' | 'fileName'>): number {
  const png = /png/i.test(asset.mimeType ?? '') || /\.png$/i.test(asset.fileName ?? '')
  const shot = /screen\s?shot|schermata/i.test(asset.fileName ?? '')
  return png || shot ? EDGE_SCREENSHOT : EDGE_PHOTO
}

/** Dimensioni con il lato lungo al massimo `edge`, mai ingrandendo; sempre intere e almeno 1. */
export function fitSize(width: number, height: number, edge: number): { width: number; height: number } {
  const long = Math.max(width, height)
  if (!(long > 0)) return { width: 1, height: 1 }
  const k = Math.min(1, edge / long)
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/** Byte del contenuto di una stringa base64 (senza decodificarla). */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}

/** Posti ancora liberi, dati gli allegati già nel composer. */
export const remainingSlots = (count: number): number => Math.max(0, MAX_ATTACHMENTS - count)

export interface Encoded {
  base64: string
  bytes: number
}

/**
 * Prova i tentativi in ordine e restituisce il primo che sta nel limite. `render(quality, scale)` produce il JPEG in base64.
 * Lancia 'too-big' se nemmeno l'ultimo ci sta. Un errore di `render` risale com'è.
 */
export async function encodeUnderLimit(render: (quality: number, scale: number) => Promise<string>, limit: number = MAX_IMAGE_BYTES): Promise<Encoded> {
  for (const { quality, scale } of ATTEMPTS) {
    const base64 = await render(quality, scale)
    const bytes = base64Bytes(base64)
    if (bytes > 0 && bytes <= limit) return { base64, bytes }
  }
  throw new Error('too-big')
}

/** Nome del file inviato: l'originale senza estensione né caratteri strani, più un suffisso che lo rende unico, sempre `.jpg`. */
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

/** Byte UTF-8 di una stringa, senza Buffer (React Native non lo ha). */
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

/** Byte del comando JSON: il testo come lo scrive JSON.stringify (con le sequenze di escape), il base64 e un po' di busta. */
export function commandBytes(text: string, attachments: readonly { base64: string }[]): number {
  return utf8Bytes(JSON.stringify(text)) + attachments.reduce((n, a) => n + a.base64.length, 0) + 1024 + attachments.length * 160
}

/** Il comando sta nel limite dei messaggi con allegati? Con le immagini vicine al tetto resta poco spazio per il testo. */
export const commandFits = (text: string, attachments: readonly { base64: string }[]): boolean => commandBytes(text, attachments) <= REMOTE_MAX_ATTACH_COMMAND

/** Tipo del contenuto dal prefisso di un data URI o da un'estensione: solo quelli che il Mac accetta, altrimenti null. */
export function imageTypeOf(hint: string | null | undefined): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const h = (hint ?? '').toLowerCase()
  if (/jpe?g/.test(h)) return 'image/jpeg'
  if (/png/.test(h)) return 'image/png'
  if (/webp/.test(h)) return 'image/webp'
  return null
}
