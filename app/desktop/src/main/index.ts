import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { socketPathFor } from '../cli/socket-path.ts'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeImage,
  powerMonitor,
  powerSaveBlocker,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess
} from 'electron'
import { themeById, type ThemeId } from '@shared/themes.generated'
import type { AgentId, AppPrefs, AttentionEvent, BrowserAgentResult, CodeFont, EditorAvailability, EditorId, Effort, HostPrefs, HostToMain, MainToHost, PermissionLevel, RequestSound, SendKey, SessionDefaults, SessionPreset, TextSize, WindowView } from '@shared/protocol'
import { cleanEnv } from '@shared/env'
import { DEFAULT_LOCALE, isLocale, plural, setLocale, t } from '@shared/i18n'
import { acceleratorOf, applyShortcutConfig } from '@shared/shortcuts'
import { cleanBranchPrefix, DEFAULT_BRANCH_PREFIX } from '@shared/worktree-prefs'
import '@shared/locales/it'
import { Attention } from './attention'
import { destroyAgentTabs, destroyWindowTabs, onAgentTabClosed, registerBrowserIpc } from './browser'
import { runAgentOp } from './browser-agent'
import { registerFileProtocol, registerFileScheme, revealFile, setFileRoots } from './file-protocol'
import { linearIssues, linearStatus, setLinearKey } from './linear'
import { remoteIsOn, staysInBackground, wantKeepAwake } from './power-logic'
import { phoneAccessAllowed } from '@shared/remote/availability'
import { TRAY_ICON_1X, TRAY_ICON_2X } from './tray-icon'
import { registerUpdater } from './updater'

app.setName('Ladder')
// The ladder-file scheme must be declared privileged before app.ready.
registerFileScheme()
// Alternative data folder for automated tests or separate profiles.
if (process.env.LADDER_USER_DATA) app.setPath('userData', process.env.LADDER_USER_DATA)
// One profile, one instance: two processes on the same database would fight over sessions and agents.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

let host: UtilityProcess | null = null
const windows = new Set<BrowserWindow>()

