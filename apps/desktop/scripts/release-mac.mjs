// Build da distribuire: .dmg firmato con Developer ID e notarizzato da Apple.
// Serve un certificato "Developer ID Application" nel Portachiavi e un profilo creato con
// `xcrun notarytool store-credentials ladder-notary`. Le credenziali restano nel Portachiavi.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const PROFILE = process.env.LADDER_NOTARY_PROFILE ?? 'ladder-notary'
const fail = (message) => {
  console.error(`\n${message}\n`)
  process.exit(1)
}

const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
const identity = identities.match(/"Developer ID Application: ([^"]+)"/)?.[1]
if (!identity) fail('Manca il certificato "Developer ID Application" nel Portachiavi. Crealo da Xcode: Settings → Accounts → Manage Certificates.')

const check = spawnSync('xcrun', ['notarytool', 'history', '--keychain-profile', PROFILE], { encoding: 'utf8' })
if (check.status !== 0) fail(`Manca il profilo di notarizzazione "${PROFILE}". Crealo con: xcrun notarytool store-credentials ${PROFILE}`)

// Niente APPLE_KEYCHAIN: store-credentials salva nel portachiavi protetto, un percorso esplicito lo nasconde.
const env = { ...process.env, APPLE_KEYCHAIN_PROFILE: PROFILE }
delete env.APPLE_KEYCHAIN
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
// --dmg-only: rifà solo firma e notarizzazione del DMG già costruito.
if (!process.argv.includes('--dmg-only')) {
  run('npx', ['electron-vite', 'build'])
  // Electron è già in node_modules: niente download, che ogni tanto fallisce.
  run('npx', ['electron-builder', '--mac', '-c', 'electron-builder.release.yml', `-c.mac.identity=${identity}`, '-c.electronDist=node_modules/electron/dist'])
}

// electron-builder notarizza l'app ma lascia il DMG senza firma: firmo, notarizzo e graffo anche quello,
// così il file scaricato passa Gatekeeper senza avvisi.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const dmg = `dist/release/Ladder-${version}-arm64.dmg`
if (!existsSync(dmg)) fail(`Non trovo ${dmg}.`)
run('codesign', ['--force', '--timestamp', '--sign', `Developer ID Application: ${identity}`, dmg])
run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', PROFILE, '--wait'])
run('xcrun', ['stapler', 'staple', dmg])
console.log(`\nPronto: ${dmg}`)
