// Git per l'host: informazioni sul repo, checkpoint con indice temporaneo (vedi spikes/git-checkpoint),
// diff tra checkpoint, stato dei file, ripristino senza toccare indice e branch, log e worktree.
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { FileChange, GitStatusCode } from '@shared/protocol'

const run = promisify(execFile)

/** Albero vuoto di git: il "prima" dei repo senza commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** I file non tracciati più grandi restano fuori dai checkpoint: un video da 2 GB non va copiato negli oggetti di git. */
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024
/** Oltre questa dimensione il viewer e il diff non mostrano il contenuto. */
export const MAX_TEXT_BYTES = 1024 * 1024

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ladder',
  GIT_AUTHOR_EMAIL: 'ladder@localhost',
  GIT_COMMITTER_NAME: 'Ladder',
  GIT_COMMITTER_EMAIL: 'ladder@localhost'
}

/** `--no-optional-locks`: le letture non riscrivono l'indice, quindi non si scontrano con git dell'utente o dell'agente. */
const BASE_ARGS = ['--no-optional-locks', '-c', 'core.quotePath=false']

export async function git(repo: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, ...BASE_ARGS, ...args], {
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024
  })
  return stdout.trimEnd()
}

async function gitBuffer(repo: string, args: string[]): Promise<Buffer> {
  const { stdout } = await run('git', ['-C', repo, ...BASE_ARGS, ...args], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024
  })
  return stdout
}

/** Come `git`, ma con `input` sullo stdin. */
function gitInput(repo: string, args: string[], input: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, ...BASE_ARGS, ...args], { env: { ...process.env, ...env } })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out.trimEnd()) : reject(new Error(err.trim() || `git ${args[0]} uscito con ${code}`))))
    child.stdin.end(input)
  })
}

export interface RepoInfo {
  isGit: boolean
  branch: string | null
  hasHead: boolean
}

export async function repoInfo(path: string): Promise<RepoInfo> {
  try {
    const inside = await git(path, ['rev-parse', '--is-inside-work-tree'])
    if (inside !== 'true') return { isGit: false, branch: null, hasHead: false }
  } catch {
    return { isGit: false, branch: null, hasHead: false }
  }
  let branch: string | null = null
  try {
    branch = (await git(path, ['symbolic-ref', '--short', '-q', 'HEAD'])) || null
  } catch {
    branch = null
  }
  return { isGit: true, branch, hasHead: (await resolveCommit(path, 'HEAD')) !== null }
}

/** Sha del commit a cui punta `ref`, oppure null. */
export async function resolveCommit(repo: string, ref: string): Promise<string | null> {
  try {
    return (await git(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])) || null
  } catch {
    return null
  }
}