// ── App settings (theme): a small JSON file read by main before opening the windows,
// so the theme is applied before the first paint without waiting for the host.
interface AppSettings extends AppPrefs {
  theme: ThemeId
}
// LADDER_LOCALE chooses the initial language of a new profile (automated tests use Italian).
const DEFAULT_PREFS: AppPrefs = { notifications: true, sound: false, dndUntil: null, locale: isLocale(process.env.LADDER_LOCALE) ? process.env.LADDER_LOCALE : DEFAULT_LOCALE, defaults: {}, presets: [], sendKey: 'enter', busySend: 'steer', generatedTitles: true, generatedText: true, chatFont: 'system-sans', chatWidth: 'comfortable', autonomyHint: true, stallHint: false, chatTextSize: 'default', editorTextSize: 12, editorFont: 'system-mono', sidebarDensity: 'comfortable', editor: 'cursor', worktreesDir: null, branchPrefix: DEFAULT_BRANCH_PREFIX, autoArchiveDays: null, openAtLogin: false, keepAwake: false, remote: { enabled: false, relayUrl: null, allowFull: true }, soundName: 'default', agentBrowser: false, userName: null }
const settingsPath = () => join(app.getPath('userData'), 'settings.json')
// Prefs version stored in settings.json (internal key, not in AppPrefs). 2: the default chat font becomes system-sans.
const PREFS_VERSION = 2
// Version read from the file: a downgrade doesn't lower it by rewriting.
let fileVersion = 0
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
const PERMISSIONS: readonly string[] = ['plan', 'ask', 'edit', 'full']
const isAgentId = (v: unknown): v is AgentId => v === 'claude-code' || v === 'codex' || (typeof v === 'string' && v.startsWith('acp:') && v.length > 4)
// The name stays in settings.json, on this Mac only. Trimmed, at most 80 code points (same limit as you-block.tsx), without
// control, bidi (U+202A-202E, U+2066-2069) and zero-width (U+200B-200D, U+2060, U+FEFF) characters; empty = null.
function cleanUserName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = Array.from(raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[\u200b-\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069]/g, '').trim()).slice(0, 80).join('').trim()
  return name || null
}
// Defaults of new sessions: only what is valid is kept, the rest is discarded.
function cleanDefaults(raw: unknown): SessionDefaults {
  const out: SessionDefaults = {}
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (isAgentId(r.agent)) out.agent = r.agent
  const models: Partial<Record<AgentId, string>> = {}
  if (r.models && typeof r.models === 'object') {
    for (const [k, v] of Object.entries(r.models)) if (isAgentId(k) && typeof v === 'string' && v) models[k] = v
  }
  if (Object.keys(models).length) out.models = models
  const efforts: Partial<Record<AgentId, Effort>> = {}
  if (r.efforts && typeof r.efforts === 'object') {
    for (const [k, v] of Object.entries(r.efforts)) if (isAgentId(k) && typeof v === 'string' && EFFORTS.includes(v)) efforts[k] = v as Effort
  }
  if (Object.keys(efforts).length) out.efforts = efforts
  if (typeof r.permission === 'string' && PERMISSIONS.includes(r.permission)) out.permission = r.permission as PermissionLevel
  else if (r.permission === null) out.permission = null
  return out
}
// Session profiles: invalid ones, duplicate names and anything beyond 50 are discarded.
function cleanPresets(raw: unknown): SessionPreset[] {
  if (!Array.isArray(raw)) return []
  const out: SessionPreset[] = []
  const seen = new Set<string>()
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const name = text(r.name, 40)
    const id = text(r.id, 64)
    if (!id || !name || seen.has(id) || !isAgentId(r.agent) || out.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue
    seen.add(id)
    const preset: SessionPreset = {
      id,
      name,
      agent: r.agent,
      permission: typeof r.permission === 'string' && PERMISSIONS.includes(r.permission) ? (r.permission as PermissionLevel) : 'ask',
      worktree: r.worktree === true
    }
    const note = text(r.note, 300)
    if (note) preset.note = note
    if (typeof r.profileId === 'string' && r.profileId) preset.profileId = r.profileId.slice(0, 80)
    if (typeof r.model === 'string' && r.model) preset.model = r.model.slice(0, 120)
    if (typeof r.effort === 'string' && EFFORTS.includes(r.effort)) preset.effort = r.effort as Effort
    if (typeof r.prompt === 'string' && r.prompt.trim()) preset.prompt = r.prompt.slice(0, 4000)
    out.push(preset)
    if (out.length >= 50) break
  }
  return out
}
const TEXT_SIZES: readonly string[] = ['small', 'default', 'large', 'xlarge']
const CODE_FONTS: readonly string[] = ['system-mono', 'monaspace-neon']
const EDITORS: readonly string[] = ['cursor', 'vscode', 'zed', 'xcode']
const SOUNDS: readonly string[] = ['default', 'Glass', 'Ping', 'Pop', 'Hero', 'Submarine', 'Funk', 'Tink']
// Worktrees folder: absolute (with leading ~), otherwise null = default.
function cleanWorktreesDir(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const text = raw.trim()
  const path = text === '~' ? homedir() : text.startsWith('~/') ? join(homedir(), text.slice(2)) : text
  return isAbsolute(path) ? resolve(path) : null
}
function cleanPrefs(raw: Partial<AppPrefs>): AppPrefs {
  const editorTextSize = Number(raw.editorTextSize)
  const archiveDays = Number(raw.autoArchiveDays)
  return {
    notifications: raw.notifications !== false,
    sound: raw.sound === true,
    dndUntil: typeof raw.dndUntil === 'number' && raw.dndUntil > Date.now() ? raw.dndUntil : null,
    locale: isLocale(raw.locale) ? raw.locale : DEFAULT_PREFS.locale,
    defaults: cleanDefaults(raw.defaults),
    presets: cleanPresets(raw.presets),
    sendKey: (raw.sendKey === 'mod-enter' ? 'mod-enter' : 'enter') satisfies SendKey,
    busySend: raw.busySend === 'queue' ? 'queue' : 'steer',
    generatedTitles: raw.generatedTitles !== false,
    generatedText: raw.generatedText !== false,
    chatFont: raw.chatFont === 'system-sans' || raw.chatFont === 'mona-sans' || raw.chatFont === 'monaspace-neon' ? raw.chatFont : 'system-sans',
    chatWidth: raw.chatWidth === 'wide' || raw.chatWidth === 'full' ? raw.chatWidth : 'comfortable',
    autonomyHint: raw.autonomyHint !== false,
    stallHint: raw.stallHint === true,
    chatTextSize: TEXT_SIZES.includes(raw.chatTextSize as string) ? (raw.chatTextSize as TextSize) : DEFAULT_PREFS.chatTextSize,
    editorTextSize: Number.isInteger(editorTextSize) && editorTextSize >= 10 && editorTextSize <= 24 ? editorTextSize : DEFAULT_PREFS.editorTextSize,
    editorFont: CODE_FONTS.includes(raw.editorFont as string) ? (raw.editorFont as CodeFont) : DEFAULT_PREFS.editorFont,
    sidebarDensity: raw.sidebarDensity === 'compact' ? 'compact' : 'comfortable',
    editor: EDITORS.includes(raw.editor as string) ? (raw.editor as EditorId) : DEFAULT_PREFS.editor,
    worktreesDir: cleanWorktreesDir(raw.worktreesDir),
    branchPrefix: cleanBranchPrefix(raw.branchPrefix ?? DEFAULT_BRANCH_PREFIX),
    autoArchiveDays: Number.isInteger(archiveDays) && archiveDays >= 1 && archiveDays <= 365 ? archiveDays : null,
    openAtLogin: raw.openAtLogin === true,
    keepAwake: raw.keepAwake === true,
    remote: cleanRemote(raw.remote),
    soundName: SOUNDS.includes(raw.soundName as string) ? (raw.soundName as RequestSound) : DEFAULT_PREFS.soundName,
    // Off until you turn it on (it gives the agent network and DOM access).
    agentBrowser: raw.agentBrowser === true,
    userName: cleanUserName(raw.userName)
  }
}
function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<AppSettings>
    const read = Number((raw as { prefsVersion?: unknown }).prefsVersion)
    const version = Number.isInteger(read) ? read : 0
    fileVersion = version
    const outdated = version < PREFS_VERSION
    // One-time migration (versions < 2): the monospace font was just the old default.
    if (version < 2 && raw.chatFont === 'system-mono') raw.chatFont = 'system-sans'
    const loaded: AppSettings = { theme: themeById(raw.theme).id, ...cleanPrefs(raw) }
    if (outdated) {
      try {
        saveSettings(loaded)
      } catch {
        // Not writable: the migration is repeated at the next start.
      }
    }
    return loaded
  } catch {
    return { theme: themeById(null).id, ...DEFAULT_PREFS }
  }
}
function saveSettings(settings: AppSettings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify({ ...settings, prefsVersion: Math.max(fileVersion, PREFS_VERSION) }, null, 2))
}
let settings: AppSettings = { theme: themeById(null).id, ...DEFAULT_PREFS }
const prefsOf = (s: AppSettings): AppPrefs => {
  const { theme, ...prefs } = s
  void theme
  return prefs
}
/** Remote channel preference: off if missing or malformed; the relay address must be a non-empty string; `allowFull` is on unless explicitly false. */
function cleanRemote(value: unknown): { enabled: boolean; relayUrl: string | null; allowFull: boolean } {
  const raw = (value && typeof value === 'object' ? value : {}) as { enabled?: unknown; relayUrl?: unknown; allowFull?: unknown }
  return { enabled: raw.enabled === true, relayUrl: typeof raw.relayUrl === 'string' && raw.relayUrl.trim() ? raw.relayUrl.trim() : null, allowFull: raw.allowFull !== false }
}

