import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  shell,
  utilityProcess,
  type UtilityProcess
} from 'electron'
import { themeById, type ThemeId } from '@shared/themes.generated'
import type { AppPrefs, AttentionEvent, HostPrefs, HostToMain, MainToHost, WindowView } from '@shared/protocol'
import { Attention } from './attention'
import { linearIssues, linearStatus, setLinearKey } from './linear'

app.setName('Ladder')
// Cartella dati alternativa per prove automatiche o profili separati.
if (process.env.LADDER_USER_DATA) app.setPath('userData', process.env.LADDER_USER_DATA)

let host: UtilityProcess | null = null
const windows = new Set<BrowserWindow>()

// ── Impostazioni dell'app (tema): un piccolo file JSON letto dal main prima di aprire le finestre,
// così il tema è applicato prima del primo paint senza aspettare l'host.
interface AppSettings extends AppPrefs {
  theme: ThemeId
}
const DEFAULT_PREFS: AppPrefs = { notifications: true, sound: false, dndUntil: null, maxActive: 3 }
const settingsPath = () => join(app.getPath('userData'), 'settings.json')
function cleanPrefs(raw: Partial<AppPrefs>): AppPrefs {
  const maxActive = Number(raw.maxActive)
  return {
    notifications: raw.notifications !== false,
    sound: raw.sound === true,
    dndUntil: typeof raw.dndUntil === 'number' && raw.dndUntil > Date.now() ? raw.dndUntil : null,
    maxActive: Number.isInteger(maxActive) && maxActive >= 1 && maxActive <= 10 ? maxActive : DEFAULT_PREFS.maxActive
  }
}
function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<AppSettings>
    return { theme: themeById(raw.theme).id, ...cleanPrefs(raw) }
  } catch {
    return { theme: themeById(null).id, ...DEFAULT_PREFS }
  }
}
function saveSettings(settings: AppSettings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}
let settings: AppSettings = { theme: themeById(null).id, ...DEFAULT_PREFS }
const prefsOf = (s: AppSettings): AppPrefs => ({ notifications: s.notifications, sound: s.sound, dndUntil: s.dndUntil, maxActive: s.maxActive })
const hostPrefs = (): HostPrefs => ({ maxActive: { 'claude-code': settings.maxActive, codex: settings.maxActive } })

const attention = new Attention(() => prefsOf(settings), (sessionId, itemId) => openSession(sessionId, itemId))

/** Porta in primo piano una finestra (o ne apre una) e le chiede di aprire la sessione all'elemento. */
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

/** ladder://session/<id>?item=<id>: la destinazione delle notifiche, apribile anche da fuori. */
function openUrl(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'ladder:' || parsed.hostname !== 'session') return
    const sessionId = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    if (sessionId) openSession(sessionId, parsed.searchParams.get('item'))
  } catch {
    // Link non valido: si ignora.
  }
}

/** Avvia l'host delle sessioni. Se cade, lo riavvia e ricollega le finestre. */
function startHost(): void {
  host = utilityProcess.fork(join(__dirname, 'host.js'), [], {
    serviceName: 'Ladder Host',
    stdio: 'pipe',
    env: { ...process.env, LADDER_DB_PATH: join(app.getPath('userData'), 'ladder.db'), LADDER_HOST_PREFS: JSON.stringify(hostPrefs()) }
  })
  host.on('message', (message: HostToMain) => {
    if (message?.type === 'attention') attention.handle(message.event)
    else if (message?.type === 'badge') attention.setBadge(message.count)
  })
  host.stdout?.on('data', (chunk) => process.stdout.write(`[host] ${chunk}`))
  host.stderr?.on('data', (chunk) => process.stderr.write(`[host] ${chunk}`))
  host.on('exit', (code) => {
    host = null
    if (quitting) return
    console.error(`[main] host terminato (codice ${code}), riavvio`)
    setTimeout(() => {
      startHost()
      for (const window of windows) connect(window)
    }, 500)
  })
}

