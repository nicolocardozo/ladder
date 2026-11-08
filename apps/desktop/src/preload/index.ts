import { contextBridge, ipcRenderer } from 'electron'
import { DEFAULT_THEME, THEMES } from '@shared/themes.generated'
import type { AppPrefs, AttentionEvent, IssueList, WindowView } from '@shared/protocol'

// La porta verso l'host arriva dal processo main e va girata al mondo della pagina:
// con contextIsolation il renderer non vede ipcRenderer, ma riceve la porta con window.postMessage.
ipcRenderer.on('ladder:host-port', (event) => {
  window.postMessage('ladder:host-port', '*', event.ports)
})

// Tema scelto, passato dal main come argomento: si applica a <html> appena esiste, prima del primo paint.
const argument = process.argv.find((arg) => arg.startsWith('--ladder-theme='))?.split('=')[1]
const initialTheme = THEMES.some((t) => t.id === argument) ? argument! : DEFAULT_THEME
function applyTheme(id: string): boolean {
  const root = document.documentElement
  if (!root) return false
  const theme = THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!
  root.dataset.theme = theme.id
  root.classList.toggle('dark', theme.appearance === 'dark')
  return true
}
if (!applyTheme(initialTheme)) {
  const observer = new MutationObserver(() => {
    if (applyTheme(initialTheme)) observer.disconnect()
  })
  observer.observe(document, { childList: true })
}

const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('ladder:pick-folder'),
  /** Apre file e riga nell'editor del progetto; senza `editor` prova Cursor e poi VS Code. */
  openInEditor: (path: string, line?: number, editor?: 'cursor' | 'vscode'): Promise<void> =>
    ipcRenderer.invoke('ladder:open-in-editor', path, line, editor),
  /** Editor installati, per il menu "Apri in…". */
  editors: (): Promise<{ cursor: boolean; vscode: boolean }> => ipcRenderer.invoke('ladder:editors'),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('ladder:reveal', path),
  theme: {
    initial: initialTheme,
    /** Salva il tema per tutta l'app e lo applica a tutte le finestre. */
    set: (id: string): Promise<string> => ipcRenderer.invoke('ladder:set-theme', id),
    onChange: (listener: (id: string) => void): (() => void) => {
      const handler = (_event: unknown, id: string) => listener(id)
      ipcRenderer.on('ladder:theme', handler)
      return () => ipcRenderer.off('ladder:theme', handler)
    }
  },
  onOpenSettings: (listener: () => void): (() => void) => {
    const handler = () => listener()
    ipcRenderer.on('ladder:open-settings', handler)
    return () => ipcRenderer.off('ladder:open-settings', handler)
  },
  /** Progetto e sessione che hai davanti: il main non notifica ciò che stai già guardando. */
  setView: (view: WindowView): void => ipcRenderer.send('ladder:view', view),
  /** Clic su una notifica o un link ladder://: apri la sessione e scorri all'elemento. */
  onOpenSession: (listener: (target: { sessionId: string; itemId: string | null }) => void): (() => void) => {
    const handler = (_event: unknown, target: { sessionId: string; itemId: string | null }) => listener(target)
    ipcRenderer.on('ladder:open-session', handler)
    return () => ipcRenderer.off('ladder:open-session', handler)
  },
  /** Banner di prova di macOS: false se il sistema non supporta le notifiche. */
  testNotification: (): Promise<boolean> => ipcRenderer.invoke('ladder:test-notification'),
  prefs: {
    get: (): Promise<AppPrefs> => ipcRenderer.invoke('ladder:prefs'),
    set: (patch: Partial<AppPrefs>): Promise<AppPrefs> => ipcRenderer.invoke('ladder:set-prefs', patch),
    onChange: (listener: (prefs: AppPrefs) => void): (() => void) => {
      const handler = (_event: unknown, prefs: AppPrefs) => listener(prefs)
      ipcRenderer.on('ladder:prefs', handler)
      return () => ipcRenderer.off('ladder:prefs', handler)
    }
  },
  linear: {
    status: (): Promise<{ connected: boolean; name: string | null; error: string | null }> => ipcRenderer.invoke('ladder:linear-status'),
    setKey: (key: string | null): Promise<{ connected: boolean; name: string | null; error: string | null }> => ipcRenderer.invoke('ladder:linear-set-key', key),
    issues: (search: string): Promise<IssueList> => ipcRenderer.invoke('ladder:linear-issues', search)
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('ladder:open-external', url),
  debug: {
    clickNotification: (): Promise<boolean> => ipcRenderer.invoke('ladder:debug-click-notification'),
    badge: (): Promise<number> => ipcRenderer.invoke('ladder:debug-badge'),
    attention: (event: AttentionEvent): Promise<void> => ipcRenderer.invoke('ladder:debug-attention', event),
    focus: (focused: boolean | null): Promise<void> => ipcRenderer.invoke('ladder:debug-focus', focused)
  }
}

contextBridge.exposeInMainWorld('ladder', api)

export type LadderApi = typeof api
