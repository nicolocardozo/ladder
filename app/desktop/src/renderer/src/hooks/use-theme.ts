// Workspace theme and settings window.
// The theme applies to the whole app: the main process saves it and also applies it before the first paint.
import { create } from 'zustand'
import { THEMES, themeById, type ThemeId, type ThemeInfo } from '@shared/themes.generated'

const PREVIEW_KEY = 'ladder.preview-theme'

/** Applies the theme to <html>: attribute for the variables, `dark` class for shadcn variants. */
export function applyTheme(id: string): ThemeInfo {
  const theme = themeById(id)
  document.documentElement.dataset.theme = theme.id
  document.documentElement.classList.toggle('dark', theme.appearance === 'dark')
  return theme
}

function initialTheme(): ThemeId {
  if (window.ladder) return themeById(window.ladder.theme.initial).id
  // Preview pages in the browser: the theme stays only in this browser.
  try {
    return themeById(localStorage.getItem(PREVIEW_KEY)).id
  } catch {
    return themeById(null).id
  }
}

export type SettingsSection = 'appearance' | 'notifications' | 'subscriptions' | 'agents' | 'defaults' | 'integrations' | 'shortcuts' | 'workspace' | 'devices' | 'system'

interface SettingsState {
  theme: ThemeId
  settingsOpen: boolean
  section: SettingsSection
  /** Opens settings on a section. */
  openSection: (section: SettingsSection) => void
  setSection: (section: SettingsSection) => void
  setTheme: (id: ThemeId) => void
  /** Updates the state when the theme changes from another window. */
  receiveTheme: (id: string) => void
  setSettingsOpen: (open: boolean) => void
}

export const useSettings = create<SettingsState>((set) => ({
  theme: initialTheme(),
  settingsOpen: false,
  section: 'appearance',
  openSection: (section) => set({ section, settingsOpen: true }),
  setSection: (section) => set({ section }),
  setTheme: (id) => {
    const theme = applyTheme(id)
    set({ theme: theme.id })
    if (window.ladder) void window.ladder.theme.set(theme.id)
    else {
      try {
        localStorage.setItem(PREVIEW_KEY, theme.id)
      } catch {
        // Just a preview convenience.
      }
    }
  },
  receiveTheme: (id) => set({ theme: applyTheme(id).id }),
  setSettingsOpen: (open) => set({ settingsOpen: open })
}))

export { THEMES }
