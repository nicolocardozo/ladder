import { contextBridge, ipcRenderer } from 'electron'
import { DEFAULT_THEME, THEMES } from '@shared/themes.generated'
import type { AppPrefs, Attachment, AttentionEvent, BrowserAction, BrowserBounds, BrowserNavigateResult, BrowserShortcut, BrowserState, EditorAvailability, EditorId, IssueList, WindowView } from '@shared/protocol'

// La porta verso l'host arriva dal processo main e va girata al mondo della pagina:
// con contextIsolation il renderer non vede ipcRenderer, ma riceve la porta con window.postMessage.
ipcRenderer.on('ladder:host-port', (event) => {
  window.postMessage('ladder:host-port', '*', event.ports)
})

// Lingua scelta, passata dal main come il tema: l'interfaccia nasce già nella lingua giusta.
const localeArgument = process.argv.find((arg) => arg.startsWith('--ladder-locale='))?.split('=')[1]
const initialLocale = localeArgument === 'it' ? 'it' : 'en'

// Tema scelto, passato dal main come argomento: si applica a <html> appena esiste, prima del primo paint.
const argument = process.argv.find((arg) => arg.startsWith('--ladder-theme='))?.split('=')[1]
const initialTheme = THEMES.some((t) => t.id === argument) ? argument! : DEFAULT_THEME
function applyTheme(id: string): boolean {
  const root = document.documentElement
  if (!root) return false
  const theme = THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!
  root.dataset.theme = theme.id
  root.lang = initialLocale
  root.classList.toggle('dark', theme.appearance === 'dark')
  return true
}
if (!applyTheme(initialTheme)) {
  const observer = new MutationObserver(() => {
    if (applyTheme(initialTheme)) observer.disconnect()
  })
  observer.observe(document, { childList: true })
}

// Schermo intero: i semafori spariscono, quindi <html> porta data-fullscreen e il CSS azzera il loro spazio.
// Lo stato è della finestra; il valore iniziale è sincrono, così dopo un reload non c'è nessun salto.
function applyFullScreen(on: boolean): void {
  const root = document.documentElement
  if (root) root.toggleAttribute('data-fullscreen', on)
}
const initialFullScreen = ipcRenderer.sendSync('ladder:is-full-screen') === true
if (!document.documentElement) {
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return
    applyFullScreen(initialFullScreen)
    observer.disconnect()
  })
  observer.observe(document, { childList: true })
} else applyFullScreen(initialFullScreen)
ipcRenderer.on('ladder:full-screen', (_event, on: boolean) => applyFullScreen(on))

const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  /** Lingua all'avvio; i cambi arrivano con prefs.onChange. */
  locale: initialLocale as 'en' | 'it',
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('ladder:pick-folder'),
  /** "Salva con nome": percorso scelto o null se annulli. `defaultName` è il nome proposto. */
  pickSavePath: (defaultName: string): Promise<string | null> => ipcRenderer.invoke('ladder:pick-save-path', defaultName),
  /** Apre file e riga nell'editor indicato (altrimenti quello delle preferenze); risponde l'editor usato, null se è partita l'app predefinita. */
  openInEditor: (path: string, line?: number, editor?: EditorId): Promise<EditorId | null> =>
    ipcRenderer.invoke('ladder:open-in-editor', path, line, editor),
  /** Editor installati, per il menu "Apri in…" e per le impostazioni. */
  editors: (): Promise<EditorAvailability> => ipcRenderer.invoke('ladder:editors'),
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
  /** Browser integrato (LAD-57): una vista nativa per tab, posizionata con bounds e nascosta con visible(false). */
  browser: {
    /** Crea la vista (nascosta) o restituisce quella esistente; `url` è la prima pagina. */
    open: (tabId: string, projectId: string, url?: string): Promise<BrowserState | null> => ipcRenderer.invoke('ladder:browser-open', tabId, projectId, url),
    setBounds: (tabId: string, bounds: BrowserBounds): void => ipcRenderer.send('ladder:browser-bounds', tabId, bounds),
    setVisible: (tabId: string, visible: boolean): void => ipcRenderer.send('ladder:browser-visible', tabId, visible),
    navigate: (tabId: string, input: string): Promise<BrowserNavigateResult> => ipcRenderer.invoke('ladder:browser-navigate', tabId, input),
    action: (tabId: string, action: BrowserAction): Promise<void> => ipcRenderer.invoke('ladder:browser-action', tabId, action),
    openExternal: (tabId: string): Promise<void> => ipcRenderer.invoke('ladder:browser-open-external', tabId),
    /** Pagina come allegato immagine (PNG, o JPEG se supera 5 MB); null se non c'è nulla da catturare; rifiuta con un errore tradotto se non entra nel limite. */
    screenshot: (tabId: string): Promise<Attachment | null> => ipcRenderer.invoke('ladder:browser-screenshot', tabId),
    selection: (tabId: string): Promise<string> => ipcRenderer.invoke('ladder:browser-selection', tabId),
    /** Tab chiusa o progetto rimosso; clearData cancella anche cookie e storage del progetto. */
    destroy: (tabId: string, clearData?: boolean): Promise<void> => ipcRenderer.invoke('ladder:browser-destroy', tabId, clearData),
    /** Cancella tutti i dati della partizione del progetto (cookie, storage, cache, credenziali) e ne distrugge le viste. */
    purge: (projectId: string): Promise<void> => ipcRenderer.invoke('ladder:browser-purge', projectId),
    /** Scorciatoie dell'app premute con il focus nella pagina (la pagina non le riceve). */
    onShortcut: (listener: (shortcut: BrowserShortcut) => void): (() => void) => {
      const handler = (_event: unknown, shortcut: BrowserShortcut) => listener(shortcut)
      ipcRenderer.on('ladder:browser-shortcut', handler)
      return () => ipcRenderer.off('ladder:browser-shortcut', handler)
    },
    onEvent: (listener: (state: BrowserState) => void): (() => void) => {
      const handler = (_event: unknown, state: BrowserState) => listener(state)
      ipcRenderer.on('ladder:browser-event', handler)
      return () => ipcRenderer.off('ladder:browser-event', handler)
    }
  },
  debug: {
    clickNotification: (): Promise<boolean> => ipcRenderer.invoke('ladder:debug-click-notification'),
    badge: (): Promise<number> => ipcRenderer.invoke('ladder:debug-badge'),
    attention: (event: AttentionEvent): Promise<void> => ipcRenderer.invoke('ladder:debug-attention', event),
    focus: (focused: boolean | null): Promise<void> => ipcRenderer.invoke('ladder:debug-focus', focused)
  }
}

contextBridge.exposeInMainWorld('ladder', api)

export type LadderApi = typeof api
