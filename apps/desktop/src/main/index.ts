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

app.setName('Ladder')
// Cartella dati alternativa per prove automatiche o profili separati.
if (process.env.LADDER_USER_DATA) app.setPath('userData', process.env.LADDER_USER_DATA)

let host: UtilityProcess | null = null
const windows = new Set<BrowserWindow>()

// ── Impostazioni dell'app (tema): un piccolo file JSON letto dal main prima di aprire le finestre,
// così il tema è applicato prima del primo paint senza aspettare l'host.
interface AppSettings {
  theme: ThemeId
}
const settingsPath = () => join(app.getPath('userData'), 'settings.json')
function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<AppSettings>
    return { theme: themeById(raw.theme).id }
  } catch {
    return { theme: themeById(null).id }
  }
}
function saveSettings(settings: AppSettings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}
let settings: AppSettings = { theme: themeById(null).id }

/** Avvia l'host delle sessioni. Se cade, lo riavvia e ricollega le finestre. */
function startHost(): void {
  host = utilityProcess.fork(join(__dirname, 'host.js'), [], {
    serviceName: 'Ladder Host',
    stdio: 'pipe',
    env: { ...process.env, LADDER_DB_PATH: join(app.getPath('userData'), 'ladder.db') }
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
  host.postMessage({ type: 'connect' }, [port1])
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
  window.on('closed', () => windows.delete(window))
  window.once('ready-to-show', () => window.show())
  window.webContents.on('did-finish-load', () => connect(window))

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

app.whenReady().then(() => {
  settings = loadSettings()
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
