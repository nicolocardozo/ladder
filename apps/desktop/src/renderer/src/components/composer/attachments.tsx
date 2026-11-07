// Immagini allegate al messaggio: lettura, limiti e anteprime sopra la textarea.
import { X } from 'lucide-react'
import type { Attachment } from '@shared/protocol'

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export const IMAGE_ACCEPT = IMAGE_TYPES.join(',')
export const MAX_IMAGES = 5
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** Testo inviato quando il messaggio ha solo immagini: l'host vuole sempre un testo. */
export const imagePlaceholder = (count: number) => (count === 1 ? '(immagine allegata)' : '(immagini allegate)')
export const isImagePlaceholder = (text: string) => text === '(immagine allegata)' || text === '(immagini allegate)'

export interface PendingImage {
  id: string
  name: string
  mediaType: string
  size: number
  /** Data URL: serve sia all'anteprima sia all'invio. La CSP non ammette blob: in img-src. */
  url: string
}

let counter = 0

const EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

function readImage(file: File, name: string): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ id: `img-${++counter}`, name, mediaType: file.type, size: file.size, url: String(reader.result) })
    reader.onerror = () => reject(reader.error ?? new Error('Lettura non riuscita'))
    reader.readAsDataURL(file)
  })
}

const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

/**
 * Controlla tipo, dimensione e numero, poi legge i file accettati.
 * `pasted`: le immagini incollate arrivano come "image.png" e prendono un nome numerato.
 */
export async function acceptImages(files: File[], current: number, pasted = false): Promise<{ images: PendingImage[]; error: string | null }> {
  const errors: string[] = []
  const valid: File[] = []
  for (const file of files) {
    if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) errors.push(`${file.name || 'Il file'}: solo PNG, JPEG, GIF o WebP.`)
    else if (file.size > MAX_IMAGE_BYTES) errors.push(`${file.name || 'L’immagine'} pesa ${formatSize(file.size)}: il limite è 5 MB.`)
    else valid.push(file)
  }
  const room = Math.max(0, MAX_IMAGES - current)
  if (valid.length > room) errors.unshift(`Al massimo ${MAX_IMAGES} immagini per messaggio.`)
  const accepted = valid.slice(0, room)
  const images: PendingImage[] = []
  for (const [i, file] of accepted.entries()) {
    const generic = !file.name || (pasted && /^image\.(png|jpe?g|gif|webp)$/i.test(file.name))
    const name = generic ? `immagine-${current + i + 1}.${EXTENSION[file.type] ?? 'png'}` : file.name
    try {
      images.push(await readImage(file, name))
    } catch {
      errors.push(`Non riesco a leggere ${name}.`)
    }
  }
  const error = errors.length ? errors.slice(0, 2).join(' ') + (errors.length > 2 ? ` (+${errors.length - 2})` : '') : null
  return { images, error }
}

/** Formato del protocollo: base64 senza il prefisso del data URL. */
export function toAttachment(image: PendingImage): Attachment {
  return { name: image.name, mediaType: image.mediaType, data: image.url.slice(image.url.indexOf(',') + 1) }
}

export function AttachmentStrip({ images, onRemove }: { images: PendingImage[]; onRemove: (id: string) => void }) {
  return (
    <ul aria-label="Immagini allegate" className="flex flex-wrap gap-2 px-3 pt-3">
      {images.map((image) => (
        <li
          key={image.id}
          title={`${image.name} · ${formatSize(image.size)}`}
          className="group relative size-14 overflow-hidden rounded-lg border border-input bg-muted"
        >
          <img src={image.url} alt={image.name} draggable={false} className="size-full object-cover" />
          <button
            type="button"
            aria-label={`Rimuovi ${image.name}`}
            onClick={() => onRemove(image.id)}
            className="absolute top-1 right-1 grid size-[18px] place-items-center rounded-full border border-input bg-popover/95 text-muted-foreground opacity-0 shadow-sm outline-none transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-3" strokeWidth={2.2} />
          </button>
        </li>
      ))}
    </ul>
  )
}