const hostPrefs = (): HostPrefs => ({ locale: settings.locale, generatedTitles: settings.generatedTitles, generatedText: settings.generatedText, autonomyHint: settings.autonomyHint, stallHint: settings.stallHint, worktreesDir: settings.worktreesDir, branchPrefix: settings.branchPrefix, autoArchiveDays: settings.autoArchiveDays, agentBrowser: settings.agentBrowser, remote: phoneAccessAllowed(app.isPackaged) ? settings.remote : undefined, busySend: settings.busySend, defaults: settings.defaults })

// Screen locked (powerMonitor), to decide on pushes to phones.
let screenLocked = false
const attention = new Attention(
  () => prefsOf(settings),
  (sessionId, itemId) => openSession(sessionId, itemId),
  {
    // LADDER_PUSH_ALWAYS=1 (development only): as if the Mac had been idle for hours, to try pushes while at the computer.
    state: () => ({ idleSeconds: !app.isPackaged && process.env.LADDER_PUSH_ALWAYS === '1' ? Infinity : powerMonitor.getSystemIdleTime(), locked: screenLocked }),
    send: (event) => host?.postMessage({ type: 'push', event } satisfies MainToHost)
  }
)

/** Brings a window to the front (or opens one) and asks it to open the session at the item. */
let pendingOpen: { sessionId: string; itemId: string | null } | null = null
function openSession(sessionId: string, itemId: string | null): void {
  const window = [...windows].find((w) => !w.isDestroyed())
  if (!window) {
    pendingOpen = { sessionId, itemId }
    createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  app.focus({ steal: true })
  window.webContents.send('ladder:open-session', { sessionId, itemId })
}

/** ladder://session/<id>?item=<id>: the destination of notifications, also openable from outside. */
function openUrl(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'ladder:' || parsed.hostname !== 'session') return
    const sessionId = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    if (sessionId) openSession(sessionId, parsed.searchParams.get('item'))
  } catch {
    // Invalid link: ignored.
  }
}

