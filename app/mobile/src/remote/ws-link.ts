// WebSocket diretto all'host locale (LADDER_REMOTE_PORT, solo 127.0.0.1): solo sviluppo, finché non c'è il relay (LAD-50).
// Simulatore iOS: 127.0.0.1. Emulatore Android: 10.0.2.2 (l'indirizzo del Mac visto dall'emulatore).
import { Platform } from 'react-native'
import type { LinkFactory, RemoteLink } from './link'

/** Su Android 127.0.0.1 è l'emulatore stesso: lo si porta sull'host. */
export function devUrl(url: string): string {
  return Platform.OS === 'android' ? url.replace('//127.0.0.1', '//10.0.2.2').replace('//localhost', '//10.0.2.2') : url
}

export function wsLinkFactory(url: string): LinkFactory {
  return () => {
    let ws: WebSocket | null = null
    let closed = false
    let onOpen: () => void = () => {}
    let onBytes: (bytes: Uint8Array) => void = () => {}
    let onClose: (reason?: string) => void = () => {}
    const finish = (reason?: string) => {
      if (closed) return
      closed = true
      onClose(reason)
    }
    const link: RemoteLink = {
      open() {
        try {
          ws = new WebSocket(devUrl(url))
        } catch (error) {
          finish(error instanceof Error ? error.message : String(error))
          return
        }
        ws.binaryType = 'arraybuffer'
        ws.onopen = () => onOpen()
        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) onBytes(new Uint8Array(event.data))
          else ws?.close() // un messaggio di testo non è Noise
        }
        ws.onerror = (event) => finish((event as { message?: string }).message || 'Connection failed')
        ws.onclose = (event) => finish(event.reason || (event.code === 1006 ? 'Connection lost' : undefined))
      },
      send(bytes) {
        ws?.send(bytes)
      },
      close() {
        closed = true
        try {
          ws?.close()
        } catch {
          // già chiusa
        }
      },
      onOpen: (h) => (onOpen = h),
      onBytes: (h) => (onBytes = h),
      onClose: (h) => (onClose = h)
    }
    return link
  }
}
