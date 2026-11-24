// Temi: i 15 del Mac (themes.generated.ts). "Same as Mac" segue il tema che il Mac manderà sul canale (per ora Circuit);
// "Match system appearance" sceglie un tema chiaro e uno scuro che seguono la modalità del telefono.
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'
import { DEFAULT_THEME, THEMES, type ThemeId, type ThemeInfo } from '@shared/themes.generated'
import { usePrefs } from '@/store/prefs'
import type { ThemePrefs } from './prefs-types'
import { useApp } from '@/store/app'

export type Tokens = ThemeInfo['tokens']
export type { ThemeInfo }
export { THEMES }
export type { ThemeId }

export const themeById = (id: string | null | undefined): ThemeInfo => THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!

export type { ThemePrefs } from './prefs-types'
export { DEFAULT_THEME_PREFS } from './prefs-types'

export function resolveTheme(prefs: ThemePrefs, system: 'light' | 'dark', macTheme: string | null): ThemeInfo {
  if (prefs.matchSystem) return themeById(system === 'dark' ? prefs.darkTheme : prefs.lightTheme)
  if (prefs.choice === 'mac') return themeById(macTheme)
  return themeById(prefs.choice)
}

interface ThemeValue {
  info: ThemeInfo
  c: Tokens
  dark: boolean
}

const Ctx = createContext<ThemeValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const prefs = usePrefs((s) => s.theme)
  const macTheme = useApp((s) => s.macTheme)
  const scheme = useColorScheme()
  const info = resolveTheme(prefs, scheme === 'light' ? 'light' : 'dark', macTheme)
  const value = useMemo<ThemeValue>(() => ({ info, c: info.tokens, dark: info.appearance === 'dark' }), [info])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('ThemeProvider mancante')
  return v
}

/** Aggiunge trasparenza a un colore #rrggbb. */
export function alpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
