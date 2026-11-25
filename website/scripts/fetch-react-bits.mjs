// Downloads the React Bits components the website uses from the public React Bits registry.
// Their license (MIT + Commons Clause) allows using them in a website but not redistributing their source,
// so they are not committed: this script fetches them before dev, build and typecheck into a git-ignored folder.
// Each download is checked against a pinned sha256, so an upstream change can't alter the site silently.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'react-bits')

// The same small change applied to both components: the settings ref is updated after render, as the rules of hooks ask.
const REF_AFTER_RENDER = {
  find: '  settingsRef.current = settings;\n',
  replace: '  // updated after render, as the rules of hooks ask\n  useEffect(() => {\n    settingsRef.current = settings;\n  });\n',
}

const COMPONENTS = [
  { item: 'GhostFibers-TS-TW', file: 'GhostFibers.tsx', sha256: 'b4fc350dc4cc6117f1b061aac75ac3a869ac528e832003e1f23d46e073b948e8', patches: [REF_AFTER_RENDER] },
  { item: 'GradientWaves-TS-TW', file: 'GradientWaves.tsx', sha256: '87aedb9cc36dfabf93b26ee96b694624febb6c8746d2d55685e3570f499aa5ce', patches: [REF_AFTER_RENDER] },
]

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const stamp = (c) => `// Fetched from https://reactbits.dev/r/${c.item}.json (sha256 ${c.sha256}), React Bits, MIT + Commons Clause.\n// Not part of this repository: see scripts/fetch-react-bits.mjs.\n`

function applyPatches(source, c) {
  let out = source
  for (const p of c.patches) {
    const at = out.indexOf(p.find)
    if (at === -1 || out.indexOf(p.find, at + 1) !== -1) throw new Error(`${c.file}: the local patch no longer applies`)
    out = out.slice(0, at) + p.replace + out.slice(at + p.find.length)
  }
  return stamp(c) + out
}

mkdirSync(OUT, { recursive: true })
let failed = false
for (const c of COMPONENTS) {
  const target = join(OUT, c.file)
  // Already fetched for this pinned version: nothing to do, also offline.
  if (existsSync(target) && readFileSync(target, 'utf8').startsWith(stamp(c))) continue
  try {
    const res = await fetch(`https://reactbits.dev/r/${c.item}.json`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const item = await res.json()
    const source = item.files?.find((f) => f.path.endsWith('.tsx'))?.content
    if (typeof source !== 'string') throw new Error('no .tsx file in the registry item')
    const hash = sha256(source)
    if (hash !== c.sha256) {
      throw new Error(`upstream content changed (sha256 ${hash}). Check the component visually, then update the pin and the patches.`)
    }
    writeFileSync(target, applyPatches(source, c))
    console.log(`react-bits: fetched ${c.file}`)
  } catch (error) {
    failed = true
    console.error(`react-bits: ${c.item}: ${error.message}`)
  }
}
if (failed) process.exit(1)
