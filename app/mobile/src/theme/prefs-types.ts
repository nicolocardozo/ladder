import type { ThemeId } from '@shared/themes.generated'

export interface ThemePrefs {
  /** 'mac' = segue il tema del Mac; altrimenti l'id scelto. */
  choice: 'mac' | ThemeId
  matchSystem: boolean
  lightTheme: ThemeId
  darkTheme: ThemeId
}

export const DEFAULT_THEME_PREFS: ThemePrefs = { choice: 'mac', matchSystem: false, lightTheme: 'daylight', darkTheme: 'circuit' }