/** Login pages the host can have opened: only https and only the flows' sites (GitHub, ChatGPT, Claude). */
const LOGIN_HOSTS = new Set(['github.com', 'auth.openai.com', 'chatgpt.com', 'claude.ai', 'claude.com'])

function isLoginUrl(url: unknown): url is string {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === 'https:' && LOGIN_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

/** keybindings.json in the system app for .json; if there is none, it is shown in Finder. */
function openKeybindings(): void {
  const file = join(app.getPath('userData'), 'keybindings.json')
  void shell.openPath(file).then((error) => {
    if (error) shell.showItemInFolder(file)
  })
}

// ── System: Mac awake while an agent works, and open at login ──
let runningSessions = 0
// Phones connected to the remote channel (counted by the host).
let phonesConnected = 0
let awakeBlocker: number | null = null

/** Keeps the Mac awake (the screen may turn off) while sessions are working or a phone is connected, if the preference is on. */
function applyKeepAwake(): void {
  const want = wantKeepAwake(settings.keepAwake, runningSessions, phonesConnected)
  if (want && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension')
  else if (!want && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker)
    awakeBlocker = null
  }
  updateTray()
}

/** Remote channel on: from the host preferences (HostPrefs.remote) or, in development, from environment variables. */
const remoteOn = () => remoteIsOn(phoneAccessAllowed(app.isPackaged) && settings.remote?.enabled === true, app.isPackaged, process.env)

// ── Background: without windows Ladder stays in the menu bar, with the host and the remote channel active ──
let tray: Tray | null = null

function trayImage() {
  const image = nativeImage.createEmpty()
  image.addRepresentation({ scaleFactor: 1, buffer: Buffer.from(TRAY_ICON_1X, 'base64') })
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(TRAY_ICON_2X, 'base64') })
  image.setTemplateImage(true)
  return image
}

/** Menu status line: working sessions and connected phone. */
function trayStatus(): string {
  const parts: string[] = []
  if (runningSessions > 0) parts.push(plural(runningSessions, '1 session working', '{n} sessions working'))
  if (phonesConnected > 0) parts.push(t('Phone connected'))
  return parts.length > 0 ? parts.join(' · ') : t('Ladder is running in the background')
}

function updateTray(): void {
  if (!tray || tray.isDestroyed()) return
  const status = trayStatus()
  tray.setToolTip(status)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: t('Open Ladder'), click: () => showWindow() },
      { label: t('Quit Ladder'), click: () => app.quit() }
    ])
  )
}

/** Last window closed with the remote channel on: menu bar icon and no Dock. */
function enterBackground(): void {
  if (!tray) {
    tray = new Tray(trayImage())
  }
  updateTray()
  app.dock?.hide()
}

function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}

function leaveBackground(): void {
  destroyTray()
  void app.dock?.show()
}

/** Brings the window to the front, or reopens it if Ladder was in the background. */
function showWindow(): void {
  const window = [...windows].find((w) => !w.isDestroyed())
  if (!window) return createWindow()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  app.focus({ steal: true })
}

/** In development and in test profiles the login item would point to the Electron binary: it is not registered. */
const canLaunchAtLogin = () => app.isPackaged && !process.env.LADDER_USER_DATA && process.platform === 'darwin'

function applyLoginItem(): void {
  if (canLaunchAtLogin()) app.setLoginItemSettings({ openAtLogin: settings.openAtLogin })
}

