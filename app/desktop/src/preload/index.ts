import { contextBridge, ipcRenderer } from 'electron'
import { DEFAULT_THEME, THEMES } from '@shared/themes.generated'
import type { AppPrefs, Attachment, AttentionEvent, BrowserAction, BrowserBounds, BrowserNavigateResult, BrowserShortcut, BrowserState, EditorAvailability, EditorId, IssueList, WindowView } from '@shared/protocol'
import type { UpdateState } from '@shared/updates'

// The port to the host comes from the main process and must be passed to the page's world:
// with contextIsolation the renderer does not see ipcRenderer, but receives the port with window.postMessage.
ipcRenderer.on('ladder:host-port', (event) => {
  window.postMessage('ladder:host-port', '*', event.ports)
})

// Chosen language, passed by main like the theme: the interface starts out in the right language.
const localeArgument = process.argv.find((arg) => arg.startsWith('--ladder-locale='))?.split('=')[1]
const initialLocale = localeArgument === 'it' ? 'it' : 'en'

// Chosen theme, passed by main as an argument: applied to <html> as soon as it exists, before the first paint.
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

// Fullscreen: the traffic lights disappear, so <html> carries data-fullscreen and the CSS zeroes their space.
// The state belongs to the window; the initial value is synchronous, so after a reload there is no jump.
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
  /** Language at startup; changes arrive with prefs.onChange. */
  locale: initialLocale as 'en' | 'it',
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('ladder:pick-folder'),
  /** "Save as": chosen path or null if you cancel. `defaultName` is the suggested name. */
  pickSavePath: (defaultName: string): Promise<string | null> => ipcRenderer.invoke('ladder:pick-save-path', defaultName),
  /** Opens file and line in the given editor (otherwise the one from preferences); replies with the editor used, null if the default app was launched. */
  openInEditor: (path: string, line?: number, editor?: EditorId): Promise<EditorId | null> =>
    ipcRenderer.invoke('ladder:open-in-editor', path, line, editor),
  /** Installed editors, for the "Open in…" menu and for settings. */
  editors: (): Promise<EditorAvailability> => ipcRenderer.invoke('ladder:editors'),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('ladder:reveal', path),
  theme: {
    initial: initialTheme,
    /** Saves the theme for the whole app and applies it to all windows. */
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
  /** Project and session you are looking at: main does not notify about what you are already watching. */
  setView: (view: WindowView): void => ipcRenderer.send('ladder:view', view),
  /** Click on a notification or a ladder:// link: open the session and scroll to the item. */
  onOpenSession: (listener: (target: { sessionId: string; itemId: string | null }) => void): (() => void) => {
    const handler = (_event: unknown, target: { sessionId: string; itemId: string | null }) => listener(target)
    ipcRenderer.on('ladder:open-session', handler)
    return () => ipcRenderer.off('ladder:open-session', handler)
  },
  /** macOS test banner: false if the system does not support notifications. */
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
  /** Built-in browser: one native view per tab, positioned with bounds and hidden with visible(false). */
  browser: {
    /** Creates the view (hidden) or returns the existing one; `url` is the first page. */
    open: (tabId: string, projectId: string, url?: string): Promise<BrowserState | null> => ipcRenderer.invoke('ladder:browser-open', tabId, projectId, url),
    setBounds: (tabId: string, bounds: BrowserBounds): void => ipcRenderer.send('ladder:browser-bounds', tabId, bounds),
    setVisible: (tabId: string, visible: boolean): void => ipcRenderer.send('ladder:browser-visible', tabId, visible),
    navigate: (tabId: string, input: string): Promise<BrowserNavigateResult> => ipcRenderer.invoke('ladder:browser-navigate', tabId, input),
    action: (tabId: string, action: BrowserAction): Promise<void> => ipcRenderer.invoke('ladder:browser-action', tabId, action),
    openExternal: (tabId: string): Promise<void> => ipcRenderer.invoke('ladder:browser-open-external', tabId),
    /** Page as an image attachment (PNG, or JPEG if it exceeds 5 MB); null if there is nothing to capture; rejects with a translated error if it does not fit the limit. */
    screenshot: (tabId: string): Promise<Attachment | null> => ipcRenderer.invoke('ladder:browser-screenshot', tabId),
    selection: (tabId: string): Promise<string> => ipcRenderer.invoke('ladder:browser-selection', tabId),
    /** Tab closed or project removed; clearData also deletes the project's cookies and storage. */
    destroy: (tabId: string, clearData?: boolean): Promise<void> => ipcRenderer.invoke('ladder:browser-destroy', tabId, clearData),
    /** Deletes all data of the project's partition (cookies, storage, cache, credentials) and destroys its views. */
    purge: (projectId: string): Promise<void> => ipcRenderer.invoke('ladder:browser-purge', projectId),
    /** App shortcuts pressed while the page has focus (the page does not receive them). */
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
  updates: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke('ladder:update-state'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('ladder:update-check'),
    install: (): Promise<void> => ipcRenderer.invoke('ladder:update-install'),
    onChange: (cb: (state: UpdateState) => void): (() => void) => {
      const handler = (_event: unknown, state: UpdateState) => cb(state)
      ipcRenderer.on('ladder:update', handler)
      return () => ipcRenderer.off('ladder:update', handler)
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
