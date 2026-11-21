// Verifica S4: i checkpoint con indice temporaneo sono rapidi e innocui?
// Uso: node run.ts [percorso-repo-reale ...]  (i repo reali vengono clonati in una cartella temporanea)
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createCheckpoint, deleteCheckpoints, diffBetween, git, listCheckpoints, restoreCheckpoint, type IndexSeed } from './checkpoint.ts'

const results: { check: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  · ${detail}` : ''}`)
}

function sha(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

/** Impronta del working tree, escluse .git e le cartelle ignorate più comuni. */
function treeFingerprint(root: string): string {
  const hash = createHash('sha1')
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else hash.update(relative(root, full)).update(readFileSync(full))
    }
  }
  walk(root)
  return hash.digest('hex')
}

function write(repo: string, file: string, content: string): void {
  const full = join(repo, file)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

function time<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now()
  const value = fn()
  return { value, ms: Math.round(performance.now() - start) }
}

// ── 1. Correttezza su un repo sintetico ─────────────────────────────────────
const base = mkdtempSync(join(tmpdir(), 'blue-ckpt-'))
const repo = join(base, 'repo')
mkdirSync(repo)
git(repo, ['init', '-q', '-b', 'main'])
git(repo, ['config', 'user.name', 'Test'])
git(repo, ['config', 'user.email', 'test@example.com'])
write(repo, '.gitignore', 'dist/\nnode_modules/\n')
write(repo, 'src/a.ts', 'export const a = 1\n')
write(repo, 'src/b.ts', 'export const b = 2\n')
write(repo, 'README.md', '# prova\n')
git(repo, ['add', '-A'])
git(repo, ['commit', '-q', '-m', 'iniziale'])

// Stato "sporco" dell'utente: una modifica in stage, una non in stage, un file nuovo, un file ignorato.
write(repo, 'src/a.ts', 'export const a = 10\n')
git(repo, ['add', 'src/a.ts'])
write(repo, 'src/b.ts', 'export const b = 20\n')
write(repo, 'src/nuovo.ts', 'export const c = 3\n')
write(repo, 'dist/bundle.js', 'ignorato\n')

const gitDir = git(repo, ['rev-parse', '--absolute-git-dir'])
const before = {
  index: sha(join(gitDir, 'index')),
  status: git(repo, ['status', '--porcelain=v2']),
  staged: git(repo, ['diff', '--cached']),
  head: git(repo, ['rev-parse', 'HEAD']),
  branches: git(repo, ['branch', '--list']),
  tree: treeFingerprint(repo)
}

const c1 = createCheckpoint(repo, 'refs/blue/s1/turn-1-start', 'blue: inizio turno 1')
check('indice dell’utente invariato', sha(join(gitDir, 'index')) === before.index)
check('stato git invariato', git(repo, ['status', '--porcelain=v2']) === before.status)
check('modifiche in stage invariate', git(repo, ['diff', '--cached']) === before.staged)
check('HEAD e branch invariati', git(repo, ['rev-parse', 'HEAD']) === before.head && git(repo, ['branch', '--list']) === before.branches)
check('working tree invariato', treeFingerprint(repo) === before.tree)
const files1 = git(repo, ['ls-tree', '-r', '--name-only', c1]).split('\n')
check('include i file non tracciati', files1.includes('src/nuovo.ts'), files1.join(', '))
check('esclude i file ignorati', !files1.some((f) => f.startsWith('dist/')))
check('il ref privato non compare tra i branch', !git(repo, ['branch', '--all']).includes('blue'))

// Il "turno" dell'agente: modifica, crea, cancella.
write(repo, 'src/b.ts', 'export const b = 200\n')
write(repo, 'src/agente.ts', 'export const fatto = true\n')
rmSync(join(repo, 'README.md'))
const c2 = createCheckpoint(repo, 'refs/blue/s1/turn-1-end', 'blue: fine turno 1')
const stat = diffBetween(repo, c1, c2)
check(
  'diff del turno = solo le modifiche dell’agente',
  stat.includes('src/b.ts') && stat.includes('src/agente.ts') && stat.includes('README.md') && !stat.includes('src/a.ts') && !stat.includes('nuovo.ts'),
  stat.split('\n').at(-1) ?? ''
)

