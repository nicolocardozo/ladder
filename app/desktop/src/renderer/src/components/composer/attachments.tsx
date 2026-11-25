// Images attached to the message: reading, limits and previews above the textarea.
import { X } from 'lucide-react'
import type { Attachment } from '@shared/protocol'
import { localeTag, t } from '@shared/i18n'

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export const IMAGE_ACCEPT = IMAGE_TYPES.join(',')
export const MAX_IMAGES = 5
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

// The placeholder text lives in a shared module (the phone gateway uses it too).
export { imagePlaceholder, isImagePlaceholder } from '@shared/image-placeholder'

export interface PendingImage {
  id: string
  name: string
  mediaType: string
  size: number
  /** Data URL: used for both the preview and sending. The CSP does not allow blob: in img-src. */
  url: string
}

let counter = 0

const EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

function readImage(file: File, name: string): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ id: `img-${++counter}`, name, mediaType: file.type, size: file.size, url: String(reader.result) })
    reader.onerror = () => reject(reader.error ?? new Error('Read failed'))
    reader.readAsDataURL(file)
  })
}

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toLocaleString(localeTag(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * Checks type, size and count, then reads the accepted files.
 * `pasted`: pasted images arrive as "image.png" and get a numbered name.
 */
export async function acceptImages(files: File[], current: number, pasted = false): Promise<{ images: PendingImage[]; error: string | null }> {
  const errors: string[] = []
  const valid: File[] = []
  for (const file of files) {
    if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) errors.push(t('{name}: only PNG, JPEG, GIF or WebP.', { name: file.name || t('The file') }))
    else if (file.size > MAX_IMAGE_BYTES) errors.push(t('{name} is {size}: the limit is 5 MB.', { name: file.name || t('The image'), size: formatSize(file.size) }))
    else valid.push(file)
  }
  const room = Math.max(0, MAX_IMAGES - current)
  if (valid.length > room) errors.unshift(t('Up to {n} images per message.', { n: MAX_IMAGES }))
  const accepted = valid.slice(0, room)
  const images: PendingImage[] = []
  for (const [i, file] of accepted.entries()) {
    const generic = !file.name || (pasted && /^image\.(png|jpe?g|gif|webp)$/i.test(file.name))
    const name = generic ? `${t('image')}-${current + i + 1}.${EXTENSION[file.type] ?? 'png'}` : file.name
    try {
      images.push(await readImage(file, name))
    } catch {
      errors.push(t('Unable to read {name}.', { name }))
    }
  }
  const error = errors.length ? errors.slice(0, 2).join(' ') + (errors.length > 2 ? ` (+${errors.length - 2})` : '') : null
  return { images, error }
}

/**
 * Images that arrive already prepared (screenshots from the built-in browser): same limits as pasted files.
 * `current` is the number of images already in the message.
 */
export function acceptAttachments(list: Attachment[], current: number): { images: PendingImage[]; error: string | null } {
  const images: PendingImage[] = []
  const errors: string[] = []
  for (const item of list) {
    const size = Math.floor((item.data.length * 3) / 4)
    if (!(IMAGE_TYPES as readonly string[]).includes(item.mediaType)) errors.push(t('{name}: only PNG, JPEG, GIF or WebP.', { name: item.name }))
    else if (size > MAX_IMAGE_BYTES) errors.push(t('{name} is {size}: the limit is 5 MB.', { name: item.name, size: formatSize(size) }))
    else if (current + images.length >= MAX_IMAGES) errors.push(t('Up to {n} images per message.', { n: MAX_IMAGES }))
    else images.push({ id: `img-${++counter}`, name: item.name, mediaType: item.mediaType, size, url: `data:${item.mediaType};base64,${item.data}` })
  }
  return { images, error: errors[0] ?? null }
}

/** Protocol format: base64 without the data URL prefix. */
export function toAttachment(image: PendingImage): Attachment {
  return { name: image.name, mediaType: image.mediaType, data: image.url.slice(image.url.indexOf(',') + 1) }
}

export function AttachmentStrip({ images, onRemove }: { images: PendingImage[]; onRemove: (id: string) => void }) {
  return (
    <ul aria-label={t('Attached images')} className="flex flex-wrap gap-2 px-3 pt-3">
      {images.map((image) => (
        <li
          key={image.id}
          title={`${image.name} · ${formatSize(image.size)}`}
          className="group relative size-14 overflow-hidden rounded-lg border border-input bg-muted"
        >
          <img src={image.url} alt={image.name} draggable={false} className="size-full object-cover" />
          <button
            type="button"
            aria-label={t('Remove {name}', { name: image.name })}
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