/** Collega una finestra all'host con una MessagePort dedicata. */
function connect(window: BrowserWindow): void {
  if (!host || window.isDestroyed()) return
  const { port1, port2 } = new MessageChannelMain()
  host.postMessage({ type: 'connect' } satisfies MainToHost, [port1])
  window.webContents.postMessage('ladder:host-port', null, [port2])
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Ladder',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 15 },
    // Colore della sidebar del tema, così all'avvio non si vede un lampo.
    backgroundColor: themeById(settings.theme).tokens.sidebar,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Il preload legge il tema da qui e lo applica a <html> prima del primo paint.
      additionalArguments: [`--ladder-theme=${settings.theme}`],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  windows.add(window)
  const contentsId = window.webContents.id
  window.on('closed', () => {
    windows.delete(window)
    attention.forget(contentsId)
  })
  window.once('ready-to-show', () => window.show())
  window.webContents.on('did-finish-load', () => {
    connect(window)
    // Clic su una notifica senza finestre aperte: la sessione si apre appena la pagina è pronta.
    if (pendingOpen) {
      window.webContents.send('ladder:open-session', pendingOpen)
      pendingOpen = null
    }
  })

  // I link esterni si aprono nel browser; nessuna nuova finestra dentro Ladder.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

ipcMain.handle('ladder:pick-folder', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  const options = { title: 'Aggiungi un progetto', buttonLabel: 'Aggiungi', properties: ['openDirectory' as const] }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

type EditorId = 'cursor' | 'vscode'

/** CLI degli editor: le app GUI non vedono il PATH della shell, quindi si cercano dentro i bundle. */
function editorCli(editor: EditorId): string | null {
  const bundles =
    editor === 'cursor'
      ? ['Cursor.app/Contents/Resources/app/bin/cursor']
      : ['Visual Studio Code.app/Contents/Resources/app/bin/code']
  const candidates = bundles.flatMap((b) => [join('/Applications', b), join(app.getPath('home'), 'Applications', b)])
  return candidates.find((path) => existsSync(path)) ?? null
}

ipcMain.handle('ladder:editors', () => ({ cursor: Boolean(editorCli('cursor')), vscode: Boolean(editorCli('vscode')) }))

ipcMain.handle('ladder:open-in-editor', async (_event, path: string, line?: number, editor?: EditorId) => {
  // L'editor scelto per il progetto; se non è installato, l'altro.
  const order: EditorId[] = editor === 'vscode' ? ['vscode', 'cursor'] : ['cursor', 'vscode']
  const cli = order.map(editorCli).find(Boolean) ?? null
  const isFile = existsSync(path) && statSync(path).isFile()
  // Prove automatiche: si registra il comando invece di aprire l'editor.
  if (process.env.LADDER_EDITOR_TRACE) {
    appendFileSync(process.env.LADDER_EDITOR_TRACE, `${JSON.stringify({ cli, args: isFile ? ['-g', `${path}${line ? `:${line}` : ''}`] : [path] })}\n`)
    return
  }
  if (cli) {
    const args = isFile ? ['-g', `${path}${line ? `:${line}` : ''}`] : [path]
    await new Promise<void>((resolve) => execFile(cli, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }, () => resolve()))
    return
  }
  // Senza CLI: lo schema dell'editor apre il file alla riga; in ultima istanza l'app predefinita.
  const scheme = editor === 'vscode' ? 'vscode' : 'cursor'
  const opened = await shell.openExternal(`${scheme}://file${encodeURI(path)}${line ? `:${line}` : ''}`).then(() => true, () => false)
  if (!opened) await shell.openPath(path)
})

ipcMain.handle('ladder:reveal', (_event, path: string) => shell.showItemInFolder(path))

// Cosa sta guardando la finestra: le notifiche di quella sessione non servono.
ipcMain.on('ladder:view', (event, view: WindowView) => attention.setView(event.sender.id, view))

ipcMain.handle('ladder:prefs', () => prefsOf(settings))
ipcMain.handle('ladder:set-prefs', (_event, patch: Partial<AppPrefs>) => {
  settings = { ...settings, ...cleanPrefs({ ...prefsOf(settings), ...patch }) }
  saveSettings(settings)
  host?.postMessage({ type: 'prefs', prefs: hostPrefs() } satisfies MainToHost)
  for (const window of windows) window.webContents.send('ladder:prefs', prefsOf(settings))
  buildMenu()
  return prefsOf(settings)
})

ipcMain.handle('ladder:linear-status', () => linearStatus())
ipcMain.handle('ladder:linear-set-key', (_event, key: string | null) => setLinearKey(key))
ipcMain.handle('ladder:linear-issues', (_event, search: string) => linearIssues(search ?? ''))
ipcMain.handle('ladder:open-external', (_event, url: string) => {
  if (/^https:\/\//.test(url)) void shell.openExternal(url)
})

// Solo per le prove automatiche (LADDER_NOTIFY_TRACE): clic simulato sull'ultima notifica e badge attuale.
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

/** Menu dell'app: ⌘W chiude la tab di Ladder, quindi la finestra si chiude con ⇧⌘W. */
function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Impostazioni…',
          accelerator: 'CmdOrCtrl+,',
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send('ladder:open-settings')
        },
        {
          label: 'Non disturbare per 1 ora',
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
      label: 'Vista',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }]
    },
    {
      role: 'windowMenu',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { label: 'Chiudi finestra', accelerator: 'Shift+CmdOrCtrl+W', role: 'close' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// I link ladder:// arrivano da macOS anche prima che l'app sia pronta.
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (app.isReady()) openUrl(url)
  else void app.whenReady().then(() => setTimeout(() => openUrl(url), 800))
})

app.whenReady().then(() => {
  settings = loadSettings()
  // Il protocollo si registra solo nell'app installata: in sviluppo punterebbe al binario di Electron,
  // e un profilo di prova (LADDER_USER_DATA) non deve cambiare l'app che apre i link ladder://.
  if (app.isPackaged && !process.env.LADDER_USER_DATA) app.setAsDefaultProtocolClient('ladder')
  // Il "Non disturbare" scade da solo: il menu si aggiorna quando finisce.
  setInterval(() => {
    if (settings.dndUntil && settings.dndUntil <= Date.now()) {
      settings = { ...settings, dndUntil: null }
      saveSettings(settings)
      for (const window of windows) window.webContents.send('ladder:prefs', prefsOf(settings))
      buildMenu()
    }
  }, 30_000)
  // In sviluppo il Dock mostra l'icona Circuit; nella build la dà il bundle.
  if (!app.isPackaged && process.platform === 'darwin') {
    const icon = join(app.getAppPath(), '../../app-icon/png/circuit/ladder-512.png')
    if (existsSync(icon)) app.dock?.setIcon(icon)
  }
  buildMenu()
  startHost()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
  host?.kill()
})

// Su macOS l'app resta attiva quando chiudi la finestra: le sessioni continuano.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
