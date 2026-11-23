// Tipo reale dei file per l'anteprima (LAD-70): riconoscimento dai primi byte, dimensioni delle immagini e URL ladder-file.
// Codice puro (niente node): lo usano il main (che serve i file) e l'host (che descrive i file alla UI).

export type FileKind = 'image' | 'svg' | 'pdf' | 'audio' | 'video' | 'other'

export interface SniffedType {
  mime: string
  kind: FileKind
}

/** Schema del protocollo che serve i file dentro Ladder: `ladder-file://<id-root>/<percorso>[?rev=<rev>]`. */
export const FILE_SCHEME = 'ladder-file'
/** Quanti byte servono per riconoscere un file e leggerne le dimensioni. */
export const SNIFF_BYTES = 64 * 1024

/** Revisioni servibili: HEAD o uno sha completo (i checkpoint e i commit dell'host lo sono sempre). Mai altro, mai argomenti di git. */
export const REV_PATTERN = /^(?:HEAD|[0-9a-f]{40}|[0-9a-f]{64})$/
export const isKnownRev = (value: unknown): value is string => typeof value === 'string' && REV_PATTERN.test(value)

/** URL ladder-file per un file di una root nota; `rev` serve la versione di git invece di quella su disco. */
export function fileUrl(rootId: string, path: string, rev?: string | null): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${FILE_SCHEME}://${rootId}/${encoded}${rev ? `?rev=${rev}` : ''}`
}

const ascii = (b: Uint8Array, at: number, text: string): boolean => {
  if (b.length < at + text.length) return false
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false
  return true
}
const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const le16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8)
const le24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)
const le32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

const image = (mime: string): SniffedType => ({ mime, kind: 'image' })

/** Estensioni di file di testo (codice, markup, dati): per questi una firma debole nei primi byte non basta a farli passare per binari. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'mdx', 'rst', 'adoc', 'org', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
  'sh', 'zsh', 'bash', 'fish', 'sql', 'graphql', 'gql', 'vue', 'svelte', 'lock', 'log', 'diff', 'patch', 'tex', 'lua', 'pl', 'r', 'dart', 'gradle', 'properties'
])
export const isTextExtension = (name: string): boolean => TEXT_EXTENSIONS.has(extOf(name))

/** NUL nei primi 8000 byte: la stessa regola con cui git e l'host distinguono i file binari dal testo. */
const hasNul = (head: Uint8Array): boolean => head.subarray(0, 8000).includes(0)

/**
 * Firma "debole": byte ASCII che anche un file di testo può avere all'inizio (`GIF89a`, `ID3`, `OggS`). Vale solo se l'estensione è
 * quella del formato, oppure l'estensione non è di testo e il contenuto è binario (NUL).
 */
const weakSignature = (head: Uint8Array, ext: string, exts: readonly string[]): boolean => exts.includes(ext) || (!TEXT_EXTENSIONS.has(ext) && hasNul(head))

/**
 * Tipo reale dal contenuto. Il nome conta solo dove i byte non bastano (bmp, ico, svg, mp3 senza ID3, m4a/mp4).
 * null = fuori whitelist: va servito come `application/octet-stream` da scaricare.
 */
