// Stato in memoria delle notifiche push su questo telefono (non salvato): permesso di sistema, token Expo e la richiesta
// da aprire dopo il tocco su una notifica. Le preferenze (quali eventi, fascia silenziosa) stanno in prefs.ts.
import { create } from 'zustand'

export type PushPermission = 'unknown' | 'undetermined' | 'granted' | 'denied'

interface PushState {
  permission: PushPermission
  /** Il sistema può ancora mostrare la finestra del permesso (altrimenti si passa dalle impostazioni). */
  canAsk: boolean
  /** Token Expo di questo telefono (mai mostrato né loggato). */
  token: string | null
  /** Permesso dato ma il token non si è potuto ottenere: build senza credenziali push (APNs / FCM). */
  tokenFailed: boolean
  /** Richiesta da aprire quando la sessione è stata riletta dal Mac dopo il tocco su una notifica; `at` = momento del tocco (scade). */
  openRequest: { sessionId: string; requestId: string; at: number } | null
  set: (patch: Partial<Omit<PushState, 'set'>>) => void
}

export const usePush = create<PushState>((set) => ({
  permission: 'unknown',
  canAsk: true,
  token: null,
  tokenFailed: false,
  openRequest: null,
  set: (patch) => set(patch)
}))
