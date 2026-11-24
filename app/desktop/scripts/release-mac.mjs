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
// Un DMG per Apple Silicon e uno per Intel. --arch=arm64 o --arch=x64 ne costruisce uno solo.
const only = process.argv.find((a) => a.startsWith('--arch='))?.slice('--arch='.length)
const archs = only ? [only] : ['arm64', 'x64']
if (archs.some((a) => a !== 'arm64' && a !== 'x64')) fail(`Architettura sconosciuta: ${only}. Usa arm64 o x64.`)

// --dmg-only: rifà solo firma e notarizzazione dei DMG già costruiti.
if (!process.argv.includes('--dmg-only')) {
  run('npx', ['electron-vite', 'build'])
  for (const arch of archs) {
    // Electron arm64 è già in node_modules: niente download, che ogni tanto fallisce. Quello Intel lo scarica electron-builder (poi resta in cache).
    const dist = arch === 'arm64' ? ['-c.electronDist=node_modules/electron/dist'] : []
    run('npx', ['electron-builder', '--mac', `--${arch}`, '--publish', 'never', '-c', 'electron-builder.release.yml', `-c.mac.identity=${identity}`, ...dist])
  }
}

// electron-builder notarizza l'app ma lascia il DMG senza firma: firmo, notarizzo e graffo anche quello,
// così il file scaricato passa Gatekeeper senza avvisi.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const ready = []
for (const arch of archs) {
  const dmg = `dist/release/Ladder-${version}-${arch}.dmg`
  if (!existsSync(dmg)) fail(`Non trovo ${dmg}.`)
  run('codesign', ['--force', '--timestamp', '--sign', `Developer ID Application: ${identity}`, dmg])
  run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', PROFILE, '--wait'])
  run('xcrun', ['stapler', 'staple', dmg])
  ready.push(dmg)
}
console.log(`\nPronti:\n${ready.join('\n')}\n\nPer pubblicarli (DMG, zip per gli aggiornamenti e latest-mac.yml): node scripts/publish-release.mjs`)
