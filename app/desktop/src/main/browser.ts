// Built-in browser: one WebContentsView per tab, with an isolated partition per project.
// The UI sends rectangle, visibility and commands; here we decide what the page may do.
import { BrowserWindow, ipcMain, session, shell, WebContentsView, type Session } from 'electron'
import { t } from '@shared/i18n'
import { isAppShortcut, pageKeepsReload } from './browser-shortcuts'
import { parseAgentUrl } from '@shared/agent-browser'
import type { Attachment, BrowserAction, BrowserBounds, BrowserNavigateResult, BrowserShortcut, BrowserState } from '@shared/protocol'

/** State of the agent's browser tab (the user's tab does not have it). */
export interface AgentTab {
  sessionId: string
  /** Domains allowed besides localhost, after user confirmation; `any` with Full access. */
  hosts: Set<string>
  any: boolean
  /** User stop: every agent operation is rejected until resume. */
  stopped: boolean
  /** Host of the last address blocked (navigation or redirect) since the agent's last operation. */
  blocked: string | null
  /** Latest page console messages (ring buffer). */
  console: { level: string; text: string }[]
  /** First navigation done (about:blank): without it, the hidden view has no surface and capturePage fails (see navigate). */
  primed: boolean
}

export interface Tab {
  view: WebContentsView
  window: BrowserWindow
  state: BrowserState
  visible: boolean
  bounds: BrowserBounds
  /** Agent tab: the UI sent real measurements; until then, measurements are the initial ones and the view is not shown. */
  measured?: boolean
  agent?: AgentTab
}

/** Key = window + tab id: the same tabId in two windows is two distinct views. */
export const tabs = new Map<string, Tab>()
export const keyOf = (window: BrowserWindow, tabId: string): string => `${window.webContents.id}:${tabId}`
const SELECTION_MAX = 20_000
const SELECTION_TIMEOUT_MS = 2_000
const SELECTION_WORLD = 999
const SHOT_MAX_WIDTH = 1600
const SHOT_MIN_WIDTH = 600
/** Same limit as composer images (MAX_IMAGE_BYTES in composer/attachments.tsx). */
const SHOT_MAX_BYTES = 5 * 1024 * 1024
const NO_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }

const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url)

/** Project id cleaned up for the partition name. */
const partitionOf = (projectId: string): string => `persist:project-${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}`

// ── Agent browser ────────────────────────
/** Agent tab ids: `agent:<sessionId>`. The UI cannot create them: main creates them when the agent uses a tool. */
export const AGENT_TAB_PREFIX = 'agent:'
/** Agent partition: in memory (no `persist:`), one per session, never the user's; it disappears with the session. */
const agentPartitionOf = (projectId: string, sessionId: string): string => `project-${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}-agent-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`
const AGENT_CONSOLE_MAX = 200

/** Can the agent tab open this address? Localhost always; other domains only if the user authorized them. */
export function agentAllows(agent: AgentTab, url: string): boolean {
  const parsed = parseAgentUrl(url)
  return parsed.ok && (parsed.local || agent.any || agent.hosts.has(parsed.host))
}

/** Subresource requests (images, scripts, fetch, websocket): same rule, ws/wss like http/https; data:, blob: and about: are internal to the page. */
function agentAllowsRequest(agent: AgentTab, url: string): boolean {
  if (/^(data:|blob:|about:)/i.test(url)) return true
  return agentAllows(agent, url.replace(/^ws(s?):/i, 'http$1:'))
}

let agentClosedHook: ((sessionId: string) => void) | null = null
/** Called when an agent tab goes away (tab closed by the user, window closed, close from the host). */
export function onAgentTabClosed(hook: (sessionId: string) => void): void {
  agentClosedHook = hook
}

/**
  * Creates the agent's view (hidden) in the given window. It starts with realistic measurements (the window area), not 0x0:
  * a 0x0 view produces no images or layout for screenshot and reading. The UI replaces them with its own when the tab is mounted.
 */
