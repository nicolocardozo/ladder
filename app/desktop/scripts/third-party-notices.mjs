// Writes out/THIRD_PARTY_NOTICES.txt: the license of every package whose code ships inside the app,
// either bundled by electron-vite or copied as a node module. It starts from the runtime dependencies
// in package.json and follows their dependencies through node_modules, the way Node resolves them.
// Build tools (vite, electron-builder, type packages) are left out because none of their code ships.
// Electron and Chromium have their own files, copied next to this one by electron-builder.yml.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const BUILD_ONLY = new Set([
  '@tailwindcss/vite',
  '@vitejs/plugin-react',
  'electron',
  'electron-builder',
  'electron-vite',
  'shadcn',
  'typescript',
  'vite',
])
const isBuildOnly = (name) => BUILD_ONLY.has(name) || name.startsWith('@types/')

const start = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})].filter(
  (name) => !isBuildOnly(name),
)

// Node's lookup: <dir>/node_modules/<name>, then the same in every parent directory.
function findPackage(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i

const seen = new Map()
const missing = []
function visit(name, fromDir, optional) {
  const dir = findPackage(name, fromDir)
  if (!dir) {
    // Optional dependencies for other platforms are not installed: nothing of theirs ships.
    if (!optional) missing.push(name)
    return
  }
  if (seen.has(dir)) return
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort()
  seen.set(dir, {
    name: pkg.name ?? name,
    version: pkg.version ?? '',
    license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see the text below'),
    homepage: pkg.homepage ?? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ?? '',
    texts: files.map((f) => readFileSync(join(dir, f), 'utf8').trim()),
  })
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir, false)
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dep, dir, true)
}
for (const name of start) visit(name, root, false)

if (missing.length) {
  console.error(`third-party-notices: packages not found in node_modules: ${[...new Set(missing)].join(', ')}`)
  process.exit(1)
}

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const rule = '-'.repeat(78)
const body = entries
  .map((e) => {
    const head = [`${e.name} ${e.version}`, `License: ${e.license}`, e.homepage && `Source: ${e.homepage}`].filter(Boolean)
    const text = e.texts.length ? e.texts.join('\n\n') : `No license file in the package. License declared in package.json: ${e.license}.`
    return `${rule}\n${head.join('\n')}\n\n${text}\n`
  })
  .join('\n')

const header = [
  'Ladder includes the following third-party software.',
  'Electron and Chromium notices are in LICENSE.electron.txt and LICENSES.chromium.html in the same folder.',
  '',
].join('\n')

mkdirSync(join(root, 'out'), { recursive: true })
writeFileSync(join(root, 'out', 'THIRD_PARTY_NOTICES.txt'), `${header}\n${body}`)
const unlicensed = entries.filter((e) => !e.texts.length).map((e) => e.name)
console.log(`third-party-notices: ${entries.length} packages written to out/THIRD_PARTY_NOTICES.txt`)
if (unlicensed.length) console.log(`third-party-notices: no license file in ${unlicensed.join(', ')}`)
