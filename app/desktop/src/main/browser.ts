// Browser integrato (LAD-57): una WebContentsView per tab, con partizione isolata per progetto.
// La UI manda rettangolo, visibilità e comandi; qui si decide cosa la pagina può fare.
import { BrowserWindow, ipcMain, session, shell, WebContentsView, type Session } from 'electron'
import { t } from '@shared/i18n'
import { isAppShortcut, pageKeepsReload } from './browser-shortcuts'
import { parseAgentUrl } from '@shared/agent-browser'
import type { Attachment, BrowserAction, BrowserBounds, BrowserNavigateResult, BrowserShortcut, BrowserState } from '@shared/protocol'

/** LAD-57 parte 2: stato della tab del browser dell'agente (quella dell'utente non ce l'ha). */
export interface AgentTab {
  sessionId: string
  /** Domini ammessi oltre a localhost, dopo la conferma dell'utente; `any` con Full access. */
  hosts: Set<string>
  any: boolean
  /** Stop dell'utente: ogni operazione dell'agente è rifiutata finché non c'è resume. */
  stopped: boolean
  /** Host dell'ultimo indirizzo bloccato (navigazione o redirect) dall'ultima operazione dell'agente. */
  blocked: string | null
  /** Ultimi messaggi della console della pagina (anello). */
  console: { level: string; text: string }[]
  /** Fatta la prima navigazione (about:blank): senza, la vista nascosta non ha una superficie e capturePage fallisce (vedi navigate). */
  primed: boolean
}

export interface Tab {
  view: WebContentsView
  window: BrowserWindow
  state: BrowserState
  visible: boolean
  bounds: BrowserBounds
  /** Tab dell'agente: la UI ha mandato misure vere; finché no, le misure sono quelle di partenza e la vista non si mostra. */
  measured?: boolean
  agent?: AgentTab
}

/** Chiave = finestra + id della tab: lo stesso tabId in due finestre sono due viste distinte. */
export const tabs = new Map<string, Tab>()
export const keyOf = (window: BrowserWindow, tabId: string): string => `${window.webContents.id}:${tabId}`
const SELECTION_MAX = 20_000
const SELECTION_TIMEOUT_MS = 2_000
const SELECTION_WORLD = 999
const SHOT_MAX_WIDTH = 1600
const SHOT_MIN_WIDTH = 600
/** Stesso limite delle immagini del composer (MAX_IMAGE_BYTES in composer/attachments.tsx). */
const SHOT_MAX_BYTES = 5 * 1024 * 1024
const NO_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }

const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url)

/** Id di progetto ripulito per il nome della partizione. */
const partitionOf = (projectId: string): string => `persist:project-${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}`

// ── LAD-57 parte 2: browser dell'agente ──
/** Id delle tab dell'agente: `agent:<sessionId>`. La UI non può crearle: le crea il main quando l'agente usa uno strumento. */
export const AGENT_TAB_PREFIX = 'agent:'
/** Partizione dell'agente: in memoria (nessun `persist:`), una per sessione, mai quella dell'utente; sparisce con la sessione. */
const agentPartitionOf = (projectId: string, sessionId: string): string => `project-${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}-agent-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`
const AGENT_CONSOLE_MAX = 200

/** La tab dell'agente può aprire questo indirizzo? Localhost sempre; gli altri domini solo se l'utente li ha autorizzati. */
export function agentAllows(agent: AgentTab, url: string): boolean {
  const parsed = parseAgentUrl(url)
  return parsed.ok && (parsed.local || agent.any || agent.hosts.has(parsed.host))
}

/** Richieste di sottorisorse (immagini, script, fetch, websocket): stessa regola, ws/wss come http/https; data:, blob: e about: sono interni alla pagina. */
function agentAllowsRequest(agent: AgentTab, url: string): boolean {
  if (/^(data:|blob:|about:)/i.test(url)) return true
  return agentAllows(agent, url.replace(/^ws(s?):/i, 'http$1:'))
}

let agentClosedHook: ((sessionId: string) => void) | null = null
/** Chiamato quando una tab dell'agente sparisce (tab chiusa dall'utente, finestra chiusa, close dall'host). */
export function onAgentTabClosed(hook: (sessionId: string) => void): void {
  agentClosedHook = hook
}