/** Starts the sessions host. If it crashes, it restarts it and reconnects the windows. */
function startHost(): void {
  const env: NodeJS.ProcessEnv = { ...process.env, LADDER_DB_PATH: join(app.getPath('userData'), 'ladder.db'), LADDER_APP_VERSION: app.getVersion(), LADDER_HOST_PREFS: JSON.stringify(hostPrefs()) }
  // A different ACP registry is for development only: in packaged builds it doesn't reach the host.
  if (app.isPackaged) delete env.LADDER_ACP_REGISTRY
  // The local WebSocket of the remote channel is for development only.
  if (app.isPackaged) delete env.LADDER_REMOTE_PORT
  // Same for the test relay: in packaged builds only the preference (HostPrefs.remote) counts.
  if (app.isPackaged) delete env.LADDER_RELAY_URL
  // Plan acceptance test hook: a failure cannot be simulated in the distributed app.
  if (app.isPackaged) delete env.LADDER_PLAN_FAIL
  // Where the CLI finds the socket and the `ladder` command script inside the app (in development, the script that goes through the dev build).
  env.LADDER_SOCKET_PATH = socketPathFor(app.getPath('userData'))
  env.LADDER_CLI_BIN = app.isPackaged ? join(process.resourcesPath, 'bin', 'ladder') : join(app.getAppPath(), 'src', 'cli', 'bin', 'ladder-dev')
  host = utilityProcess.fork(join(__dirname, 'host.js'), [], { serviceName: 'Ladder Host', stdio: 'pipe', env })
  host.on('message', (message: HostToMain) => {
    if (message?.type === 'attention') attention.handle(message.event)
    else if (message?.type === 'badge') attention.setBadge(message.count)
    else if (message?.type === 'open-url' && isLoginUrl(message.url)) shell.openExternal(message.url).catch(() => undefined)
    // Shortcuts changed (file or UI): the menu is rebuilt with the new accelerators.
    else if (message?.type === 'shortcuts') {
      applyShortcutConfig({ preset: message.preset, overrides: message.overrides })
      buildMenu()
    } else if (message?.type === 'open-keybindings') openKeybindings()
    else if (message?.type === 'activity') {
      runningSessions = message.running
      phonesConnected = message.phones ?? 0
      applyKeepAwake()
    } else if (message?.type === 'power-ack') quitAck?.()
    else if (message?.type === 'open-path') openDataPath(message.path)
    // Roots served by the ladder-file protocol, and "Show in Finder" for a file in one of them.
    else if (message?.type === 'file-roots' && Array.isArray(message.roots)) setFileRoots(message.roots)
    else if (message?.type === 'reveal-file') void revealFile(message.id, message.path)
    // Operation on the agent's browser; the reply comes back with the same rid, always as plain data.
    else if (message?.type === 'browser-agent' && typeof message.rid === 'string') {
      const rid = message.rid
      // An exception must not leave the host waiting until the timeout: it replies anyway, with an error.
      void runAgentOp(message.op)
        .catch((error: unknown): BrowserAgentResult => ({ ok: false, code: 'failed', error: t('The browser action failed: {message}', { message: (error instanceof Error ? error.message : String(error)).slice(0, 200) }) }))
        .then((result) => host?.postMessage({ type: 'browser-agent-result', rid, result } satisfies MainToHost))
    }
  })
  host.stdout?.on('data', (chunk) => process.stdout.write(`[host] ${chunk}`))
  host.stderr?.on('data', (chunk) => process.stderr.write(`[host] ${chunk}`))
  host.on('exit', (code) => {
    host = null
    setFileRoots([])
    // Working sessions ended with the host: no sleep blocker.
    runningSessions = 0
    phonesConnected = 0
    applyKeepAwake()
    // The agent's views no longer have a host governing them: they are destroyed (the new host starts without tabs).
    destroyAgentTabs()
    if (quitting) return
    console.error(`[main] host terminato (codice ${code}), riavvio`)
    setTimeout(() => {
      startHost()
      for (const window of windows) connect(window)
    }, 500)
  })
}

/** Connects a window to the host with a dedicated MessagePort. */
function connect(window: BrowserWindow): void {
  if (!host || window.isDestroyed()) return
  const { port1, port2 } = new MessageChannelMain()
  host.postMessage({ type: 'connect' } satisfies MainToHost, [port1])
  window.webContents.postMessage('ladder:host-port', null, [port2])
}

function createWindow(): void {
  // An open from the background (Dock, link, notification, tray) brings the Dock back and removes the menu bar icon.
  if (tray) leaveBackground()
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Ladder',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 15 },
    // The theme's sidebar color, so there is no flash at startup.
    backgroundColor: themeById(settings.theme).tokens.sidebar,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload reads the theme from here and applies it to <html> before the first paint.
      additionalArguments: [`--ladder-theme=${settings.theme}`, `--ladder-locale=${settings.locale}`],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  windows.add(window)
  const contentsId = window.webContents.id
  window.on('closed', () => {
    windows.delete(window)
    destroyWindowTabs(window)
    attention.forget(contentsId)
  })
  window.once('ready-to-show', () => window.show())
  window.on('enter-full-screen', () => window.webContents.send('ladder:full-screen', true))
  window.on('leave-full-screen', () => window.webContents.send('ladder:full-screen', false))
  // File with unsaved changes: the page blocks the close and here the user is asked what to do.
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window, { type: 'warning', buttons: [t('Discard changes'), t('Cancel')], defaultId: 1, cancelId: 1, message: t('You have unsaved files.'), detail: t('If you close now, your edits are lost.') })
    if (choice === 0) event.preventDefault()
  })
  window.webContents.on('did-finish-load', () => {
    connect(window)
    // Click on a notification with no windows open: the session opens as soon as the page is ready.
    if (pendingOpen) {
      window.webContents.send('ladder:open-session', pendingOpen)
      pendingOpen = null
    }
  })

  // External links open in the browser; no new window inside Ladder.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

