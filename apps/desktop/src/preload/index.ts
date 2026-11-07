import { contextBridge, ipcRenderer } from 'electron'
import { DEFAULT_THEME, THEMES } from '@shared/themes.generated'

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
  openInEditor: (path: string, line?: number): Promise<void> => ipcRenderer.invoke('ladder:open-in-editor', path, line),
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
  }
}

contextBridge.exposeInMainWorld('ladder', api)

export type LadderApi = typeof api
