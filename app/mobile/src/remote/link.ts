// Il seam del trasporto: un canale di byte, un messaggio Noise per messaggio di trasporto.
// Due implementazioni: il WebSocket diretto verso l'host locale (ws-link.ts, sviluppo) e il relay (relay-link.ts, su
// RelayTransport di shared/remote/relay-transport.ts). Il resto dell'app non sa quale sia in uso.
import type { RemoteMacStatus } from '@shared/protocol'

export interface RemoteLink {
  /** Apre la connessione; gli eventi arrivano dai callback registrati prima. */
  open(): void
  send(bytes: Uint8Array): void
  close(): void
  /**
   * Il Mac è raggiungibile: si può mandare il primo messaggio Noise. Per il WebSocket diretto è l'apertura del socket; per
   * il relay è `online: true` del Mac, e può ripetersi (Mac tornato dopo un'assenza): l'handshake riparte da capo.
   */
  onReady(handler: () => void): void
  onBytes(handler: (bytes: Uint8Array) => void): void
  /** Solo il relay: stato del Mac (alla connessione e a ogni cambio). Con `online: false` il collegamento resta aperto, in attesa. */
  onMacStatus?(handler: (status: RemoteMacStatus) => void): void
  /**
   * Chiusa o fallita (una sola volta). `reason` se noto, per "Mac unreachable". `rejected`: la chiusura è una decisione del Mac
   * (il relay dice che il Mac ha chiuso quel telefono, o il socket diretto si chiude in modo ordinato), non un guasto di rete.
   */
  onClose(handler: (reason?: string, rejected?: boolean) => void): void
}

/** Crea un collegamento nuovo a ogni tentativo di connessione. */
export type LinkFactory = () => RemoteLink