export function createAgentTab(window: BrowserWindow, sessionId: string, projectId: string): Tab {
  const content = window.getContentBounds()
  const bounds: BrowserBounds = { x: 0, y: 0, width: content.width >= 400 ? content.width : 1280, height: content.height >= 300 ? content.height : 800 }
  return create(window, `${AGENT_TAB_PREFIX}${sessionId}`, projectId, sessionId, bounds)
}

/** Scaled-down screenshot: PNG, or JPEG 85 getting narrower until it fits in `maxBytes`; null if it cannot. Used by the user's tab and the agent's. */
export function encodeShot(source: Electron.NativeImage, maxWidth: number, minWidth: number): { mediaType: 'image/png' | 'image/jpeg'; data: Buffer } | null {
  let image = source
  let width = image.getSize().width
  if (width > maxWidth) {
    image = image.resize({ width: maxWidth })
    width = maxWidth
  }
  const png = image.toPNG()
  if (png.length <= SHOT_MAX_BYTES) return { mediaType: 'image/png', data: png }
  for (let w = width; w >= minWidth; w = Math.floor(w * 0.75)) {
    const jpeg = (w === width ? image : image.resize({ width: w })).toJPEG(85)
    if (jpeg.length <= SHOT_MAX_BYTES) return { mediaType: 'image/jpeg', data: jpeg }
  }
  return null
}

export function destroyTab(key: string): void {
  destroy(key)
}
// ── End of agent browser ─

/** Addresses of the computer or the local network: they stay on http. */
function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '0.0.0.0') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/**
  * Hand-typed address. Explicit scheme: only http/https. Without a scheme (even `host:port`): http for localhost and private
  * networks, https for the rest. Text with spaces and no dots is not an address: error, not a search.
 */
function normalize(input: string): { url: string } | { error: string } {
  const text = input.trim()
  if (!text) return { error: t('Enter an address.') }
  // `localhost:3000` is not a scheme: after the colon there is a port.
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d+(?:[/?#]|$))/i.exec(text)
  if (scheme) {
    try {
      const url = new URL(text)
      if (url.protocol === 'http:' || url.protocol === 'https:') return { url: url.toString() }
    } catch {
      // Falls into the error below.
    }
    return { error: t('Only http and https addresses can be opened here.') }
  }
  if (/\s/.test(text) && !text.includes('.')) return { error: t('Enter an address.') }
  try {
    const host = new URL(`http://${text}`).hostname
    const url = new URL(`${isLocalHost(host) ? 'http' : 'https'}://${text}`)
    return { url: url.toString() }
  } catch {
    return { error: t('Enter an address.') }
  }
}

/** The partition never has system permissions: camera, microphone, notifications, geolocation… denied. */
const hardened = new WeakSet<Session>()
function harden(ses: Session): void {
  if (hardened.has(ses)) return
  hardened.add(ses)
  // Only copy to the clipboard (no reading) and fullscreen; the rest is denied.
  const allowed = (permission: string): boolean => permission === 'clipboard-sanitized-write' || permission === 'fullscreen'
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed(permission)))
  ses.setPermissionCheckHandler((_contents, permission) => allowed(permission))
  ses.setDevicePermissionHandler(() => false)
  // No downloads from the page: there is no folder to put them in and the user did not ask for them.
  ses.on('will-download', (event) => event.preventDefault())
  // The browser does not present itself as Electron or as Ladder.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|Ladder)\/\S+/g, ''))
}

function emit(tab: Tab): void {
  if (!tab.window.isDestroyed()) tab.window.webContents.send('ladder:browser-event', tab.state)
}

function patch(tab: Tab, change: Partial<BrowserState>): void {
  tab.state = { ...tab.state, ...change }
  emit(tab)
}