// Ripristino allo stato di inizio turno.
const indexBeforeRestore = sha(join(gitDir, 'index'))
const { removed } = restoreCheckpoint(repo, c1, 'refs/blue/s1/before-restore-1')
check('ripristino: working tree uguale al checkpoint', treeFingerprint(repo) === before.tree, `rimossi: ${removed.join(', ') || 'nessuno'}`)
check('ripristino: indice dell’utente invariato', sha(join(gitDir, 'index')) === indexBeforeRestore)
check('ripristino: stato precedente salvato', listCheckpoints(repo, 'refs/blue/s1/').includes('refs/blue/s1/before-restore-1'))
check('pulizia dei checkpoint di sessione', deleteCheckpoints(repo, 'refs/blue/s1/') === 3 && listCheckpoints(repo, 'refs/blue/s1/').length === 0)

// ── 2. Tempi su un repo sintetico grande ────────────────────────────────────
const big = join(base, 'big')
mkdirSync(big)
git(big, ['init', '-q', '-b', 'main'])
git(big, ['config', 'user.name', 'Test'])
git(big, ['config', 'user.email', 'test@example.com'])
for (let i = 0; i < 5000; i++) write(big, `src/m${Math.floor(i / 100)}/f${i}.ts`, `export const v${i} = ${i}\n`.repeat(20))
git(big, ['add', '-A'])
git(big, ['commit', '-q', '-m', 'iniziale'])
for (let i = 0; i < 20; i++) write(big, `src/m0/f${i}.ts`, `// modificato\nexport const x = ${i}\n`)
for (let i = 0; i < 50; i++) write(big, `src/nuovi/n${i}.ts`, `export const n = ${i}\n`)

const timings: Record<string, number> = {}
for (const seed of ['read-tree', 'copy-index'] as IndexSeed[]) {
  timings[`sintetico 5.000 file · ${seed}`] = time(() => createCheckpoint(big, `refs/blue/t/${seed}`, 'tempo', seed)).ms
}
timings['sintetico 5.000 file · copy-index, secondo checkpoint'] = time(() => createCheckpoint(big, 'refs/blue/t/again', 'tempo')).ms

// ── 3. Tempi su cloni locali di repo reali (il repo originale non viene toccato) ──
for (const source of process.argv.slice(2)) {
  const name = source.split('/').filter(Boolean).at(-1) ?? 'repo'
  const tracked = Number(execFileSync('git', ['-C', source, 'ls-files'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).split('\n').length)
  if (tracked > 60000) {
    console.log(`SKIP  ${name}: ${tracked} file tracciati`)
    continue
  }
  const clone = join(base, `clone-${name}`)
  execFileSync('git', ['clone', '-q', '--local', source, clone])
  write(clone, 'blue-prova/nuovo.ts', 'export const prova = true\n')
  const first = git(clone, ['ls-files']).split('\n')[0]
  if (first) writeFileSync(join(clone, first), readFileSync(join(clone, first), 'utf8') + '\n// modifica di prova\n')
  for (const seed of ['read-tree', 'copy-index'] as IndexSeed[]) {
    timings[`${name} (${tracked} file) · ${seed}`] = time(() => createCheckpoint(clone, `refs/blue/t/${seed}`, 'tempo', seed)).ms
  }
  timings[`${name} (${tracked} file) · copy-index, secondo checkpoint`] = time(() => createCheckpoint(clone, 'refs/blue/t/again', 'tempo')).ms
}

for (const [label, ms] of Object.entries(timings)) {
  const ok = !label.includes('read-tree') ? ms < 300 : true
  check(`tempo · ${label}`, ok, `${ms} ms`)
}

rmSync(base, { recursive: true, force: true })
mkdirSync(new URL('./results/', import.meta.url), { recursive: true })
writeFileSync(new URL('./results/run.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} verifiche passate`)
process.exit(failed ? 1 : 0)
