import type { AppPrefs } from '@shared/protocol'
import { useApp } from '@/store/app-store'

let seq = 0
let inFlight = 0

/** True while a prefs.set is in flight: change notifications must not override the optimistic update. */
export const prefsPending = () => inFlight > 0

/** App preferences and how to change them. The main process does a shallow merge: for `defaults` the whole object is sent. */
export function usePrefs(): [AppPrefs | null, (patch: Partial<AppPrefs>) => void] {
  const prefs = useApp((s) => s.prefs)
  const update = (patch: Partial<AppPrefs>) => {
    if (prefs) useApp.getState().setPrefs({ ...prefs, ...patch })
    // Out-of-order responses: only the latest request counts.
    const api = window.ladder?.prefs
    if (!api) return
    const mine = ++seq
    inFlight++
    api
      .set(patch)
      .then((next) => {
        if (mine === seq) useApp.getState().setPrefs(next)
      })
      // If the save fails, go back to what is in the main process.
      .catch(() => api.get().then((current) => useApp.getState().setPrefs(current)).catch(() => undefined))
      .finally(() => {
        inFlight--
      })
  }
  return [prefs, update]
}