function sync(tab: Tab): void {
  const nav = tab.view.webContents.navigationHistory
  const current = tab.view.webContents.getURL()
  // The agent tab's about:blank is the preparation navigation, not a page to show.
  patch(tab, { url: tab.agent && current === 'about:blank' ? tab.state.url : current || tab.state.url, canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward() })
}

function applyBounds(tab: Tab): void {
  const b = tab.bounds
  // The renderer measures in CSS pixels, the view wants DIP: with the window zoom (⌘+ / ⌘−) the two differ.
  const zoom = tab.window.isDestroyed() ? 1 : tab.window.webContents.getZoomFactor()
  tab.view.setBounds({ x: Math.round(b.x * zoom), y: Math.round(b.y * zoom), width: Math.max(0, Math.round(b.width * zoom)), height: Math.max(0, Math.round(b.height * zoom)) })
  // Empty rectangle or inactive tab: the view must not cover anything or take events, and must not let audio be heard.
  const shown = tab.visible && b.width > 0 && b.height > 0 && (!tab.agent || tab.measured === true)
  tab.view.setVisible(shown)
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.setAudioMuted(!shown)
}

/** Per-window hook, only once: an app reload would leave native views on top of the page that is reloading. */
const watched = new WeakSet<BrowserWindow>()
function watchWindow(window: BrowserWindow): void {
  if (watched.has(window)) return
  watched.add(window)
  const hideAll = (): void => {
    for (const tab of tabs.values()) {
      if (tab.window !== window) continue
      tab.visible = false
      applyBounds(tab)
    }
  }
  const contents = window.webContents
  // The renderer shows the views again when it remounts.
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) hideAll()
  })
  contents.on('render-process-gone', hideAll)
  // Zoom with ⌃+wheel: the bounds in DIP change even if the renderer does not resend them.
  contents.on('zoom-changed', () => {
    for (const tab of tabs.values()) if (tab.window === window) applyBounds(tab)
  })
}

