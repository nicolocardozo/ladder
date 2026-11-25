// After install: pnpm does not run dependency scripts, so this does the bare minimum.
// 1. Electron binary, if missing.
// 2. node-pty: the prebuild's spawn-helper ships without execute permission and the first spawn would fail.
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