/** File del progetto: tracciati più non tracciati non ignorati, al massimo `limit`. */
export async function listFiles(path: string, limit = 20000): Promise<string[]> {
  const out = await git(path, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  const files = out.split('\0').filter(Boolean)
  return [...new Set(files)].slice(0, limit)
}

/**
 * Fotografa working tree e file non tracciati in un commit su `ref`, senza toccare indice e branch dell'utente.
 * Parte da una copia dell'indice dell'utente (4–5 volte più veloce di read-tree). Funziona anche senza commit iniziale.
 */
export async function createCheckpoint(repo: string, ref: string, message: string): Promise<string | null> {
  const info = await repoInfo(repo)
  if (!info.isGit) return null
  const dir = await mkdtemp(join(tmpdir(), 'ladder-idx-'))
  const tmpIndex = join(dir, 'index')
  const env = { GIT_INDEX_FILE: tmpIndex, ...IDENTITY }
  try {
    const gitDir = await git(repo, ['rev-parse', '--absolute-git-dir'])
    const userIndex = join(gitDir, 'index')
    if (existsSync(userIndex)) {
      await copyFile(userIndex, tmpIndex)
      // La copia deve avere la data dell'originale: git confronta le date dei file con quella dell'indice per
      // ricontrollare i file modificati nello stesso secondo (racy git). Con una data nuova li darebbe per invariati.
      const { atime, mtime } = await stat(userIndex)
      await utimes(tmpIndex, atime, mtime)
    } else if (info.hasHead) await git(repo, ['read-tree', 'HEAD'], env)
    // File tracciati: modifiche e cancellazioni.
    await git(repo, ['add', '-u'], env)
    // Non tracciati e non ignorati, senza i file enormi e senza i repo annidati.
    const others = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'], env)).split('\0').filter(Boolean)
    const small: string[] = []
    for (const file of others) {
      try {
        const s = await lstat(join(repo, file))
        if ((s.isFile() && s.size <= MAX_UNTRACKED_BYTES) || s.isSymbolicLink()) small.push(file)
      } catch {
        // Sparito nel frattempo.
      }
    }
    if (small.length > 0) await gitInput(repo, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], small.join('\0'), env)
    const tree = await git(repo, ['write-tree'], env)
    const parent = info.hasHead ? ['-p', (await resolveCommit(repo, 'HEAD'))!] : []
    const commit = await git(repo, ['commit-tree', tree, ...parent, '-m', message], env)
    await git(repo, ['update-ref', ref, commit])
    return commit
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Commit di partenza per il diff di un commit: il genitore, o l'albero vuoto per il primo commit. */
export async function parentOf(repo: string, sha: string): Promise<string> {
  return (await resolveCommit(repo, `${sha}^`)) ?? EMPTY_TREE
}

/**
 * File cambiati tra due stati, con righe aggiunte e tolte. Rinomine riconosciute con -M.
 * `--relative`: se il progetto è una sottocartella del repository (monorepo), percorsi e diff restano dentro di lei.
 */
export async function changedFiles(repo: string, from: string, to: string, paths: string[] = []): Promise<FileChange[]> {
  const tail = paths.length ? ['--', ...paths] : []
  const [numstat, nameStatus] = await Promise.all([
    git(repo, ['diff', '--no-ext-diff', '--relative', '--numstat', '-z', '-M', from, to, ...tail]),
    git(repo, ['diff', '--no-ext-diff', '--relative', '--name-status', '-z', '-M', from, to, ...tail])
  ])

  // name-status -z: "M\0percorso\0" oppure "R100\0vecchio\0nuovo\0".
  const status = new Map<string, { status: FileChange['status']; oldPath?: string }>()
  const ns = nameStatus.split('\0')
  for (let i = 0; i < ns.length; ) {
    const code = ns[i]
    if (!code) {
      i++
      continue
    }
    if (code[0] === 'R' || code[0] === 'C') {
      status.set(ns[i + 2], { status: 'R', oldPath: ns[i + 1] })
      i += 3
    } else {
      const letter = code[0]
      status.set(ns[i + 1], { status: letter === 'A' || letter === 'D' ? letter : 'M' })
      i += 2
    }
  }

  // numstat -z: "aggiunte\ttolte\tpercorso\0" oppure "aggiunte\ttolte\t\0vecchio\0nuovo\0".
  const files: FileChange[] = []
  const nm = numstat.split('\0')
  for (let i = 0; i < nm.length; ) {
    const record = nm[i]
    if (!record) {
      i++
      continue
    }
    const [added, removed, path] = record.split('\t')
    let file: string
    if (path === '') {
      file = nm[i + 2]
      i += 3
    } else {
      file = path
      i += 1
    }
    const info = status.get(file)
    const binary = added === '-'
    files.push({
      path: file,
      ...(info?.oldPath ? { oldPath: info.oldPath } : {}),
      added: binary ? 0 : Number(added),
      removed: binary ? 0 : Number(removed),
      status: info?.status ?? 'M',
      ...(binary ? { binary: true } : {})
    })
  }
  return files
}

/** Diff unificato di un file tra due stati. */
export async function filePatch(repo: string, from: string, to: string, path: string, oldPath: string | null): Promise<string> {
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path]
  return git(repo, ['diff', '--no-ext-diff', '--relative', '--no-color', '-U3', '-M', from, to, '--', ...paths])
}

export interface Blob {
  text: string | null
  binary: boolean
  tooLarge: boolean
  exists: boolean
}

/** Contenuto di `path` nello stato `rev` (commit o albero), con limiti di dimensione e controllo dei binari. */
export async function blobAt(repo: string, rev: string, path: string): Promise<Blob> {
  if (rev === EMPTY_TREE) return { text: null, binary: false, tooLarge: false, exists: false }
  let size: number
  try {
    // "./" rende il percorso relativo alla cartella del progetto anche dentro un monorepo.
    size = Number(await git(repo, ['cat-file', '-s', `${rev}:./${path}`]))
  } catch {
    return { text: null, binary: false, tooLarge: false, exists: false }
  }
  if (size > MAX_TEXT_BYTES) return { text: null, binary: false, tooLarge: true, exists: true }
  const buffer = await gitBuffer(repo, ['cat-file', 'blob', `${rev}:./${path}`])
  if (isBinary(buffer)) return { text: null, binary: true, tooLarge: false, exists: true }
  return { text: buffer.toString('utf8'), binary: false, tooLarge: false, exists: true }
}

export function isBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, 8000)
  for (let i = 0; i < end; i++) if (buffer[i] === 0) return true
  return false
}

