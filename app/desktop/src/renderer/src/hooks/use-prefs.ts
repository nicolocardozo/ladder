import type { AppPrefs } from '@shared/protocol'
import { useApp } from '@/store/app-store'

let seq = 0
let inFlight = 0

/** Vero mentre una prefs.set è in volo: le notifiche di cambio non devono scavalcare l'aggiornamento ottimistico. */
export const prefsPending = () => inFlight > 0

/** Preferenze dell'app e come cambiarle. Il main fa un merge superficiale: per `defaults` si manda l'oggetto intero. */
export function usePrefs(): [AppPrefs | null, (patch: Partial<AppPrefs>) => void] {
  const prefs = useApp((s) => s.prefs)
  const update = (patch: Partial<AppPrefs>) => {
    if (prefs) useApp.getState().setPrefs({ ...prefs, ...patch })
    // Risposte fuori ordine: conta solo l'ultima richiesta.
    const api = window.ladder?.prefs
    if (!api) return
    const mine = ++seq
    inFlight++
    api
      .set(patch)
      .then((next) => {
        if (mine === seq) useApp.getState().setPrefs(next)
      })
      // Se il salvataggio fallisce si torna a ciò che sta nel main.
      .catch(() => api.get().then((current) => useApp.getState().setPrefs(current)).catch(() => undefined))
      .finally(() => {
        inFlight--
      })
  }
  return [prefs, update]
}
