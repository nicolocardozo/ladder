// Pubblica la versione di package.json su github.com/nicolocardozo/ladder-releases (pubblico; il codice resta privato).
// Prima: `pnpm run release:mac`, che lascia in dist/release i DMG e gli zip firmati e notarizzati di entrambe le architetture.
//
// Carica:
// - Ladder-arm64.dmg e Ladder-x64.dmg, nomi fissi: il sito (/download) punta sempre all'ultima release;
// - gli zip con i blockmap, che l'app scarica per aggiornarsi;
// - latest-mac.yml con entrambi gli zip: electron-builder ne scrive uno per build e il secondo sovrascriverebbe il primo,
//   quindi lo genero qui. electron-updater sceglie lo zip con "arm64" nel nome sui Mac Apple Silicon, l'altro sugli Intel.
//
// Uso: node scripts/publish-release.mjs [--draft]
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = 'nicolocardozo/ladder-releases'
const DIR = 'dist/release'
const ARCHS = ['arm64', 'x64']

const fail = (message) => {
  console.error(`\n${message}\n`)
  process.exit(1)
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${version}`
const file = (name) => {
  const path = join(DIR, name)
  if (!existsSync(path)) fail(`Non trovo ${path}. Lancia prima pnpm run release:mac.`)
  return path
}
const sha512 = (path) => createHash('sha512').update(readFileSync(path)).digest('base64')

const dmgs = ARCHS.map((arch) => ({ arch, path: file(`Ladder-${version}-${arch}.dmg`) }))
const zips = ARCHS.map((arch) => {
  const name = `Ladder-${version}-${arch}-mac.zip`
  return { name, path: file(name), blockmap: file(`${name}.blockmap`) }
})

const view = spawnSync('gh', ['release', 'view', tag, '--repo', REPO], { encoding: 'utf8' })
if (view.status === 0) fail(`La release ${tag} esiste già su ${REPO}. Alza la versione in package.json.`)

// I file con il nome pubblico vanno in una cartella a parte (gh carica col nome del file).
const out = join(DIR, `publish-${version}`)
rmSync(out, { recursive: true, force: true })
mkdirSync(out)
const assets = []
for (const { arch, path } of dmgs) {
  const target = join(out, `Ladder-${arch}.dmg`)
  copyFileSync(path, target)
  assets.push(target)
}
for (const zip of zips) assets.push(zip.path, zip.blockmap)

const entries = zips.map((zip) => ({ url: zip.name, sha512: sha512(zip.path), size: statSync(zip.path).size }))
const manifest = [
  `version: ${version}`,
  'files:',
  ...entries.flatMap((e) => [`  - url: ${e.url}`, `    sha512: ${e.sha512}`, `    size: ${e.size}`]),
  `path: ${entries[0].url}`,
  `sha512: ${entries[0].sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  ''
].join('\n')
const manifestPath = join(out, 'latest-mac.yml')
writeFileSync(manifestPath, manifest)
assets.push(manifestPath)

const notes = `Ladder ${version} for macOS. Ladder-arm64.dmg is for Apple Silicon Macs, Ladder-x64.dmg for Intel Macs: open the disk image and drag Ladder into Applications. Installed copies update on their own.`
const args = ['release', 'create', tag, ...assets, '--repo', REPO, '--title', `Ladder ${version}`, '--notes', notes]
if (process.argv.includes('--draft')) args.push('--draft')
else args.push('--latest')
const result = spawnSync('gh', args, { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`\nPubblicata ${tag}: https://github.com/${REPO}/releases/tag/${tag}`)
