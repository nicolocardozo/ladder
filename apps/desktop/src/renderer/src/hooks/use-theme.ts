import { useEffect, useState } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'ladder.theme'

function readStoredMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
  } catch {
    return 'system'
  }
}

/** Applica la classe `dark` a <html> seguendo la scelta dell'utente o il tema di sistema. */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readStoredMode)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = mode === 'dark' || (mode === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    media.addEventListener('change', apply)
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // Lo stato del tema è solo una comodità: se lo storage non è disponibile si segue il sistema.
    }
    return () => media.removeEventListener('change', apply)
  }, [mode])

  const cycle = () => setMode((m) => (m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system'))
  return { mode, setMode, cycle }
}