/**
 * Crea la vista dell'agente (nascosta) nella finestra data. Nasce con misure realistiche (l'area della finestra), non 0x0:
 * una vista a 0x0 non produce immagini né layout per lo screenshot e la lettura. La UI le sostituisce con le sue quando la tab è montata.
 */
export function createAgentTab(window: BrowserWindow, sessionId: string, projectId: string): Tab {
  const content = window.getContentBounds()
  const bounds: BrowserBounds = { x: 0, y: 0, width: content.width >= 400 ? content.width : 1280, height: content.height >= 300 ? content.height : 800 }
  return create(window, `${AGENT_TAB_PREFIX}${sessionId}`, projectId, sessionId, bounds)
}

/** Screenshot ridotto: PNG, o JPEG 85 sempre più stretto finché entra in `maxBytes`; null se non ci riesce. Usato dalla tab dell'utente e da quella dell'agente. */
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
// ── Fine LAD-57 parte 2 ──

/** Indirizzi del computer o della rete locale: restano in http. */
function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '0.0.0.0') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/**
 * Indirizzo scritto a mano. Schema esplicito: solo http/https. Senza schema (anche `host:porta`): http per localhost e reti
 * private, https per il resto. Testo con spazi e senza punti non è un indirizzo: errore, non una ricerca.
 */
