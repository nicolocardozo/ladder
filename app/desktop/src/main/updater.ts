// Automatic updates: electron-updater reads latest-mac.yml from the nicolocardozo/ladder-releases releases
// (configured in electron-builder.release.yml), downloads the zip for its own architecture in the background
// and installs it on quit. The renderer shows "Restart to update" when it is ready.
import { app, autoUpdater as nativeUpdater, ipcMain, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/updates'

const FIRST_CHECK = 15_000
const EVERY = 4 * 60 * 60 * 1000

let state: UpdateState = { status: 'unsupported', version: app.getVersion() }

export function registerUpdater(windows: () => Iterable<BrowserWindow>, onQuitForUpdate: () => void): void {
  const set = (next: UpdateState): void => {
    state = next
    for (const window of windows()) if (!window.isDestroyed()) window.webContents.send('ladder:update', state)
  }
  const version = app.getVersion()
  let installing = false

  ipcMain.handle('ladder:update-state', () => state)
  ipcMain.handle('ladder:update-check', () => check())
  ipcMain.handle('ladder:update-install', () => {
    if (state.status !== 'ready' || installing) return
    installing = true
    // Ladder reopens by itself with the new version (autoRunAppAfterInstall, on by default).
    electronUpdater.autoUpdater.quitAndInstall()
  })

  // Only the installed, signed app has app-update.yml; in development it stays "unsupported".
  // autoUpdater is created when it is read: only from here on.
  if (!app.isPackaged || process.env.LADDER_USER_DATA) return
  const { autoUpdater } = electronUpdater

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  set({ status: 'idle', version, checkedAt: null })

  autoUpdater.on('checking-for-update', () => {
    if (state.status !== 'downloading' && state.status !== 'ready') set({ status: 'checking', version })
  })
  autoUpdater.on('update-not-available', () => set({ status: 'idle', version, checkedAt: Date.now() }))
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version, next: info.version, percent: 0 }))
  autoUpdater.on('download-progress', (progress) => {
    if (state.status === 'downloading') set({ ...state, percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version, next: info.version }))
  // Quitting to install really starts only here (Squirrel has the update and closes the windows):
  // before that, main's lifecycle is not touched.
  nativeUpdater.on('before-quit-for-update', onQuitForUpdate)
  autoUpdater.on('error', (error) => {
    // With an update ready we no longer check: an error here comes from Squirrel failing to prepare it
    // (app opened from the DMG or from a read-only folder). It goes back to "error" and the Restart button disappears.
    installing = false
    set({ status: 'error', version, message: error.message.split('\n')[0] ?? String(error) })
  })

  async function check(): Promise<UpdateState> {
    if (state.status === 'unsupported' || state.status === 'downloading' || state.status === 'ready') return state
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // The error also arrives from the 'error' event, which updates the state.
    }
    return state
  }

  setTimeout(() => void check(), FIRST_CHECK)
  setInterval(() => void check(), EVERY)
}