/** Stato git dei file rispetto a HEAD e all'indice: una lettera per file. */
export async function statusMap(repo: string): Promise<Record<string, GitStatusCode>> {
  // Il formato porcelain usa percorsi dalla radice del repository: si riportano alla cartella del progetto.
  const [out, prefix] = await Promise.all([
    git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.']),
    git(repo, ['rev-parse', '--show-prefix'])
  ])
  const map: Record<string, GitStatusCode> = {}
  for (const entry of out.split('\0')) {
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const full = entry.slice(3)
    if (prefix && !full.startsWith(prefix)) continue
    const path = full.slice(prefix.length)
    if (x === '?' && y === '?') map[path] = '?'
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) map[path] = 'U'
    else if (x === 'D' || y === 'D') map[path] = 'D'
    else if (x === 'A') map[path] = 'A'
    else map[path] = 'M'
  }
  return map
}

/**
 * Riporta `paths` allo stato di `rev` scrivendo i file direttamente: indice, branch e stash dell'utente restano come sono.
 * Un file che in `rev` non esiste viene cancellato.
 */
export async function restorePaths(repo: string, rev: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const target = join(repo, path)
    const entry = rev === EMPTY_TREE ? '' : await git(repo, ['ls-tree', '-z', rev, '--', path])
    const record = entry.split('\0').find((r) => r.endsWith(`\t${path}`))
    if (!record) {
      await rm(target, { force: true })
      continue
    }
    const [mode, type, object] = record.slice(0, record.indexOf('\t')).split(' ')
    if (type !== 'blob') continue // sottomoduli: non si toccano
    const content = await gitBuffer(repo, ['cat-file', 'blob', object])
    await mkdir(dirname(target), { recursive: true })
    const existing = await lstat(target).catch(() => null)
    if (existing?.isDirectory()) continue
    if (existing) await unlink(target)
    if (mode === '120000') await symlink(content.toString('utf8'), target)
    else {
      await writeFile(target, content)
      await chmod(target, mode === '100755' ? 0o755 : 0o644)
    }
  }
}

export interface CommitInfo {
  sha: string
  parents: string[]
  subject: string
  author: string
  at: number
}

export async function commitLog(repo: string, limit = 40): Promise<CommitInfo[]> {
  if (!(await resolveCommit(repo, 'HEAD'))) return []
  const out = await git(repo, ['log', '-n', String(limit), '--format=%H%x1f%P%x1f%s%x1f%an%x1f%at%x1e', 'HEAD'])
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, subject, author, at] = record.split('\x1f')
      return { sha, parents: parents ? parents.split(' ') : [], subject, author, at: Number(at) * 1000 }
    })
}

