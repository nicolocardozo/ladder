// Stato degli aggiornamenti dell'app, dal main (electron-updater) al renderer.
// Le versioni arrivano dalle release pubbliche di nicolocardozo/ladder-releases.
export type UpdateState =
  /** Build di sviluppo o non impacchettata: niente aggiornamenti. */
  | { status: 'unsupported'; version: string }
  | { status: 'idle'; version: string; checkedAt: number | null }
  | { status: 'checking'; version: string }
  | { status: 'downloading'; version: string; next: string; percent: number }
  /** Scaricato: si installa al riavvio, o comunque alla prossima chiusura di Ladder. */
  | { status: 'ready'; version: string; next: string }
  | { status: 'error'; version: string; message: string }
