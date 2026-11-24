// WebSocket diretto all'host locale (LADDER_REMOTE_PORT, solo 127.0.0.1): solo sviluppo, per abbinarsi senza relay.
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
    let onReady: () => void = () => {}
    let onBytes: (bytes: Uint8Array) => void = () => {}
    let onClose: (reason?: string, rejected?: boolean) => void = () => {}
    const finish = (reason?: string, rejected = false) => {
      if (closed) return
      closed = true
      onClose(reason, rejected)
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
        ws.onopen = () => onReady()
        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) onBytes(new Uint8Array(event.data))
          else ws?.close() // un messaggio di testo non è Noise
        }
        ws.onerror = (event) => finish((event as { message?: string }).message || 'Connection failed')
        // Chiusura ordinata (1000, 1005, 1008) = il Mac ci ha chiusi di proposito; 1006 è la rete che cade.
        ws.onclose = (event) => finish(event.reason || (event.code === 1006 ? 'Connection lost' : undefined), event.code === 1000 || event.code === 1005 || event.code === 1008)
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
      onReady: (h) => (onReady = h),
      onBytes: (h) => (onBytes = h),
      onClose: (h) => (onClose = h)
    }
    return link
  }
}