function create(window: BrowserWindow, tabId: string, projectId: string, agentSessionId?: string, initialBounds: BrowserBounds = NO_BOUNDS): Tab {
  watchWindow(window)
  const ses = session.fromPartition(agentSessionId ? agentPartitionOf(projectId, agentSessionId) : partitionOf(projectId))
  harden(ses)
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false
    }
  })
  const tab: Tab = {
    view,
    window,
    visible: false,
    bounds: initialBounds,
    state: { tabId, projectId, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null, notice: null, ...(agentSessionId ? { agent: { sessionId: agentSessionId } } : {}) },
    ...(agentSessionId ? { agent: { sessionId: agentSessionId, hosts: new Set<string>(), any: false, stopped: false, blocked: null, console: [], primed: false } } : {})
  }
  const contents = view.webContents
  if (tab.agent) {
    const agent = tab.agent
    // Agent network: only localhost and authorized domains, also for subresources (no CDNs or trackers nobody asked for).
    ses.webRequest.onBeforeRequest((details, callback) => {
      const ok = agentAllowsRequest(agent, details.url)
      // `blocked` is the host the agent must ask the user about: only for the main page, not for a subresource (tracker, CDN).
      if (!ok && details.resourceType === 'mainFrame') agent.blocked = (() => { try { return new URL(details.url).hostname } catch { return null } })()
      callback({ cancel: !ok })
    })
    // Hidden or covered view: without this Chromium throttles timers and rendering and the screenshot comes out stale or empty.
    contents.setBackgroundThrottling(false)
    // WebRTC does not go through webRequest. `disable_non_proxied_udp` forbids direct UDP (STUN and host candidates) but, with no proxy configured, is not a
    // guarantee of a closed network: a TURN relay over TCP/TLS can still get out. It is not a security boundary; the real boundary is the network of the main page and subresources.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    contents.on('console-message', (event) => {
      agent.console.push({ level: event.level, text: String(event.message).slice(0, 1000) })
      if (agent.console.length > AGENT_CONSOLE_MAX) agent.console.shift()
    })
  }

  // Non-blocking notice: the valid page stays as it is, the UI shows the text.
  const blocked = (url: string): void => patch(tab, { notice: t('Blocked a non-web link: {url}', { url: url.length > 120 ? `${url.slice(0, 117)}…` : url }) })
  // No Electron window: http/https opens in the same view, anything else is discarded.
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url) && (!tab.agent || agentAllows(tab.agent, url))) void contents.loadURL(url).catch(() => undefined)
    else blocked(url)
    return { action: 'deny' }
  })
  // Main frame: only http/https, also in redirects; a mailto: link or similar does not remove the page, it only warns.
  // Sub-frames: the sandbox is already there, internal documents (srcdoc, blob, data) are allowed and the rest (file:, javascript:…) is blocked.
  const guard = (event: { preventDefault: () => void }, url: string, isMainFrame: boolean): void => {
    if (isWebUrl(url)) {
      // Agent browser: a navigation or redirect outside the allowed domains stops here (even with an agent click).
      if (tab.agent && isMainFrame && !agentAllows(tab.agent, url)) {
        event.preventDefault()
        tab.agent.blocked = parseAgentUrl(url).ok ? new URL(url).hostname : url.slice(0, 80)
        blocked(url)
      }
      return
    }
    if (!isMainFrame && /^(about:blank|about:srcdoc|blob:|data:)/i.test(url)) return
    event.preventDefault()
    if (isMainFrame) blocked(url)
  }
  contents.on('will-navigate', (event) => guard(event, event.url, event.isMainFrame))
  contents.on('will-redirect', (event) => guard(event, event.url, event.isMainFrame))
  contents.on('will-frame-navigate', (event) => guard(event, event.url, event.isMainFrame))

  // App shortcuts while the page has focus: they go to the renderer, the page does not see them.
  contents.on('before-input-event', (event, input) => {
    // ⌘R belongs to the page: the menu accelerator (reload of the app window) is skipped for this key, and only for this one.
    contents.setIgnoreMenuShortcuts(pageKeepsReload(input))
    if (!isAppShortcut(input) || tab.window.isDestroyed()) return
    event.preventDefault()
    const shortcut: BrowserShortcut = { key: input.key, code: input.code, meta: input.meta, ctrl: input.control, alt: input.alt, shift: input.shift }
    tab.window.webContents.send('ladder:browser-shortcut', shortcut)
  })

  contents.on('did-start-loading', () => patch(tab, { loading: true, error: null, notice: null }))
  contents.on('did-stop-loading', () => {
    patch(tab, { loading: false })
    sync(tab)
  })
  contents.on('did-navigate', () => sync(tab))
  contents.on('did-navigate-in-page', () => sync(tab))
  contents.on('page-title-updated', (_event, title) => patch(tab, { title }))
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3: load interrupted by a new navigation or by stop, not an error.
    if (!isMainFrame || code === -3) return
    patch(tab, { loading: false, url, error: { code, description, url } })
  })
  contents.on('render-process-gone', () => patch(tab, { loading: false, error: { code: 0, description: t('The page stopped responding.'), url: tab.state.url } }))

  window.contentView.addChildView(view)
  applyBounds(tab)
  tabs.set(keyOf(window, tabId), tab)
  return tab
}

function destroy(key: string, clearData = false): void {
  const tab = tabs.get(key)
  if (!tab) return
  tabs.delete(key)
  const ses = tab.view.webContents.session
  // Agent browser: the partition is in memory and is always cleared (cookies, storage, cache, credentials).
  if (tab.agent) clearData = true
  try {
    if (!tab.window.isDestroyed()) tab.window.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  } catch {
    // Window or contents already closed.
  }
  // The project's cookies and storage are deleted only on request (project removed).
  if (clearData && ![...tabs.values()].some((other) => other.view.webContents.session === ses)) {
    void ses.clearStorageData().catch(() => undefined)
    // A partition's session object cannot be deleted (no API): it stays empty in memory until the app closes.
    if (tab.agent) {
      ses.webRequest.onBeforeRequest(null)
      void Promise.allSettled([ses.clearCache(), ses.clearAuthCache(), ses.clearHostResolverCache(), ses.closeAllConnections()])
    }
  }
  if (tab.agent) agentClosedHook?.(tab.agent.sessionId)
}

