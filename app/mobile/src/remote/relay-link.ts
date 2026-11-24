// Collegamento al Mac attraverso il relay (LAD-50): RelayTransport di shared/remote/relay-transport.ts dietro l'interfaccia RemoteLink.
// Il relay non autentica nulla: chi parla davvero con il Mac lo stabilisce l'handshake Noise. Qui si passano i byte e si inoltra
// lo stato del Mac ("online", oppure "offline/asleep/quit" con da quando).
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
          // Niente 10.0.2.2 per il relay: shared/relay-protocol accetta ws:// in chiaro solo verso localhost. L'emulatore Android
          // lo raggiunge con `adb reverse tcp:8787 tcp:8787`.
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
        // 4005: il Mac ha chiuso proprio questo telefono (per esempio perché non ha decifrato il suo handshake).
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
