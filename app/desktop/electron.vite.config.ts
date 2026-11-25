import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// electron-vite runs from the app/desktop folder: paths are relative to it.
const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      // All dependencies inside the bundle: the packaged app doesn't need node_modules.
      externalizeDeps: false,
      rollupOptions: {
        // index: main process; host: sessions host, started as a utilityProcess.
        // cli: the `ladder` CLI, a standalone bundle that the packaged app runs with its own binary (see electron-builder.yml).
        input: { index: resolve('src/main/index.ts'), host: resolve('src/host/index.ts'), cli: resolve('src/cli/main.ts') },
        // Only exception: node-pty is a native module and stays in node_modules (outside the asar in the build).
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
