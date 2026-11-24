// Il seam del trasporto: un canale di byte, un messaggio Noise per messaggio di trasporto.
// Fase A: WebSocket diretto verso il server locale dell'host (ws-link.ts). Con LAD-50 arriva il relay, da
// shared/remote/relay-transport.ts: basterà un'altra `LinkFactory`, il resto dell'app non cambia.
export interface RemoteLink {
  /** Apre la connessione; gli eventi arrivano dai callback registrati prima. */
  open(): void
  send(bytes: Uint8Array): void
  close(): void
  onOpen(handler: () => void): void
  onBytes(handler: (bytes: Uint8Array) => void): void
  /** Chiusa o fallita (una sola volta); `reason` se noto, per "Mac unreachable". */
  onClose(handler: (reason?: string) => void): void
}

/** Crea un collegamento nuovo a ogni tentativo di connessione. */
export type LinkFactory = () => RemoteLink