function normalize(input: string): { url: string } | { error: string } {
  const text = input.trim()
  if (!text) return { error: t('Enter an address.') }
  // `localhost:3000` non è uno schema: dopo i due punti c'è una porta.
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d+(?:[/?#]|$))/i.exec(text)
  if (scheme) {
    try {
      const url = new URL(text)
      if (url.protocol === 'http:' || url.protocol === 'https:') return { url: url.toString() }
    } catch {
      // Cade nell'errore qui sotto.
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

/** La partizione non ha mai i permessi del sistema: camera, microfono, notifiche, geolocalizzazione… negati. */
const hardened = new WeakSet<Session>()
function harden(ses: Session): void {
  if (hardened.has(ses)) return
  hardened.add(ses)
  // Solo copia negli appunti (senza lettura) e schermo intero; il resto è negato.
  const allowed = (permission: string): boolean => permission === 'clipboard-sanitized-write' || permission === 'fullscreen'
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed(permission)))
  ses.setPermissionCheckHandler((_contents, permission) => allowed(permission))
  ses.setDevicePermissionHandler(() => false)
  // Niente download dalla pagina: non c'è una cartella dove metterli e non li ha chiesti l'utente.
  ses.on('will-download', (event) => event.preventDefault())
  // Il browser non si presenta come Electron o come Ladder.
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
  // about:blank della tab dell'agente è la navigazione di preparazione, non una pagina da mostrare.
  patch(tab, { url: tab.agent && current === 'about:blank' ? tab.state.url : current || tab.state.url, canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward() })
}

function applyBounds(tab: Tab): void {
  const b = tab.bounds
  // Il renderer misura in pixel CSS, la vista vuole DIP: con lo zoom della finestra (⌘+ / ⌘−) i due differiscono.
  const zoom = tab.window.isDestroyed() ? 1 : tab.window.webContents.getZoomFactor()
  tab.view.setBounds({ x: Math.round(b.x * zoom), y: Math.round(b.y * zoom), width: Math.max(0, Math.round(b.width * zoom)), height: Math.max(0, Math.round(b.height * zoom)) })
  // Rettangolo vuoto o tab non attiva: la vista non deve coprire nulla né prendere eventi, e non deve far sentire l'audio.
  const shown = tab.visible && b.width > 0 && b.height > 0 && (!tab.agent || tab.measured === true)
  tab.view.setVisible(shown)
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.setAudioMuted(!shown)
}

/** Hook per finestra, una volta sola: un reload dell'app lascerebbe le viste native sopra la pagina che sta ricaricando. */
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
  // Il renderer rimostra le viste quando si rimonta.
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) hideAll()
  })
  contents.on('render-process-gone', hideAll)
  // Zoom con ⌃+rotella: i bounds in DIP cambiano anche se il renderer non li rimanda.
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
    // Rete dell'agente: solo localhost e i domini autorizzati, anche per le sottorisorse (niente CDN o tracker non richiesti).
    ses.webRequest.onBeforeRequest((details, callback) => {
      const ok = agentAllowsRequest(agent, details.url)
      // `blocked` è l'host che l'agente deve chiedere all'utente: solo per la pagina principale, non per una sottorisorsa (tracker, CDN).
      if (!ok && details.resourceType === 'mainFrame') agent.blocked = (() => { try { return new URL(details.url).hostname } catch { return null } })()
      callback({ cancel: !ok })
    })
    // Vista nascosta o coperta: senza questo Chromium rallenta timer e rendering e lo screenshot arriva vecchio o vuoto.
    contents.setBackgroundThrottling(false)
    // WebRTC non passa da webRequest. `disable_non_proxied_udp` vieta l'UDP diretto (STUN e candidati host) ma, senza proxy configurato, non è una
    // garanzia di rete chiusa: un relay TURN su TCP/TLS può ancora uscire. Non è un confine di sicurezza; il confine reale è la rete della pagina principale e delle sottorisorse.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    contents.on('console-message', (event) => {
      agent.console.push({ level: event.level, text: String(event.message).slice(0, 1000) })
      if (agent.console.length > AGENT_CONSOLE_MAX) agent.console.shift()
    })
  }

  // Avviso non bloccante: la pagina valida resta com'è, la UI mostra il testo.
  const blocked = (url: string): void => patch(tab, { notice: t('Blocked a non-web link: {url}', { url: url.length > 120 ? `${url.slice(0, 117)}…` : url }) })
  // Nessuna finestra Electron: http/https si apre nella stessa vista, il resto si scarta.
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url) && (!tab.agent || agentAllows(tab.agent, url))) void contents.loadURL(url).catch(() => undefined)
    else blocked(url)
    return { action: 'deny' }
  })
  // Frame principale: solo http/https, anche nei redirect; un link mailto: o simili non toglie la pagina, avvisa soltanto.
  // Sotto-frame: la sandbox c'è già, si ammettono i documenti interni (srcdoc, blob, data) e si blocca il resto (file:, javascript:…).
  const guard = (event: { preventDefault: () => void }, url: string, isMainFrame: boolean): void => {
    if (isWebUrl(url)) {
      // Browser dell'agente: una navigazione o un redirect fuori dai domini ammessi si ferma qui (anche con un clic dell'agente).
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

  // Scorciatoie dell'app mentre la pagina ha il focus: vanno al renderer, la pagina non le vede.
  contents.on('before-input-event', (event, input) => {
    // ⌘R è della pagina: si salta l'acceleratore del menu (reload della finestra dell'app) per questo tasto, e solo per questo.
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
    // -3: caricamento interrotto da una nuova navigazione o da stop, non è un errore.
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
  // Browser dell'agente: la partizione è in memoria e si svuota sempre (cookie, storage, cache, credenziali).
  if (tab.agent) clearData = true
  try {
    if (!tab.window.isDestroyed()) tab.window.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  } catch {
    // Finestra o contenuto già chiusi.
  }
  // Cookie e storage del progetto si cancellano solo su richiesta (progetto rimosso).
  if (clearData && ![...tabs.values()].some((other) => other.view.webContents.session === ses)) {
    void ses.clearStorageData().catch(() => undefined)
    // L'oggetto sessione di una partizione non si può eliminare (nessuna API): resta vuoto in memoria fino alla chiusura dell'app.
    if (tab.agent) {
      ses.webRequest.onBeforeRequest(null)
      void Promise.allSettled([ses.clearCache(), ses.clearAuthCache(), ses.clearHostResolverCache(), ses.closeAllConnections()])
    }
  }
  if (tab.agent) agentClosedHook?.(tab.agent.sessionId)
}

/** Host terminato: le viste dell'agente non hanno più chi le governa (permessi `any`/domini compresi) e il nuovo host non le conosce; si distruggono tutte. */
export function destroyAgentTabs(): void {
  for (const [key, tab] of [...tabs]) if (tab.agent) destroy(key)
}

/** Finestra chiusa: le sue tab vanno distrutte, altrimenti i processi di rendering restano. */
export function destroyWindowTabs(window: BrowserWindow): void {
  for (const [key, tab] of [...tabs]) if (tab.window === window) destroy(key)
}

export function registerBrowserIpc(): void {
  // La tab si cerca nella finestra che scrive: una finestra non può toccare le viste di un'altra.
  const tabOf = (event: { sender: Electron.WebContents }, id: unknown): Tab | null => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || typeof id !== 'string') return null
    const tab = tabs.get(keyOf(window, id))
    return tab && tab.window === window ? tab : null
  }

  // Crea la vista (nascosta) se non c'è, e restituisce lo stato; `url` è la prima pagina da caricare.
  ipcMain.handle('ladder:browser-open', (event, tabId: string, projectId: string, url?: string): BrowserState | null => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || typeof tabId !== 'string' || typeof projectId !== 'string' || !tabId || !projectId) return null
    const existing = tabs.get(keyOf(window, tabId))
    // Le tab dell'agente le crea solo il main: la UI può soltanto agganciarsi a quella che c'è.
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
    // Tab dell'agente smontata dalla UI (rettangolo vuoto): resta nascosta ma conserva le ultime misure, altrimenti torna a 0x0 e non cattura più.
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

  // Tab non attiva, o dialogo/palette sopra la pagina: la vista nativa starebbe sopra l'HTML, quindi si nasconde.
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
    // Browser dell'agente: l'utente non lo guida da qui (aprirebbe domini che l'agente poi leggerebbe); i suoi indirizzi passano dall'agente.
    if (tab.agent && !agentAllows(tab.agent, target.url)) return { ok: false, error: t('The agent browser only opens localhost by itself. Open other addresses in your own Browser tab.') }
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

  // Apre l'indirizzo corrente nel browser di sistema (solo http/https).
  ipcMain.handle('ladder:browser-open-external', (event, tabId: string) => {
    const tab = tabOf(event, tabId)
    const url = tab?.view.webContents.getURL() ?? ''
    if (isWebUrl(url)) void shell.openExternal(url)
  })

  // Screenshot come allegato immagine, nel formato dei file incollati nel composer: PNG, o JPEG se supera il limite allegati.
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
      // Nessun indirizzo ancora: nome generico.
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const base = `browser-${host}-${stamp}`
    const shot = encodeShot(image, SHOT_MAX_WIDTH, SHOT_MIN_WIDTH)
    // Il renderer lo mostra come "non riesco a catturare": il messaggio chiaro è nell'errore della invoke.
    if (!shot) throw new Error(t('Could not shrink the screenshot under 5 MB.'))
    return { name: `${base}.${shot.mediaType === 'image/png' ? 'png' : 'jpg'}`, mediaType: shot.mediaType, data: shot.data.toString('base64') }
  })

  // Testo selezionato nella pagina (vuoto se non c'è selezione o la pagina non risponde), per "Aggiungi alla chat".
  ipcMain.handle('ladder:browser-selection', async (event, tabId: string): Promise<string> => {
    const tab = tabOf(event, tabId)
    if (!tab) return ''
    try {
      // Mondo isolato: lo script non vede (né è visto da) quello della pagina; il timeout evita una pagina bloccata.
      const run = tab.view.webContents.executeJavaScriptInIsolatedWorld(SELECTION_WORLD, [{ code: 'String(window.getSelection() || "")' }])
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), SELECTION_TIMEOUT_MS)))
      const text = await Promise.race([run, timeout]).finally(() => clearTimeout(timer))
      return typeof text === 'string' ? text.slice(0, SELECTION_MAX) : ''
    } catch {
      return ''
    }
  })

  // Tab chiusa o progetto rimosso; con `clearData` si cancellano anche cookie e storage del progetto (se non resta altra tab).
  ipcMain.handle('ladder:browser-destroy', (event, tabId: string, clearData?: boolean) => {
    const tab = tabOf(event, tabId)
    if (tab) destroy(keyOf(tab.window, tabId), clearData === true)
  })

  // Progetto rimosso: via tutte le viste del progetto (in ogni finestra) e tutti i dati della sua partizione.
  ipcMain.handle('ladder:browser-purge', async (event, projectId: string): Promise<void> => {
    if (!BrowserWindow.fromWebContents(event.sender) || typeof projectId !== 'string' || !projectId) return
    for (const [key, tab] of [...tabs]) if (tab.state.projectId === projectId) destroy(key)
    const ses = session.fromPartition(partitionOf(projectId))
    await Promise.allSettled([ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache()])
  })
}