ipcMain.on('ladder:is-full-screen', (event) => {
  event.returnValue = BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false
})

ipcMain.handle('ladder:pick-folder', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  const options = { title: t('Add a project'), buttonLabel: t('Add'), properties: ['openDirectory' as const] }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

/** How an editor is opened: executable and arguments for a file (with line) or a folder. */
type EditorLauncher = (path: string, isFile: boolean, line?: number) => { cmd: string; args: string[] }

const APP_DIRS = () => ['/Applications', join(app.getPath('home'), 'Applications')]
const inApps = (bundle: string) => APP_DIRS().map((dir) => join(dir, bundle)).find((path) => existsSync(path)) ?? null

/** The editors: GUI apps don't see the shell PATH, so the CLIs are looked up inside the bundles. null = not installed. */
function editorLauncher(editor: EditorId): EditorLauncher | null {
  switch (editor) {
    case 'cursor':
    case 'vscode': {
      const cmd = inApps(editor === 'cursor' ? 'Cursor.app/Contents/Resources/app/bin/cursor' : 'Visual Studio Code.app/Contents/Resources/app/bin/code')
      return cmd ? (path, isFile, line) => ({ cmd, args: isFile ? ['-g', `${path}${line ? `:${line}` : ''}`] : [path] }) : null
    }
    case 'zed': {
      const cmd = inApps('Zed.app/Contents/MacOS/cli')
      return cmd ? (path, isFile, line) => ({ cmd, args: [isFile && line ? `${path}:${line}` : path] }) : null
    }
    case 'xcode':
      // Xcode opens files at a line with xed; for a folder there is no better way than `open -a`.
      return inApps('Xcode.app')
        ? (path, isFile, line) => (isFile ? { cmd: '/usr/bin/xed', args: line ? ['--line', String(line), path] : [path] } : { cmd: '/usr/bin/open', args: ['-a', 'Xcode', path] })
        : null
  }
}

const EDITOR_ORDER: EditorId[] = ['cursor', 'vscode', 'zed', 'xcode']
const EDITOR_SCHEMES: Partial<Record<EditorId, string>> = { cursor: 'cursor', vscode: 'vscode', zed: 'zed' }

ipcMain.handle('ladder:editors', (): EditorAvailability => ({ cursor: Boolean(editorLauncher('cursor')), vscode: Boolean(editorLauncher('vscode')), zed: Boolean(editorLauncher('zed')), xcode: Boolean(editorLauncher('xcode')) }))

/** Opens a file (at a line) or a folder; replies with the editor used, null if it fell back to the default app. */
ipcMain.handle('ladder:open-in-editor', async (_event, path: string, line?: number, editor?: EditorId): Promise<EditorId | null> => {
  // The chosen editor (for the project, otherwise the one in preferences); if it isn't installed, the first installed one.
  const wanted = EDITORS.includes(editor as string) ? (editor as EditorId) : settings.editor
  const order = [wanted, ...EDITOR_ORDER.filter((e) => e !== wanted)]
  const found = order.flatMap((e) => {
    const launcher = editorLauncher(e)
    return launcher ? [{ editor: e, launcher }] : []
  })[0]
  const isFile = existsSync(path) && statSync(path).isFile()
  const launch = found?.launcher(path, isFile, line)
  // Automated tests: the command is recorded instead of opening the editor.
  if (process.env.LADDER_EDITOR_TRACE) {
    appendFileSync(process.env.LADDER_EDITOR_TRACE, `${JSON.stringify({ cli: launch?.cmd ?? null, editor: found?.editor ?? null, args: launch?.args ?? [] })}\n`)
    return found?.editor ?? null
  }
  if (found && launch) {
    await new Promise<void>((resolve) => execFile(launch.cmd, launch.args, { env: cleanEnv(['ELECTRON_RUN_AS_NODE']) }, () => resolve()))
    return found.editor
  }
  // With no editors installed: the chosen editor's scheme opens the file at the line; as a last resort the default app.
  const scheme = EDITOR_SCHEMES[wanted]
  const opened = scheme ? await shell.openExternal(`${scheme}://file${encodeURI(path)}${line ? `:${line}` : ''}`).then(() => true, () => false) : false
  if (!opened) await shell.openPath(path)
  return null
})

/** "Save as" for the database export: chosen path or null. The UI proposes the default name. */
ipcMain.handle('ladder:pick-save-path', async (event, defaultName: string) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  const options = { title: t('Export the database'), defaultPath: join(app.getPath('documents'), String(defaultName || 'ladder.db')), buttonLabel: t('Export') }
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
})

