// Preferenze del telefono, salvate in locale (AsyncStorage): tema, lingua, sezioni aperte/chiuse, bozze del composer.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Locale } from '@shared/i18n'
import { DEFAULT_THEME_PREFS, type ThemePrefs } from '@/theme/prefs-types'

interface PrefsState {
  theme: ThemePrefs
  language: 'system' | Locale
  /** Sezioni del Mac chiuse (true) o aperte (false) dall'utente; assente = decide "ha qualcosa di vivo". */
  collapsed: Record<string, boolean>
  /** Bozza del composer per sessione: resta anche senza connessione. */
  drafts: Record<string, string>
  setTheme: (patch: Partial<ThemePrefs>) => void
  setLanguage: (language: 'system' | Locale) => void
  setCollapsed: (sectionId: string, collapsed: boolean) => void
  setDraft: (sessionId: string, text: string) => void
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      theme: DEFAULT_THEME_PREFS,
      language: 'system',
      collapsed: {},
      drafts: {},
      setTheme: (patch) => set((s) => ({ theme: { ...s.theme, ...patch } })),
      setLanguage: (language) => set({ language }),
      setCollapsed: (sectionId, collapsed) => set((s) => ({ collapsed: { ...s.collapsed, [sectionId]: collapsed } })),
      setDraft: (sessionId, text) =>
        set((s) => {
          const drafts = { ...s.drafts }
          if (text) drafts[sessionId] = text
          else delete drafts[sessionId]
          return { drafts }
        })
    }),
    { name: 'ladder-prefs-v1', storage: createJSONStorage(() => AsyncStorage) }
  )
)
