import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// electron-vite gira dalla cartella apps/desktop: i percorsi sono relativi a lei.
const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      // Tutte le dipendenze dentro il bundle: l'app impacchettata non ha bisogno di node_modules.
      externalizeDeps: false,
      rollupOptions: {
        // index: processo main; host: host delle sessioni, avviato come utilityProcess.
        input: { index: resolve('src/main/index.ts'), host: resolve('src/host/index.ts') },
        // Unica eccezione: node-pty è un modulo nativo e resta in node_modules (fuori dall'asar nella build).
        external: ['node-pty']
      }
    }
  },
  preload: { resolve: { alias: shared } },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src'), ...shared } },
    plugins: [react(), tailwindcss()]
  }
})
