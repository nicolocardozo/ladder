// Link to the Mac through the relay: `RelayTransport` from shared/remote/relay-transport.ts behind the `RemoteLink` interface.
// The relay authenticates nothing: the Noise handshake establishes who is really talking to the Mac. Here we just pass bytes along
// and forward the Mac's state ("online", or "offline/asleep/quit" with since when).
import { RELAY_CLOSE } from '@shared/remote/relay-protocol'
import { RelayTransport } from '@shared/remote/relay-transport'
import type { RemoteMacStatus } from '@shared/protocol'
import type { LinkFactory, RemoteLink } from './link'

export function relayLinkFactory(relayUrl: string, macId: string): LinkFactory {
  return () => {
    let transport: RelayTransport | null = null
    let closed = false
    let onReady: () => void = () => {}
    let onBytes: (bytes: Uint8Array) => void = () => {}
    let onStatus: (status: RemoteMacStatus) => void = () => {}
    let onClose: (reason?: string, rejected?: boolean) => void = () => {}
    const finish = (reason?: string, rejected = false) => {
      if (closed) return
      closed = true
      onClose(reason, rejected)
    }
    const link: RemoteLink = {
      open() {
        try {
          // No 10.0.2.2 for the relay: shared/relay-protocol only accepts plain ws:// to localhost. The Android emulator
          // reaches it with `adb reverse tcp:8787 tcp:8787`.
          transport = new RelayTransport({ relayUrl, macId })
        } catch (error) {
          finish(error instanceof Error ? error.message : String(error))
          return
        }
        transport.onBytes((bytes) => onBytes(bytes))
        transport.onStatus((status) => {
          onStatus(status)
          if (status.online) onReady()
        })
        // 4005: the Mac closed this very phone (for example because it could not decrypt its handshake).
        transport.onClose((code, reason) => finish(reason || `Relay closed (${code})`, code === RELAY_CLOSE.macClosed))
      },
      send: (bytes) => transport?.send(bytes),
      close() {
        closed = true
        transport?.close()
      },
      onReady: (h) => (onReady = h),
      onBytes: (h) => (onBytes = h),
      onMacStatus: (h) => (onStatus = h),
      onClose: (h) => (onClose = h)
    }
    return link
  }
}
