// pnpm non esegue sempre lo script di installazione di Electron: se il binario manca, lo scarica.
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

if (!existsSync(new URL('../node_modules/electron/path.txt', import.meta.url))) {
  execFileSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit' })
}
