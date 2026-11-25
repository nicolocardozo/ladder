// Direct WebSocket to the local host (LADDER_REMOTE_PORT, 127.0.0.1 only): development only, to pair without the relay.
// iOS simulator: 127.0.0.1. Android emulator: 10.0.2.2 (the Mac's address as seen from the emulator).
import { Platform } from 'react-native'
import type { LinkFactory, RemoteLink } from './link'

/** On Android 127.0.0.1 is the emulator itself: map it to the host. */
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
          else ws?.close() // a text message is not Noise
        }
        ws.onerror = (event) => finish((event as { message?: string }).message || 'Connection failed')
        // Orderly close (1000, 1005, 1008) = the Mac closed us on purpose; 1006 is the network dropping.
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
          // already closed
        }
      },
      onReady: (h) => (onReady = h),
      onBytes: (h) => (onBytes = h),
      onClose: (h) => (onClose = h)
    }
    return link
  }
}
