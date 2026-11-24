// Aggiornamenti automatici: electron-updater legge latest-mac.yml dalle release di nicolocardozo/ladder-releases
// (configurato in electron-builder.release.yml), scarica lo zip della propria architettura in background
// e lo installa alla chiusura. Il renderer mostra "Riavvia per aggiornare" quando è pronto.
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
    // Ladder si riapre da solo con la nuova versione (autoRunAppAfterInstall, attivo di default).
    electronUpdater.autoUpdater.quitAndInstall()
  })

  // Solo l'app installata e firmata ha app-update.yml; in sviluppo resta "unsupported".
  // autoUpdater si crea quando lo si legge: solo da qui in poi.
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
  // L'uscita per installare parte davvero solo qui (Squirrel ha l'aggiornamento e chiude le finestre):
  // prima non si tocca il ciclo di vita del main.
  nativeUpdater.on('before-quit-for-update', onQuitForUpdate)
  autoUpdater.on('error', (error) => {
    // Con un aggiornamento pronto non si controlla più: un errore qui viene da Squirrel che non riesce a prepararlo
    // (app aperta dal DMG o da una cartella in sola lettura). Si torna a "errore" e il pulsante Riavvia sparisce.
    installing = false
    set({ status: 'error', version, message: error.message.split('\n')[0] ?? String(error) })
  })

  async function check(): Promise<UpdateState> {
    if (state.status === 'unsupported' || state.status === 'downloading' || state.status === 'ready') return state
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // L'errore arriva anche dall'evento 'error', che aggiorna lo stato.
    }
    return state
  }

  setTimeout(() => void check(), FIRST_CHECK)
  setInterval(() => void check(), EVERY)
}
