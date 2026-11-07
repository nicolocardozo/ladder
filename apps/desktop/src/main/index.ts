import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Blue',
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

  window.once('ready-to-show', () => window.show())

  // I link esterni si aprono nel browser; nessuna nuova finestra dentro Blue.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Su macOS l'app resta attiva quando chiudi la finestra: le sessioni continuano.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