/** Opens a path inside the app data folder (requested by the host): nothing else is opened. */
function openDataPath(path: string): void {
  const dir = app.getPath('userData')
  const target = resolve(path)
  if (target !== dir && !target.startsWith(dir + sep)) return
  void shell.openPath(target)
}

ipcMain.handle('ladder:reveal', (_event, path: string) => shell.showItemInFolder(path))

// What the window is looking at: notifications for that session aren't needed.
ipcMain.on('ladder:view', (event, view: WindowView) => attention.setView(event.sender.id, view))

ipcMain.handle('ladder:prefs', () => prefsOf(settings))
ipcMain.handle('ladder:set-prefs', (_event, patch: Partial<AppPrefs>) => {
  settings = { ...settings, ...cleanPrefs({ ...prefsOf(settings), ...patch }) }
  // Outside the installed app there is no login item to manage: the preference stays off.
  if (!canLaunchAtLogin()) settings.openAtLogin = false
  setLocale(settings.locale)
  saveSettings(settings)
  host?.postMessage({ type: 'prefs', prefs: hostPrefs() } satisfies MainToHost)
  for (const window of windows) window.webContents.send('ladder:prefs', prefsOf(settings))
  if ('openAtLogin' in patch) applyLoginItem()
  applyKeepAwake()
  // In the background with the remote channel just turned off there is nothing left to serve: quit.
  if (windows.size === 0 && tray && !remoteOn()) app.quit()
  buildMenu()
  return prefsOf(settings)
})

ipcMain.handle('ladder:test-notification', (event) =>
  attention.test(() => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    app.focus({ steal: true })
  })
)

registerBrowserIpc()
// The agent's view is gone (tab or window closed): the host revokes that session's tools.
onAgentTabClosed((sessionId) => host?.postMessage({ type: 'browser-agent-closed', sessionId } satisfies MainToHost))

ipcMain.handle('ladder:linear-status', () => linearStatus())
ipcMain.handle('ladder:linear-set-key', (_event, key: string | null) => setLinearKey(key))
ipcMain.handle('ladder:linear-issues', (_event, search: string) => linearIssues(search ?? ''))
// Only https, recognized from the already parsed URL (scheme in any case combination, host present): the renderer does the same check.
ipcMain.handle('ladder:open-external', (_event, url: string) => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' && parsed.hostname) void shell.openExternal(parsed.href)
  } catch {
    // Invalid URL: it is not opened.
  }
})

// Automated tests only (LADDER_NOTIFY_TRACE): simulated click on the last notification and current badge.
if (process.env.LADDER_NOTIFY_TRACE) {
  ipcMain.handle('ladder:debug-click-notification', () => attention.clickLatest())
  ipcMain.handle('ladder:debug-badge', () => attention.badgeCount)
  ipcMain.handle('ladder:debug-attention', (_event, attentionEvent: AttentionEvent) => attention.handle(attentionEvent))
  ipcMain.handle('ladder:debug-focus', (_event, focused: boolean | null) => {
    attention.forcedFocus = focused
  })
}

ipcMain.handle('ladder:set-theme', (_event, id: string) => {
  const theme = themeById(id)
  settings = { ...settings, theme: theme.id }
  saveSettings(settings)
  for (const window of windows) {
    window.setBackgroundColor(theme.tokens.sidebar)
    window.webContents.send('ladder:theme', theme.id)
  }
  return theme.id
})

let quitting = false

/** App menu: ⌘W closes the Ladder tab, so the window closes with ⇧⌘W. */
function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: t('Settings…'),
          accelerator: acceleratorOf('app.openSettings'),
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send('ladder:open-settings')
        },
        {
          label: t('Do Not Disturb for 1 Hour'),
          type: 'checkbox',
          checked: Boolean(settings.dndUntil && settings.dndUntil > Date.now()),
          click: () => {
            const on = !(settings.dndUntil && settings.dndUntil > Date.now())
            settings = { ...settings, dndUntil: on ? Date.now() + 60 * 60_000 : null }
            saveSettings(settings)
            for (const window of windows) window.webContents.send('ladder:prefs', prefsOf(settings))
            buildMenu()
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: t('View'),
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }]
    },
    {
      role: 'windowMenu',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { label: t('Close Window'), click: () => BrowserWindow.getFocusedWindow()?.close() }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Whoever tries to open a second Ladder on the same profile finds the window that already exists.
app.on('second-instance', () => showWindow())

// ladder:// links arrive from macOS even before the app is ready.
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (app.isReady()) openUrl(url)
  else void app.whenReady().then(() => setTimeout(() => openUrl(url), 800))
})

