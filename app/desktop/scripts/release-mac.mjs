// Distributable build: .dmg signed with a Developer ID and notarized by Apple.
// Needs a "Developer ID Application" certificate in the Keychain and a profile created with
// `xcrun notarytool store-credentials ladder-notary`. The credentials stay in the Keychain.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const PROFILE = process.env.LADDER_NOTARY_PROFILE ?? 'ladder-notary'
const fail = (message) => {
  console.error(`\n${message}\n`)
  process.exit(1)
}

const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
const identity = identities.match(/"Developer ID Application: ([^"]+)"/)?.[1]
if (!identity) fail('The "Developer ID Application" certificate is missing from the Keychain. Create it in Xcode: Settings → Accounts → Manage Certificates.')

const check = spawnSync('xcrun', ['notarytool', 'history', '--keychain-profile', PROFILE], { encoding: 'utf8' })
if (check.status !== 0) fail(`The notarization profile "${PROFILE}" is missing. Create it with: xcrun notarytool store-credentials ${PROFILE}`)

// No APPLE_KEYCHAIN: store-credentials saves to the protected keychain, an explicit path hides it.
const env = { ...process.env, APPLE_KEYCHAIN_PROFILE: PROFILE }
delete env.APPLE_KEYCHAIN
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
// One DMG for Apple Silicon and one for Intel. --arch=arm64 or --arch=x64 builds only one.
const only = process.argv.find((a) => a.startsWith('--arch='))?.slice('--arch='.length)
const archs = only ? [only] : ['arm64', 'x64']
if (archs.some((a) => a !== 'arm64' && a !== 'x64')) fail(`Unknown architecture: ${only}. Use arm64 or x64.`)

// --dmg-only: redoes only signing and notarization of the already built DMGs.
if (!process.argv.includes('--dmg-only')) {
  run('npx', ['electron-vite', 'build'])
  run('node', ['scripts/third-party-notices.mjs'])
  for (const arch of archs) {
    // The arm64 Electron is already in node_modules: no download, which occasionally fails. electron-builder downloads the Intel one (then it stays cached).
    const dist = arch === 'arm64' ? ['-c.electronDist=node_modules/electron/dist'] : []
    run('npx', ['electron-builder', '--mac', `--${arch}`, '--publish', 'never', '-c', 'electron-builder.release.yml', `-c.mac.identity=${identity}`, ...dist])
  }
}

// electron-builder notarizes the app but leaves the DMG unsigned: sign, notarize and staple that too,
// so the downloaded file passes Gatekeeper without warnings.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const ready = []
for (const arch of archs) {
  const dmg = `dist/release/Ladder-${version}-${arch}.dmg`
  if (!existsSync(dmg)) fail(`Can't find ${dmg}.`)
  run('codesign', ['--force', '--timestamp', '--sign', `Developer ID Application: ${identity}`, dmg])
  run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', PROFILE, '--wait'])
  run('xcrun', ['stapler', 'staple', dmg])
  ready.push(dmg)
}
console.log(`\nReady:\n${ready.join('\n')}\n\nTo publish them (DMG, update zips and latest-mac.yml): node scripts/publish-release.mjs`)
