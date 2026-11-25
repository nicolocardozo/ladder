import type { ThemeId } from '@shared/themes.generated'

export interface ThemePrefs {
  /** 'mac' = follows the Mac's theme; otherwise the chosen id. */
  choice: 'mac' | ThemeId
  matchSystem: boolean
  lightTheme: ThemeId
  darkTheme: ThemeId
}

export const DEFAULT_THEME_PREFS: ThemePrefs = { choice: 'mac', matchSystem: false, lightTheme: 'daylight', darkTheme: 'circuit' }