app.whenReady().then(() => {
  if (!primaryInstance) return
  settings = loadSettings()
  setLocale(settings.locale)
  // The user can also change the login item from System Settings: the real state wins.
  settings.openAtLogin = canLaunchAtLogin() && app.getLoginItemSettings().openAtLogin
  // The protocol is registered only in the installed app: in development it would point to the Electron binary,
  // and a test profile (LADDER_USER_DATA) must not change the app that opens ladder:// links.
  if (app.isPackaged && !process.env.LADDER_USER_DATA) app.setAsDefaultProtocolClient('ladder')
  // "Do Not Disturb" expires by itself: the menu updates when it ends.
  setInterval(() => {
    if (settings.dndUntil && settings.dndUntil <= Date.now()) {
      settings = { ...settings, dndUntil: null }
      saveSettings(settings)
      for (const window of windows) window.webContents.send('ladder:prefs', prefsOf(settings))
      buildMenu()
    }
  }, 30_000)
  // In development the Dock shows the Circuit icon; in the build the bundle provides it.
  if (!app.isPackaged && process.platform === 'darwin') {
    const icon = join(app.getAppPath(), '../../brand/app-icon/png/circuit/ladder-512.png')
    if (existsSync(icon)) app.dock?.setIcon(icon)
  }
  buildMenu()
  registerFileProtocol()
  startHost()
  // At login, with the remote channel on, Ladder starts in the background (menu bar only); otherwise the window opens.
  // wasOpenedAtLogin on macOS 13+ depends on SMAppService: to be checked by hand in the installed app (login item on, Mac restart).
  if (staysInBackground(process.platform, remoteOn()) && app.getLoginItemSettings().wasOpenedAtLogin) enterBackground()
  else createWindow()
  // The Mac sleeps or wakes: phones see it instead of a generic "offline".
  powerMonitor.on('suspend', () => host?.postMessage({ type: 'power', state: 'asleep' } satisfies MainToHost))
  powerMonitor.on('resume', () => host?.postMessage({ type: 'power', state: 'awake' } satisfies MainToHost))
  powerMonitor.on('lock-screen', () => (screenLocked = true))
  powerMonitor.on('unlock-screen', () => (screenLocked = false))
  // Shutdown or logout: the notice goes out without waiting for the ack and before-quit doesn't block the exit.
  powerMonitor.on('shutdown', () => {
    quitStep = 'done'
    host?.postMessage({ type: 'power', state: 'quit' } satisfies MainToHost)
  })
  // When an update install starts: like a normal quit, the host must not be restarted while the windows close.
  registerUpdater(
    () => windows,
    () => {
      quitting = true
    }
  )
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Two-step quit: first the host notifies the relay ("Ladder closed"), then it really quits.
// Only with the remote channel on (otherwise the quit is the usual one). The wait is at most 500 ms and is not repeated:
// after the first round (quitStep 'done') before-quit lets it through. Nothing is blocked on shutdown or logout.
let quitStep: 'idle' | 'waiting' | 'done' = 'idle'
let quitAck: (() => void) | null = null

app.on('before-quit', (event) => {
  quitting = true
  if (quitStep === 'idle' && host && remoteOn()) {
    event.preventDefault()
    quitStep = 'waiting'
    const finish = () => {
      if (quitStep === 'done') return
      quitStep = 'done'
      quitAck = null
      app.quit()
    }
    quitAck = finish
    setTimeout(finish, 500)
    host.postMessage({ type: 'power', state: 'quit' } satisfies MainToHost)
    return
  }
  // A second ⌘Q during the wait does nothing more: the quit is already in progress.
  if (quitStep === 'waiting') return event.preventDefault()
  if (awakeBlocker !== null) powerSaveBlocker.stop(awakeBlocker)
  destroyTray()
  host?.kill()
})

// On macOS the app stays active when you close the window: sessions keep running. With the remote channel on it also stays
// without windows, in the menu bar; ⌘Q or "Quit" from the menu really quits.
app.on('window-all-closed', () => {
  if (staysInBackground(process.platform, remoteOn()) && !quitting) enterBackground()
  else if (process.platform !== 'darwin') app.quit()
})