export function sniffType(head: Uint8Array, name: string): SniffedType | null {
  const ext = extOf(name)
  if (head.length >= 8 && head[0] === 0x89 && ascii(head, 1, 'PNG\r\n') && head[6] === 0x1a && head[7] === 0x0a) return image('image/png')
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return image('image/jpeg')
  if ((ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a')) && weakSignature(head, ext, ['gif'])) return image('image/gif')
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return image('image/webp')
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) return { mime: 'audio/wav', kind: 'audio' }
  if (ascii(head, 0, 'BM') && ext === 'bmp') return image('image/bmp')
  if (head.length >= 6 && head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0 && head[4] > 0 && ext === 'ico') return image('image/x-icon')
  if (ascii(head, 4, 'ftyp')) {
    const brand = String.fromCharCode(head[8] ?? 0, head[9] ?? 0, head[10] ?? 0, head[11] ?? 0)
    if (brand === 'avif' || brand === 'avis') return image('image/avif')
    if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'video' }
    if (brand === 'M4A ' || brand === 'M4B ' || (ext === 'm4a' && !/^(hei|mif|msf)/.test(brand))) return { mime: 'audio/mp4', kind: 'audio' }
    // Altri formati HEIF (heic, mif1…) non sono video.
    if (/^(hei|hev|mif|msf)/.test(brand)) return null
    return { mime: 'video/mp4', kind: 'video' }
  }
  if (ascii(head, 0, 'OggS') && weakSignature(head, ext, ['ogg', 'oga', 'ogv', 'opus', 'spx'])) return ext === 'ogv' ? { mime: 'video/ogg', kind: 'video' } : { mime: 'audio/ogg', kind: 'audio' }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    // Matroska e WebM condividono l'intestazione: il DocType dice quale.
    const doc = latin1(head.subarray(0, 64))
    if (!doc.includes('webm')) return null
    return ext === 'weba' ? { mime: 'audio/webm', kind: 'audio' } : { mime: 'video/webm', kind: 'video' }
  }
  if (ascii(head, 0, 'ID3') && weakSignature(head, ext, ['mp3', 'mpga'])) return { mime: 'audio/mpeg', kind: 'audio' }
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && ext === 'mp3') return { mime: 'audio/mpeg', kind: 'audio' }
  // %PDF- all'inizio del file; con estensione .pdf il visore accetta anche l'intestazione entro i primi 1024 byte (byte prima del %PDF-).
  // Un file di testo che cita "%PDF-1.7" (un .md, un .ts) non è un PDF: con estensione di testo non conta nemmeno all'inizio.
  if (ascii(head, 0, '%PDF-') ? !TEXT_EXTENSIONS.has(ext) : ext === 'pdf' && latin1(head.subarray(0, 1024)).includes('%PDF-')) return { mime: 'application/pdf', kind: 'pdf' }
  if (ext === 'svg') {
    const text = new TextDecoder('utf-8').decode(head.subarray(0, 4096))
    if (!text.includes('\0') && /<svg[\s>/]/i.test(text)) return { mime: 'image/svg+xml', kind: 'svg' }
  }
  return null
}

function latin1(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}

/** Dimensioni in pixel dall'intestazione (png, jpg, gif, webp, bmp, ico); null se non si leggono nei byte dati (es. avif). */
export function imageSize(head: Uint8Array, mime: string): { width: number; height: number } | null {
  const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null)
  switch (mime) {
    case 'image/png':
      return head.length >= 24 ? size(be32(head, 16), be32(head, 20)) : null
    case 'image/gif':
      return head.length >= 10 ? size(le16(head, 6), le16(head, 8)) : null
    case 'image/bmp':
      return head.length >= 26 ? size(le32(head, 18), Math.abs(le32(head, 22) | 0)) : null
    case 'image/x-icon':
      return head.length >= 8 ? size(head[6] || 256, head[7] || 256) : null
    case 'image/webp': {
      if (ascii(head, 12, 'VP8X') && head.length >= 30) return size(1 + le24(head, 24), 1 + le24(head, 27))
      if (ascii(head, 12, 'VP8L') && head.length >= 25) return size(1 + (((head[22] & 0x3f) << 8) | head[21]), 1 + (((head[24] & 0x0f) << 10) | (head[23] << 2) | ((head[22] & 0xc0) >> 6)))
      if (ascii(head, 12, 'VP8 ') && head.length >= 30) return size(le16(head, 26) & 0x3fff, le16(head, 28) & 0x3fff)
      return null
    }
    case 'image/jpeg': {
      let i = 2
      while (i + 9 < head.length) {
        if (head[i] !== 0xff) return null
        const marker = head[i + 1]
        if (marker === 0xff) {
          i++
          continue
        }
        // Marcatori senza lunghezza.
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2
          continue
        }
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (isFrame) return size((head[i + 7] << 8) | head[i + 8], (head[i + 5] << 8) | head[i + 6])
        i += 2 + ((head[i + 2] << 8) | head[i + 3])
      }
      return null
    }
    default:
      return null
  }
}
