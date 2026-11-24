// Preferenze del telefono, salvate in locale (AsyncStorage): tema, lingua, notifiche, sezioni aperte/chiuse, bozze del composer.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Locale } from '@shared/i18n'
import { DEFAULT_NOTIFY_PREFS, normalizeNotifyPrefs, type NotifyPrefs } from '@/lib/notify-prefs'
import { DEFAULT_THEME_PREFS, type ThemePrefs } from '@/theme/prefs-types'

interface PrefsState {
  theme: ThemePrefs
  language: 'system' | Locale
  /** Notifiche push: quali eventi e la fascia silenziosa. Le possiede il telefono; il Mac le riceve con `device.notify.set`. */
  notify: NotifyPrefs
  /** Sezioni del Mac chiuse (true) o aperte (false) dall'utente; assente = decide "ha qualcosa di vivo". */
  collapsed: Record<string, boolean>
  /** Bozza del composer per sessione: resta anche senza connessione. */
  drafts: Record<string, string>
  setTheme: (patch: Partial<ThemePrefs>) => void
  setLanguage: (language: 'system' | Locale) => void
  setNotify: (patch: Partial<Omit<NotifyPrefs, 'events' | 'quiet'>> & { events?: Partial<NotifyPrefs['events']>; quiet?: Partial<NotifyPrefs['quiet']> }) => void
  setCollapsed: (sectionId: string, collapsed: boolean) => void
  setDraft: (sessionId: string, text: string) => void
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      theme: DEFAULT_THEME_PREFS,
      language: 'system',
      notify: DEFAULT_NOTIFY_PREFS,
      collapsed: {},
      drafts: {},
      setTheme: (patch) => set((s) => ({ theme: { ...s.theme, ...patch } })),
      setLanguage: (language) => set({ language }),
      setNotify: (patch) =>
        set((s) => ({ notify: { ...s.notify, ...patch, events: { ...s.notify.events, ...patch.events }, quiet: { ...s.notify.quiet, ...patch.quiet } } })),
      setCollapsed: (sectionId, collapsed) => set((s) => ({ collapsed: { ...s.collapsed, [sectionId]: collapsed } })),
      setDraft: (sessionId, text) =>
        set((s) => {
          const drafts = { ...s.drafts }
          if (text) drafts[sessionId] = text
          else delete drafts[sessionId]
          return { drafts }
        })
    }),
    {
      name: 'ladder-prefs-v1',
      storage: createJSONStorage(() => AsyncStorage),
      // Le notifiche si rileggono con validazione: un valore salvato rovinato non deve mai arrivare al Mac.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<PrefsState>
        return { ...current, ...saved, notify: normalizeNotifyPrefs(saved.notify) }
      }
    }
  )
)
