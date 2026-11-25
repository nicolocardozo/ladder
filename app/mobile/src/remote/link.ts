// The transport seam: a byte channel, one Noise message per transport message.
// Two implementations: the direct WebSocket to the local host (ws-link.ts, development) and the relay (relay-link.ts, over
// RelayTransport in shared/remote/relay-transport.ts). The rest of the app does not know which one is in use.
import type { RemoteMacStatus } from '@shared/protocol'

export interface RemoteLink {
  /** Opens the connection; events arrive from the callbacks registered earlier. */
  open(): void
  send(bytes: Uint8Array): void
  close(): void
  /**
   * The Mac is reachable: the first Noise message can be sent. For the direct WebSocket it is the socket opening; for
   * the relay it is the Mac's `online: true`, and it can repeat (Mac back after an absence): the handshake starts over.
   */
  onReady(handler: () => void): void
  onBytes(handler: (bytes: Uint8Array) => void): void
  /** Relay only: the Mac's state (on connection and on every change). With `online: false` the connection stays open, waiting. */
  onMacStatus?(handler: (status: RemoteMacStatus) => void): void
  /**
   * Closed or failed (only once). `reason` if known, for "Mac unreachable". `rejected`: the closure is a decision by the Mac
   * (the relay says the Mac closed that phone, or the direct socket closes cleanly), not a network failure.
   */
  onClose(handler: (reason?: string, rejected?: boolean) => void): void
}

/** Creates a new link on every connection attempt. */
export type LinkFactory = () => RemoteLink
