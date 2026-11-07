// Dopo l'installazione: pnpm non esegue gli script delle dipendenze, quindi qui si fa il minimo indispensabile.
// 1. Binario di Electron, se manca.
// 2. node-pty: lo spawn-helper del prebuild arriva senza permesso di esecuzione e il primo spawn fallirebbe.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (!existsSync(new URL('../node_modules/electron/path.txt', import.meta.url))) {
  execFileSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit' })
}

const prebuilds = fileURLToPath(new URL('../node_modules/node-pty/prebuilds/', import.meta.url))
if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    const helper = `${prebuilds}${platform}/spawn-helper`
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
