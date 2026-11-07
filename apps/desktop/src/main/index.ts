import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeTheme,
  shell,
  utilityProcess,
  type UtilityProcess
} from 'electron'

app.setName('Ladder')
// Cartella dati alternativa per prove automatiche o profili separati.
if (process.env.LADDER_USER_DATA) app.setPath('userData', process.env.LADDER_USER_DATA)

let host: UtilityProcess | null = null
const windows = new Set<BrowserWindow>()

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
    // Stesso colore della sidebar, così all'avvio non si vede un lampo bianco.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0f16' : '#f3f5f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
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

/** CLI dell'editore: Cursor se c'è, altrimenti VS Code. Le app GUI non vedono il PATH della shell. */
function editorCli(): string | null {
  const candidates = [
    '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
    join(app.getPath('home'), 'Applications/Cursor.app/Contents/Resources/app/bin/cursor'),
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    join(app.getPath('home'), 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code')
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}

ipcMain.handle('ladder:open-in-editor', async (_event, path: string, line?: number) => {
  const cli = editorCli()
  const isFile = existsSync(path) && statSync(path).isFile()
  if (cli) {
    const args = isFile ? ['-g', `${path}${line ? `:${line}` : ''}`] : [path]
    await new Promise<void>((resolve) => execFile(cli, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }, () => resolve()))
    return
  }
  // Senza CLI: lo schema cursor:// apre il file alla riga; in ultima istanza l'app predefinita.
  const opened = await shell.openExternal(`cursor://file${encodeURI(path)}${line ? `:${line}` : ''}`).then(() => true, () => false)
  if (!opened) await shell.openPath(path)
})

ipcMain.handle('ladder:reveal', (_event, path: string) => shell.showItemInFolder(path))

let quitting = false

/** Menu dell'app: ⌘W chiude la tab di Ladder, quindi la finestra si chiude con ⇧⌘W. */
function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
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
