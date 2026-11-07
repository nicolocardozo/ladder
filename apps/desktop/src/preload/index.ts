import { contextBridge, ipcRenderer } from 'electron'

// La porta verso l'host arriva dal processo main e va girata al mondo della pagina:
// con contextIsolation il renderer non vede ipcRenderer, ma riceve la porta con window.postMessage.
ipcRenderer.on('ladder:host-port', (event) => {
  window.postMessage('ladder:host-port', '*', event.ports)
})

const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('ladder:pick-folder'),
  openInEditor: (path: string, line?: number): Promise<void> => ipcRenderer.invoke('ladder:open-in-editor', path, line),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('ladder:reveal', path)
}

contextBridge.exposeInMainWorld('ladder', api)

export type LadderApi = typeof api