/** Host terminated: agent views no longer have anyone governing them (`any`/domain permissions included) and the new host does not know them; all are destroyed. */
export function destroyAgentTabs(): void {
  for (const [key, tab] of [...tabs]) if (tab.agent) destroy(key)
}

/** Window closed: its tabs must be destroyed, otherwise rendering processes remain. */
export function destroyWindowTabs(window: BrowserWindow): void {
  for (const [key, tab] of [...tabs]) if (tab.window === window) destroy(key)
}

export function registerBrowserIpc(): void {
  // The tab is looked up in the writing window: a window cannot touch another's views.
  const tabOf = (event: { sender: Electron.WebContents }, id: unknown): Tab | null => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || typeof id !== 'string') return null
    const tab = tabs.get(keyOf(window, id))
    return tab && tab.window === window ? tab : null
  }

  // Creates the view (hidden) if it does not exist, and returns the state; `url` is the first page to load.
  ipcMain.handle('ladder:browser-open', (event, tabId: string, projectId: string, url?: string): BrowserState | null => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || typeof tabId !== 'string' || typeof projectId !== 'string' || !tabId || !projectId) return null
    const existing = tabs.get(keyOf(window, tabId))
    // Agent tabs are created only by main: the UI can only attach to the one that exists.
    if (tabId.startsWith(AGENT_TAB_PREFIX)) return existing?.agent && existing.state.projectId === projectId ? existing.state : null
    if (existing) {
      if (existing.state.projectId === projectId) return existing.state
      destroy(keyOf(window, tabId))
    }
    const tab = create(window, tabId, projectId)
    const target = typeof url === 'string' ? normalize(url) : null
    if (target && 'url' in target) void tab.view.webContents.loadURL(target.url).catch(() => undefined)
    return tab.state
  })

  ipcMain.on('ladder:browser-bounds', (event, tabId: string, bounds: BrowserBounds) => {
    const tab = tabOf(event, tabId)
    if (!tab || !bounds) return
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    // Agent tab unmounted by the UI (empty rectangle): stays hidden but keeps the latest measurements, otherwise it goes back to 0x0 and stops capturing.
    if (tab.agent && (n(bounds.width) <= 0 || n(bounds.height) <= 0)) {
      tab.visible = false
      tab.measured = false
      applyBounds(tab)
      return
    }
    tab.measured = true
    tab.bounds = { x: n(bounds.x), y: n(bounds.y), width: n(bounds.width), height: n(bounds.height) }
    applyBounds(tab)
  })

  // Inactive tab, or a dialog/palette over the page: the native view would sit on top of the HTML, so it is hidden.
  ipcMain.on('ladder:browser-visible', (event, tabId: string, visible: boolean) => {
    const tab = tabOf(event, tabId)
    if (!tab) return
    tab.visible = visible === true
    applyBounds(tab)
  })

  ipcMain.handle('ladder:browser-navigate', (event, tabId: string, input: string): BrowserNavigateResult => {
    const tab = tabOf(event, tabId)
    if (!tab) return { ok: false, error: t('This browser tab is closed.') }
    if (typeof input !== 'string') return { ok: false, error: t('Enter an address.') }
    const target = normalize(input)
    if ('error' in target) return { ok: false, error: target.error }
    // Agent browser: the user does not drive it from here (it would open domains the agent then reads); its addresses go through the agent.
    if (tab.agent && !agentAllows(tab.agent, target.url)) return { ok: false, error: t('The agent browser only opens localhost by itself. Open other addresses in a page of your own in the browser.') }
    void tab.view.webContents.loadURL(target.url).catch(() => undefined)
    return { ok: true, url: target.url }
  })

  ipcMain.handle('ladder:browser-action', (event, tabId: string, action: BrowserAction) => {
    const tab = tabOf(event, tabId)
    if (!tab) return
    const contents = tab.view.webContents
    switch (action) {
      case 'back':
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
        break
      case 'forward':
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
        break
      case 'reload':
        contents.reload()
        break
      case 'hard-reload':
        contents.reloadIgnoringCache()
        break
      case 'stop':
        contents.stop()
        break
      case 'focus':
        contents.focus()
        break
      case 'devtools':
        contents.openDevTools({ mode: 'detach' })
        break
    }
  })

  // Opens the current address in the system browser (http/https only).
  ipcMain.handle('ladder:browser-open-external', (event, tabId: string) => {
    const tab = tabOf(event, tabId)
    const url = tab?.view.webContents.getURL() ?? ''
    if (isWebUrl(url)) void shell.openExternal(url)
  })

  // Screenshot as an image attachment, in the format of files pasted into the composer: PNG, or JPEG if it exceeds the attachment limit.
  ipcMain.handle('ladder:browser-screenshot', async (event, tabId: string): Promise<Attachment | null> => {
    const tab = tabOf(event, tabId)
    if (!tab) return null
    let image: Electron.NativeImage
    try {
      image = await tab.view.webContents.capturePage()
    } catch {
      return null
    }
    if (image.isEmpty()) return null
    let host = 'page'
    try {
      host = new URL(tab.view.webContents.getURL()).hostname.replace(/[^A-Za-z0-9.-]/g, '') || host
    } catch {
      // No address yet: generic name.
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const base = `browser-${host}-${stamp}`
    const shot = encodeShot(image, SHOT_MAX_WIDTH, SHOT_MIN_WIDTH)
    // The renderer shows it as "cannot capture": the clear message is in the invoke error.
    if (!shot) throw new Error(t('Could not shrink the screenshot under 5 MB.'))
    return { name: `${base}.${shot.mediaType === 'image/png' ? 'png' : 'jpg'}`, mediaType: shot.mediaType, data: shot.data.toString('base64') }
  })

  // Text selected in the page (empty if there is no selection or the page does not respond), for "Add to chat".
  ipcMain.handle('ladder:browser-selection', async (event, tabId: string): Promise<string> => {
    const tab = tabOf(event, tabId)
    if (!tab) return ''
    try {
      // Isolated world: the script does not see (nor is seen by) the page's one; the timeout avoids a stuck page.
      const run = tab.view.webContents.executeJavaScriptInIsolatedWorld(SELECTION_WORLD, [{ code: 'String(window.getSelection() || "")' }])
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), SELECTION_TIMEOUT_MS)))
      const text = await Promise.race([run, timeout]).finally(() => clearTimeout(timer))
      return typeof text === 'string' ? text.slice(0, SELECTION_MAX) : ''
    } catch {
      return ''
    }
  })

  // Tab closed or project removed; with `clearData` the project's cookies and storage are also deleted (if no other tab remains).
  ipcMain.handle('ladder:browser-destroy', (event, tabId: string, clearData?: boolean) => {
    const tab = tabOf(event, tabId)
    if (tab) destroy(keyOf(tab.window, tabId), clearData === true)
  })

  // Project removed: remove all the project's views (in every window) and all its partition data.
  ipcMain.handle('ladder:browser-purge', async (event, projectId: string): Promise<void> => {
    if (!BrowserWindow.fromWebContents(event.sender) || typeof projectId !== 'string' || !projectId) return
    for (const [key, tab] of [...tabs]) if (tab.state.projectId === projectId) destroy(key)
    const ses = session.fromPartition(partitionOf(projectId))
    await Promise.allSettled([ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache()])
  })
}
