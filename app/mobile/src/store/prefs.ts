// Phone preferences, saved locally (AsyncStorage): theme, language, notifications, open/closed sections, composer drafts.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Locale } from '@shared/i18n'
import { applyLocale } from '@/i18n'
import { DEFAULT_FOLLOW, normalizeFollow, type FollowOverride, type FollowPrefs } from '@/lib/live-activity'
import { DEFAULT_NOTIFY_PREFS, normalizeNotifyPrefs, type NotifyPrefs } from '@/lib/notify-prefs'
import { DEFAULT_THEME_PREFS, type ThemePrefs } from '@/theme/prefs-types'

interface PrefsState {
  theme: ThemePrefs
  language: 'system' | Locale
  /** Push notifications: which events and the quiet hours. Owned by the phone; the Mac receives them with `device.notify.set`. */
  notify: NotifyPrefs
  /** Live Activity on the lock screen: master switch, auto-start, per-session choice. iOS only. */
  live: FollowPrefs
  /** "Agent activity" widget: writes the titles of waiting sessions into the app's shared group. */
  widget: boolean
  /** The widget also writes the titles of waiting sessions (off by default): outside the encrypted cache, in backups. */
  widgetTitles: boolean
  /** Mac sections closed (true) or opened (false) by the user; absent = decided by "has something live". */
  collapsed: Record<string, boolean>
  /** Composer draft per session: kept even without a connection. */
  drafts: Record<string, string>
  /** The last project where a session was started from the phone: "New session" starts from there when not in a project. */
  lastProject: string | null
  setLastProject: (projectId: string) => void
  setTheme: (patch: Partial<ThemePrefs>) => void
  setLanguage: (language: 'system' | Locale) => void
  setNotify: (patch: Partial<Omit<NotifyPrefs, 'events' | 'quiet'>> & { events?: Partial<NotifyPrefs['events']>; quiet?: Partial<NotifyPrefs['quiet']> }) => void
  setLive: (patch: Partial<Omit<FollowPrefs, 'overrides'>>) => void
  /** Choice for a session; null removes the choice and returns to automatic. */
  setSessionFollow: (sessionId: string, follow: FollowOverride | null) => void
  setWidget: (widget: boolean) => void
  setWidgetTitles: (widgetTitles: boolean) => void
  setCollapsed: (sectionId: string, collapsed: boolean) => void
  setDraft: (sessionId: string, text: string) => void
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      theme: DEFAULT_THEME_PREFS,
      language: 'system',
      notify: DEFAULT_NOTIFY_PREFS,
      live: DEFAULT_FOLLOW,
      widget: true,
      widgetTitles: false,
      collapsed: {},
      drafts: {},
      lastProject: null,
      setLastProject: (lastProject) => set({ lastProject }),
      setTheme: (patch) => set((s) => ({ theme: { ...s.theme, ...patch } })),
      // The language is applied before notifying: whoever redraws on the change already sees the new texts.
      setLanguage: (language) => {
        applyLocale(language)
        set({ language })
      },
      setNotify: (patch) =>
        set((s) => ({ notify: { ...s.notify, ...patch, events: { ...s.notify.events, ...patch.events }, quiet: { ...s.notify.quiet, ...patch.quiet } } })),
      setLive: (patch) => set((s) => ({ live: { ...s.live, ...patch } })),
      setSessionFollow: (sessionId, follow) =>
        set((s) => {
          const overrides = { ...s.live.overrides }
          delete overrides[sessionId]
          if (follow) overrides[sessionId] = follow
          return { live: { ...s.live, overrides: normalizeFollow({ ...s.live, overrides }).overrides } }
        }),
      setWidget: (widget) => set({ widget }),
      setWidgetTitles: (widgetTitles) => set({ widgetTitles }),
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
      // Notifications are re-read with validation: a corrupted saved value must never reach the Mac.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<PrefsState>
        return { ...current, ...saved, notify: normalizeNotifyPrefs(saved.notify), live: normalizeFollow(saved.live), widget: typeof saved.widget === 'boolean' ? saved.widget : true, widgetTitles: saved.widgetTitles === true }
      }
    }
  )
)

/** Follows the chosen language: makes things that translate text outside components redraw (header titles, tab labels). */
export const useLanguage = (): 'system' | Locale => usePrefs((s) => s.language)
