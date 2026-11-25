// Allegati del composer (LAD-92): scatta, scegli dalla libreria o incolla; ogni immagine si ridimensiona e si comprime sul telefono
// (JPEG sotto il tetto di byte) prima di partire. Stato locale al composer: le miniature stanno sopra il campo.
import * as Clipboard from 'expo-clipboard'
import * as ImageManipulator from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Linking } from 'react-native'
import { t } from '@shared/i18n'
import { attachmentName, encodeUnderLimit, fitSize, longEdgeFor, remainingSlots, MAX_ATTACHMENTS, type PickedAsset } from '@/lib/attachments'

export interface Draft {
  id: string
  name: string
  /** Miniatura (file locale). */
  uri: string
  base64: string | null
  bytes: number
  status: 'processing' | 'ready'
}

export type AttachSource = 'camera' | 'library' | 'clipboard'

let counter = 0
const nextId = (): string => `att-${Date.now().toString(36)}-${(counter++).toString(36)}`

/** Rimpicciolisce e comprime un'immagine come JPEG sotto il tetto; lancia se non ci riesce. */
async function compress(uri: string, asset: PickedAsset): Promise<{ uri: string; base64: string; bytes: number }> {
  const target = fitSize(asset.width, asset.height, longEdgeFor(asset))
  let last = uri
  const enc = await encodeUnderLimit(async (quality, scale) => {
    const w = Math.max(1, Math.round(target.width * scale))
    const ctx = ImageManipulator.ImageManipulator.manipulate(uri)
    // Il lato lungo decide: l'altro segue le proporzioni.
    ctx.resize(target.width >= target.height ? { width: w } : { height: Math.max(1, Math.round(target.height * scale)) })
    const ref = await ctx.renderAsync()
    const out = await ref.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: quality, base64: true })
    last = out.uri
    if (!out.base64) throw new Error('unreadable')
    return out.base64
  })
  return { uri: last, ...enc }
}

export function useAttachments() {
  const [items, setItems] = useState<Draft[]>([])
  const [error, setError] = useState<string | null>(null)
  // Gli id presenti (anche dentro le funzioni async): il conteggio vero sta qui, lo stato arriva dopo. Un id si toglie una volta sola.
  const ids = useRef(new Set<string>())
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  const patch = useCallback((id: string, next: Partial<Draft> | null) => {
    if (!alive.current) return
    setItems((list) => (next ? list.map((d) => (d.id === id ? { ...d, ...next } : d)) : list.filter((d) => d.id !== id)))
  }, [])

  const addAsset = useCallback(
    async (asset: { uri: string; width?: number; height?: number; mimeType?: string | null; fileName?: string | null }) => {
      if (ids.current.size >= MAX_ATTACHMENTS) return
      const id = nextId()
      ids.current.add(id)
      const name = attachmentName(asset.fileName, id.slice(-5))
      setItems((list) => [...list, { id, name, uri: asset.uri, base64: null, bytes: 0, status: 'processing' }])
      try {
        const done = await compress(asset.uri, { width: asset.width ?? 0, height: asset.height ?? 0, mimeType: asset.mimeType, fileName: asset.fileName })
        patch(id, { uri: done.uri, base64: done.base64, bytes: done.bytes, status: 'ready' })
      } catch (e) {
        ids.current.delete(id)
        patch(id, null)
        if (alive.current) setError(e instanceof Error && e.message === 'too-big' ? t('That image is too large to send, even after shrinking it.') : t('Could not read that image.'))
      }
    },
    [patch]
  )

  /** Solo sviluppo (driver): un file locale come se fosse scelto dalla libreria; le misure le legge il manipolatore. */
  const addUri = useCallback(
    async (uri: string) => {
      const ref = await ImageManipulator.ImageManipulator.manipulate(uri).renderAsync()
      await addAsset({ uri, width: ref.width, height: ref.height, fileName: uri.split('/').pop() })
    },
    [addAsset]
  )

  const remove = useCallback((id: string) => {
    ids.current.delete(id)
    setItems((list) => list.filter((d) => d.id !== id))
    setError(null)
  }, [])

  const clear = useCallback(() => {
    ids.current.clear()
    setItems([])
    setError(null)
  }, [])

  const pick = useCallback(
    async (source: AttachSource) => {
      setError(null)
      const slots = remainingSlots(ids.current.size)
      if (slots === 0) return setError(t('You can attach up to {n} images.', { n: MAX_ATTACHMENTS }))
      try {
        if (source === 'camera') {
          let perm = await ImagePicker.getCameraPermissionsAsync()
          if (!perm.granted && perm.canAskAgain) perm = await ImagePicker.requestCameraPermissionsAsync()
          if (!perm.granted) return setError(t('Allow the camera in Settings to take a photo.'))
          const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })
          if (!res.canceled) for (const a of res.assets.slice(0, slots)) await addAsset(a)
        } else if (source === 'library') {
          // PHPicker (iOS) e il selettore di foto di Android non chiedono un permesso: l'app vede solo quello che si sceglie.
          const res = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsMultipleSelection: slots > 1,
            selectionLimit: slots,
            orderedSelection: true,
            quality: 1,
            // "Compatible": HEIC → JPEG, così il manipolatore legge qualunque foto.
            preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible
          })
          if (!res.canceled) await Promise.all(res.assets.slice(0, slots).map((a) => addAsset(a)))
        } else {
          if (!(await Clipboard.hasImageAsync())) return setError(t('There is no image on the clipboard.'))
          const img = await Clipboard.getImageAsync({ format: 'png' })
          if (!img) return setError(t('There is no image on the clipboard.'))
          // Dagli appunti arriva un PNG (spesso uno screenshot): il lato lungo è 1280.
          await addAsset({ uri: img.data, width: img.size.width, height: img.size.height, mimeType: 'image/png' })
        }
      } catch {
        setError(t('Could not read that image.'))
      }
    },
    [addAsset]
  )

  const ready = items.filter((d): d is Draft & { base64: string } => d.status === 'ready' && !!d.base64)
  return { items, ready, busy: items.some((d) => d.status === 'processing'), error, clearError: () => setError(null), pick, addUri, remove, clear, count: items.length, openSettings: () => void Linking.openSettings() }
}
