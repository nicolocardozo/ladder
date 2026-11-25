// Boot: preferences, language, saved pairing → connection. A single place, used by the root layout.
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
      // Preferences (zustand persist) hydrate on their own; here we wait for it to finish.
      if (!usePrefs.persist.hasHydrated()) await new Promise<void>((resolve) => usePrefs.persist.onFinishHydration(() => resolve()))
      applyLocale(usePrefs.getState().language)
      const pairing = await loadPairing()
      // startRemote sets the mode before any wait: at first render the app already knows it has a Mac.
      if (pairing && !cancelled) void startRemote(pairing)
      if (!cancelled) setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return ready
}

/** Preferences (theme included) have been read from disk: from here the theme is the one chosen by the user. */
export function usePrefsHydrated(): boolean {
  const [done, setDone] = useState(usePrefs.persist.hasHydrated())
  useEffect(() => {
    if (usePrefs.persist.hasHydrated()) return setDone(true)
    return usePrefs.persist.onFinishHydration(() => setDone(true))
  }, [])
  return done
}