/** Aggiunge righe a .git/info/exclude se mancano: esclude file personali senza toccare il .gitignore. */
export async function ensureExcluded(repo: string, patterns: string[]): Promise<void> {
  const common = await git(repo, ['rev-parse', '--git-common-dir'])
  const file = join(isAbsolute(common) ? common : join(repo, common), 'info', 'exclude')
  const current = await readFile(file, 'utf8').catch(() => '')
  const lines = new Set(current.split('\n').map((l) => l.trim()))
  const missing = patterns.filter((p) => !lines.has(p))
  if (missing.length === 0) return
  await mkdir(dirname(file), { recursive: true })
  const prefix = current && !current.endsWith('\n') ? '\n' : ''
  await appendFile(file, `${prefix}# Ladder: file personali e contesto delle sessioni\n${missing.join('\n')}\n`)
}

/** Nuovo worktree su un nuovo branch, partendo da `base`. */
export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await git(repo, ['worktree', 'add', '-b', branch, path, base])
}

/** Vero se `path` è un file o una cartella che esiste. */
export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/** Worktree su un branch che esiste già, locale o su origin (git crea il branch locale che lo segue). */
export async function addWorktreeForBranch(repo: string, path: string, branch: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await git(repo, ['worktree', 'add', path, branch])
}

/** Toglie un worktree solo se è pulito: con modifiche o file non tracciati git si rifiuta, e va bene così. */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', path])
}

export async function fetchRef(repo: string, refspec: string): Promise<void> {
  await git(repo, ['fetch', '--quiet', 'origin', refspec])
}

/** Commit di `a` che `b` non ha (a sinistra) e viceversa. */
export async function aheadBehind(repo: string, head: string, base: string): Promise<{ ahead: number; behind: number } | null> {
  try {
    const [ahead, behind] = (await git(repo, ['rev-list', '--left-right', '--count', `${head}...${base}`])).split(/\s+/).map(Number)
    return { ahead: ahead || 0, behind: behind || 0 }
  } catch {
    return null
  }
}

/** File modificati o non tracciati, come li conta git status. */
export async function dirtyCount(repo: string): Promise<number> {
  const entries = (await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])).split('\0')
  let count = 0
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    count++
    // Rinomine e copie hanno il percorso di origine nella voce successiva.
    if (entry[0] === 'R' || entry[0] === 'C') i++
  }
  return count
}

/** Commit non pubblicati sull'upstream; null se il branch non ne ha uno. */
export async function unpushedCount(repo: string): Promise<number | null> {
  try {
    return Number(await git(repo, ['rev-list', '--count', '@{upstream}..HEAD'])) || 0
  } catch {
    return null
  }
}

/** File in conflitto unendo `base` in `head`, calcolati con merge-tree: la cartella di lavoro non cambia. */
export async function mergeConflicts(repo: string, head: string, base: string): Promise<string[]> {
  try {
    await run('git', ['-C', repo, ...BASE_ARGS, 'merge-tree', '--write-tree', '--name-only', '--no-messages', head, base], { maxBuffer: 16 * 1024 * 1024 })
    return []
  } catch (error) {
    // Codice 1: unione con conflitti. La prima riga è l'albero, poi i file in conflitto.
    const e = error as { code?: number; stdout?: string }
    if (e.code !== 1 || typeof e.stdout !== 'string') return []
    return [...new Set(e.stdout.trim().split('\n').slice(1).map((l) => l.trim()).filter(Boolean))]
  }
}

export interface BranchInfo {
  name: string
  remote: boolean
  at: number
  subject: string
}

/** Branch locali e di origin, i più recenti prima. */
export async function listBranches(repo: string): Promise<BranchInfo[]> {
  const out = await git(repo, ['for-each-ref', '--sort=-committerdate', '--count=200', '--format=%(refname)%1f%(committerdate:unix)%1f%(contents:subject)', 'refs/heads', 'refs/remotes/origin'])
  const seen = new Set<string>()
  const branches: BranchInfo[] = []
  for (const line of out.split('\n')) {
    const [ref, at, subject] = line.split('\x1f')
    if (!ref) continue
    const remote = ref.startsWith('refs/remotes/')
    const name = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, '')
    if (name === 'HEAD' || seen.has(name)) continue
    seen.add(name)
    branches.push({ name, remote, at: Number(at) * 1000, subject: subject ?? '' })
  }
  return branches
}
