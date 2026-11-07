import { contextBridge } from 'electron'

// API minima esposta al renderer. Crescerà con i canali verso l'host delle sessioni (fase 1).
const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
}

contextBridge.exposeInMainWorld('blue', api)

export type BlueApi = typeof api
