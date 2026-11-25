// Publishes the package.json version to github.com/nicolocardozo/ladder-releases.
// First: `pnpm run release:mac`, which leaves the signed and notarized DMGs and zips for both architectures in dist/release.
//
// Uploads:
// - Ladder-arm64.dmg and Ladder-x64.dmg, fixed names: the website (/download) always points to the latest release;
// - the zips with their blockmaps, which the app downloads to update itself;
// - latest-mac.yml with both zips: electron-builder writes one per build and the second would overwrite the first,
//   so it is generated here. electron-updater picks the zip with "arm64" in the name on Apple Silicon Macs, the other on Intel.
//
// Usage: node scripts/publish-release.mjs [--draft]
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
  if (!existsSync(path)) fail(`Can't find ${path}. Run pnpm run release:mac first.`)
  return path
}
const sha512 = (path) => createHash('sha512').update(readFileSync(path)).digest('base64')

const dmgs = ARCHS.map((arch) => ({ arch, path: file(`Ladder-${version}-${arch}.dmg`) }))
const zips = ARCHS.map((arch) => {
  const name = `Ladder-${version}-${arch}-mac.zip`
  return { name, path: file(name), blockmap: file(`${name}.blockmap`) }
})

const view = spawnSync('gh', ['release', 'view', tag, '--repo', REPO], { encoding: 'utf8' })
if (view.status === 0) fail(`Release ${tag} already exists on ${REPO}. Bump the version in package.json.`)

// Files with the public name go in a separate folder (gh uploads using the file name).
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
console.log(`\nPublished ${tag}: https://github.com/${REPO}/releases/tag/${tag}`)
