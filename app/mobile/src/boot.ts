// Avvio: preferenze, lingua, abbinamento salvato → collegamento. Un solo posto, usato dal layout radice.
import { useEffect, useState } from 'react'
import { applyLocale } from '@/i18n'
import { startRemote } from '@/host/controller'
import { loadPairing } from '@/store/pairing'
import { usePrefs } from '@/store/prefs'

export function useBoot(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Le preferenze (zustand persist) si idratano da sole; qui si aspetta la fine.
      if (!usePrefs.persist.hasHydrated()) await new Promise<void>((resolve) => usePrefs.persist.onFinishHydration(() => resolve()))
      applyLocale(usePrefs.getState().language)
      const pairing = await loadPairing()
      // startRemote imposta la modalità prima di qualunque attesa: al primo render l'app sa già di avere un Mac.
      if (pairing && !cancelled) void startRemote(pairing)
      if (!cancelled) setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return ready
}

/** Le preferenze (tema compreso) sono state lette dal disco: da qui il tema è quello scelto dall'utente. */
export function usePrefsHydrated(): boolean {
  const [done, setDone] = useState(usePrefs.persist.hasHydrated())
  useEffect(() => {
    if (usePrefs.persist.hasHydrated()) return setDone(true)
    return usePrefs.persist.onFinishHydration(() => setDone(true))
  }, [])
  return done
}
