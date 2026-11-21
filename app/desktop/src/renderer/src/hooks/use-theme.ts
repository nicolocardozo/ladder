// Tema del workspace e finestra delle impostazioni.
// Il tema vale per tutta l'app: lo salva il processo main, che lo applica anche prima del primo paint.
import { create } from 'zustand'
import { THEMES, themeById, type ThemeId, type ThemeInfo } from '@shared/themes.generated'

const PREVIEW_KEY = 'ladder.preview-theme'

/** Applica il tema a <html>: attributo per le variabili, classe `dark` per le varianti di shadcn. */
export function applyTheme(id: string): ThemeInfo {
  const theme = themeById(id)
  document.documentElement.dataset.theme = theme.id
  document.documentElement.classList.toggle('dark', theme.appearance === 'dark')
  return theme
}

function initialTheme(): ThemeId {
  if (window.ladder) return themeById(window.ladder.theme.initial).id
  // Pagine di anteprima nel browser: il tema resta solo in questo browser.
  try {
    return themeById(localStorage.getItem(PREVIEW_KEY)).id
  } catch {
    return themeById(null).id
  }
}

export type SettingsSection = 'appearance' | 'notifications' | 'agents' | 'integrations'

interface SettingsState {
  theme: ThemeId
  settingsOpen: boolean
  section: SettingsSection
  /** Apre le impostazioni su una sezione. */
  openSection: (section: SettingsSection) => void
  setSection: (section: SettingsSection) => void
  setTheme: (id: ThemeId) => void
  /** Aggiorna lo stato quando il tema cambia da un'altra finestra. */
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
        // Solo una comodità dell'anteprima.
      }
    }
  },
  receiveTheme: (id) => set({ theme: applyTheme(id).id }),
  setSettingsOpen: (open) => set({ settingsOpen: open })
}))

export { THEMES }
