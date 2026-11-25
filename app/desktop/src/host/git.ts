// Git for the host: repo information, checkpoints with a temporary index (see spikes/git-checkpoint),
// diff between checkpoints, file state, restore without touching index and branch, log and worktrees.
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { t } from '@shared/i18n'
import { MAX_COMMIT_SUBJECT, type FileChange, type GitStatus, type GitStatusCode } from '@shared/protocol'
import { cleanEnv, shellPath } from './agents/common'

const run = promisify(execFile)

/** Git's empty tree: the "before" of repos with no commits. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** Untracked files above this size stay out of checkpoints: a 2 GB video must not be copied into git's objects. */
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024
/** Above this size the viewer and the diff don't show the content. */
export const MAX_TEXT_BYTES = 1024 * 1024

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ladder',
  GIT_AUTHOR_EMAIL: 'ladder@localhost',
  GIT_COMMITTER_NAME: 'Ladder',
  GIT_COMMITTER_EMAIL: 'ladder@localhost'
}

/**
 * `--no-optional-locks`: reads don't rewrite the index, so they don't clash with the user's or the agent's git.
 * `core.fsmonitor=false`: with a hostile .git/config `core.fsmonitor` is a command git runs on every `status`/`diff`; the
 * automatic reads (header, tree, checkpoint) never launch it. Cost: on huge repos no fsmonitor speedup.
 * Left out of the defense (can't be disabled without breaking legitimate configs): `filter.*.clean`/`process` declared in
 * .git/config and used by .gitattributes, `core.sshCommand` and `credential.helper` (only fetch/push goes through them), `remote.*.uploadpack`
 * with a local remote. Opening an untrusted project in Ladder amounts to trusting its .git/config, as in the terminal.
 */
const BASE_ARGS = ['--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false']

/** Accepted remote name: like usual git names (`origin`, `upstream`, `my-fork`). Never a URL nor anything starting with `-`. */
export function validRemoteName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.includes('..')
}

export async function git(repo: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, ...BASE_ARGS, ...args], {
    env: { ...cleanEnv(), ...env },
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

/** Like `git`, but with `input` on stdin. */
function gitInput(repo: string, args: string[], input: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, ...BASE_ARGS, ...args], { env: { ...cleanEnv(), ...env } })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out.trimEnd()) : reject(new Error(err.trim() || t('git {command} exited with {code}', { command: args[0], code: String(code) })))))
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

/** Sha of the commit `ref` points to, or null. */
export async function resolveCommit(repo: string, ref: string): Promise<string | null> {
  try {
    return (await git(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])) || null
  } catch {
    return null
  }
}

/** Project files: tracked plus untracked non-ignored, at most `limit`. */
export async function listFiles(path: string, limit = 20000): Promise<string[]> {
  const out = await git(path, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  const files = out.split('\0').filter(Boolean)
  return [...new Set(files)].slice(0, limit)
}

/**
 * Untracked files matching the patterns (`--exclude-from` or `--exclude`), under the given rules only: not the standard ignores.
 * `node_modules` (even nested) is excluded with a pathspec and not with `--exclude`: this way git doesn't enter it
 * (on 120k files, 7 ms instead of 95), whereas an `--exclude=node_modules/` pattern would list them all.
 */
export async function matchingUntracked(repo: string, excludeArgs: string[]): Promise<string[]> {
  const out = await git(repo, ['ls-files', '--others', '--ignored', '-z', ...excludeArgs, '--', '.', ':(exclude,glob)**/node_modules/**'])
  return out.split('\0').filter(Boolean)
}

/** Which of `paths` git ignores (standard rules: .gitignore, info/exclude, global). */
export async function ignoredAmong(repo: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  try {
    const out = await gitInput(repo, ['check-ignore', '-z', '--stdin'], paths.join('\0') + '\0')
    return out.split('\0').filter(Boolean)
  } catch {
    // check-ignore exits with 1 if no path is ignored.
    return []
  }
}

/** Untracked, non-ignored files that a checkpoint leaves out (too large, or neither file nor symlink, such as nested repos). */
export async function untrackedLeftOut(repo: string): Promise<string[]> {
  const others = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  const left: string[] = []
  for (const file of others) {
    const s = await lstat(join(repo, file)).catch(() => null)
    if (s && !((s.isFile() && s.size <= MAX_UNTRACKED_BYTES) || s.isSymbolicLink())) left.push(file)
  }
  return left
}

/**
 * Snapshots the working tree and untracked files into a commit on `ref`, without touching the user's index and branch.
 * Starts from a copy of the user's index (4-5 times faster than read-tree). Works without an initial commit too.
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
      // The copy must carry the original's date: git compares file dates with the index's to
      // recheck files modified in the same second (racy git). With a new date it would consider them unchanged.
      const { atime, mtime } = await stat(userIndex)
      await utimes(tmpIndex, atime, mtime)
    } else if (info.hasHead) await git(repo, ['read-tree', 'HEAD'], env)
    // Tracked files: changes and deletions.
    await git(repo, ['add', '-u'], env)
    // Untracked and not ignored, without huge files and without nested repos.
    const others = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'], env)).split('\0').filter(Boolean)
    const small: string[] = []
    for (const file of others) {
      try {
        const s = await lstat(join(repo, file))
        if ((s.isFile() && s.size <= MAX_UNTRACKED_BYTES) || s.isSymbolicLink()) small.push(file)
      } catch {
        // Gone in the meantime.
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

/** Starting commit for the diff of a commit: the parent, or the empty tree for the first commit. */
export async function parentOf(repo: string, sha: string): Promise<string> {
  return (await resolveCommit(repo, `${sha}^`)) ?? EMPTY_TREE
}

/**
 * Files changed between two states, with added and removed lines. Renames detected with -M.
 * `--relative`: if the project is a subfolder of the repository (monorepo), paths and diff stay inside it.
 */
export async function changedFiles(repo: string, from: string, to: string, paths: string[] = []): Promise<FileChange[]> {
  const tail = paths.length ? ['--', ...paths] : []
  const [numstat, nameStatus] = await Promise.all([
    git(repo, ['diff', '--no-ext-diff', '--relative', '--numstat', '-z', '-M', from, to, ...tail]),
    git(repo, ['diff', '--no-ext-diff', '--relative', '--name-status', '-z', '-M', from, to, ...tail])
  ])

  // name-status -z: "M\0path\0" or "R100\0old\0new\0".
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

  // numstat -z: "added\tremoved\tpath\0" or "added\tremoved\t\0old\0new\0".
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

/** Unified diff of a file between two states. */
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

/** Content of `path` in state `rev` (commit or tree), with size limits and binary detection. */
export async function blobAt(repo: string, rev: string, path: string): Promise<Blob> {
  if (rev === EMPTY_TREE) return { text: null, binary: false, tooLarge: false, exists: false }
  let size: number
  try {
    // "./" makes the path relative to the project folder even inside a monorepo.
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

/** Git state of files against HEAD and the index: one letter per file. */
export async function statusMap(repo: string): Promise<Record<string, GitStatusCode>> {
  // The porcelain format uses paths from the repository root: they are brought back to the project folder.
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
 * Brings `paths` back to the state of `rev` by writing the files directly: the user's index, branch and stash stay as they are.
 * A file that doesn't exist in `rev` is deleted.
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
    if (type !== 'blob') continue // submodules: not touched
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

/** Adds lines to .git/info/exclude if missing: excludes personal files without touching .gitignore. */
export async function ensureExcluded(repo: string, patterns: string[]): Promise<void> {
  const common = await git(repo, ['rev-parse', '--git-common-dir'])
  const file = join(isAbsolute(common) ? common : join(repo, common), 'info', 'exclude')
  const current = await readFile(file, 'utf8').catch(() => '')
  const lines = new Set(current.split('\n').map((l) => l.trim()))
  const missing = patterns.filter((p) => !lines.has(p))
  if (missing.length === 0) return
  await mkdir(dirname(file), { recursive: true })
  const prefix = current && !current.endsWith('\n') ? '\n' : ''
  await appendFile(file, `${prefix}${t('# Ladder: personal files and session context')}\n${missing.join('\n')}\n`)
}

/** New worktree on a new branch, starting from `base`. */
export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await git(repo, ['worktree', 'add', '-b', branch, path, base])
}

/** True if `path` is an existing file or folder. */
export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/** Worktree on an already existing branch, local or on origin (git creates the local branch that tracks it). */
export async function addWorktreeForBranch(repo: string, path: string, branch: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await git(repo, ['worktree', 'add', path, branch])
}

/** Removes a worktree only if it is clean: with changes or untracked files git refuses, and that's fine. From the app it goes through removeWorktree in worktrees.ts (cleanup script included). */
export async function gitRemoveWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', path])
}

export async function fetchRef(repo: string, refspec: string): Promise<void> {
  await git(repo, ['fetch', '--quiet', 'origin', refspec])
}

/** Commits of `a` that `b` doesn't have (left) and vice versa. */
export async function aheadBehind(repo: string, head: string, base: string): Promise<{ ahead: number; behind: number } | null> {
  try {
    const [ahead, behind] = (await git(repo, ['rev-list', '--left-right', '--count', `${head}...${base}`])).split(/\s+/).map(Number)
    return { ahead: ahead || 0, behind: behind || 0 }
  } catch {
    return null
  }
}

/** Modified or untracked files, as git status counts them. */
export async function dirtyCount(repo: string): Promise<number> {
  const entries = (await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])).split('\0')
  let count = 0
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    count++
    // Renames and copies carry the source path in the next entry.
    if (entry[0] === 'R' || entry[0] === 'C') i++
  }
  return count
}

/** Commits not published to the upstream; null if the branch has none. */
export async function unpushedCount(repo: string): Promise<number | null> {
  try {
    return Number(await git(repo, ['rev-list', '--count', '@{upstream}..HEAD'])) || 0
  } catch {
    return null
  }
}

// ── State for the header ─────────────────────────────────────────────────────

/** Maximum time of a state read: a repo on a slow network disk must not block the header. */
const GIT_READ_TIMEOUT_MS = 20_000

/**
 * Git read for the state: literal pathspecs, no prompts, login shell PATH, timeout (the process is stopped).
 * Like `git`, but with a time limit; throws if git exits with an error.
 */
export async function gitRead(repo: string, args: string[], timeoutMs = GIT_READ_TIMEOUT_MS): Promise<string> {
  const PATH = await shellPath().catch(() => process.env.PATH)
  const { stdout } = await run('git', ['-C', repo, '--literal-pathspecs', ...BASE_ARGS, ...args], {
    env: { ...cleanEnv(), PATH, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL'
  })
  return stdout
}

/** Upstream commits HEAD doesn't have yet (to download); null if the branch has no upstream. */
export async function behindCount(repo: string): Promise<number | null> {
  try {
    return Number((await gitRead(repo, ['rev-list', '--count', 'HEAD..@{upstream}'])).trim()) || 0
  } catch {
    return null
  }
}

/** Lines of untracked files are counted over at most this many files/bytes: beyond that, the count is a lower bound. */
const MAX_UNTRACKED_FILES = 200
const MAX_UNTRACKED_TOTAL_BYTES = 8 * 1024 * 1024
/** Lines already counted per untracked file, valid until mtime and size change (the tracker rereads continuously during a turn). */
const untrackedLines = new Map<string, { mtimeMs: number; size: number; lines: number | null }>()
const UNTRACKED_CACHE_MAX = 2000

/**
 * Lines added and removed by uncommitted changes: stage and working folder together (diff against HEAD, or against
 * the empty tree if there are no commits). Untracked (non-ignored) files count as entirely added, with lines
 * counted by reading them (text, max 1 MB each and 8 MB in total, binaries excluded): so a new file created by the agent lights up
 * the pill. Tracked binaries add no lines.
 */
export async function diffStats(repo: string): Promise<{ added: number; removed: number }> {
  let added = 0
  let removed = 0
  const base = (await resolveCommit(repo, 'HEAD')) ? 'HEAD' : EMPTY_TREE
  try {
    const out = await gitRead(repo, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-color', base])
    for (const record of out.split('\0')) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(record)
      if (m && m[1] !== '-') {
        added += Number(m[1])
        removed += Number(m[2])
      }
    }
  } catch {
    // Unreadable diff (repo in a strange state): lines stay at zero.
  }
  try {
    const untracked = (await gitRead(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).slice(0, MAX_UNTRACKED_FILES)
    let budget = MAX_UNTRACKED_TOTAL_BYTES
    for (const path of untracked) {
      const absolute = join(repo, path)
      const info = await lstat(absolute).catch(() => null)
      if (!info?.isFile() || info.size > MAX_TEXT_BYTES || info.size > budget) continue
      budget -= info.size
      const cached = untrackedLines.get(absolute)
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        added += cached.lines ?? 0
        continue
      }
      const data = await readFile(absolute).catch(() => null)
      if (!data) continue
      // Binary (or empty): zero lines. This is remembered too, to avoid rereading it.
      const lines = data.includes(0) || data.length === 0 ? 0 : data.toString('utf8').split('\n').length - (data[data.length - 1] === 0x0a ? 1 : 0)
      if (untrackedLines.size >= UNTRACKED_CACHE_MAX) untrackedLines.clear()
      untrackedLines.set(absolute, { mtimeMs: info.mtimeMs, size: info.size, lines })
      added += lines
    }
  } catch {
    // Untracked list unavailable: only tracked files are counted.
  }
  return { added, removed }
}

/** Light state of a folder for the session header (`git.status`); the same function feeds `merge.info` (which passes `withLines` true: it also reports added/removed; `archive` passes false). */
export async function gitStatus(repo: string, isWorktree: boolean, withLines = true): Promise<GitStatus | null> {
  try {
    if ((await gitRead(repo, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return null
  } catch {
    return null
  }
  const branch = (await gitRead(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || null
  // Without an upstream (never published, or upstream no longer among the remote references) `@{upstream}` doesn't resolve.
  const upstream = branch ? (await gitRead(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '')).trim() || null : null
  let ahead = 0
  let behind = 0
  if (upstream) {
    try {
      const [a, b] = (await gitRead(repo, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim().split(/\s+/).map(Number)
      ahead = a || 0
      behind = b || 0
    } catch {
      // Upstream vanished between the two commands: it reads as "unpublished" on the next round.
    }
  }
  const dirty = await gitRead(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).then(countPorcelain, () => 0)
  const { added, removed } = dirty > 0 && withLines ? await diffStats(repo) : { added: 0, removed: 0 }
  return { root: repo, branch, upstream, hasUpstream: upstream !== null, ahead, behind, dirty, added, removed, isWorktree }
}

/** Entries of `git status --porcelain=v1 -z`: one per file, with renames carrying the source in the next entry. */
function countPorcelain(out: string): number {
  const entries = out.split('\0')
  let count = 0
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    count++
    if (entry[0] === 'R' || entry[0] === 'C') i++
  }
  return count
}

/** Conflicting files when merging `base` into `head`, computed with merge-tree: the working folder doesn't change. */
export async function mergeConflicts(repo: string, head: string, base: string): Promise<string[]> {
  try {
    await run('git', ['-C', repo, ...BASE_ARGS, 'merge-tree', '--write-tree', '--name-only', '--no-messages', head, base], { maxBuffer: 16 * 1024 * 1024, env: cleanEnv() })
    return []
  } catch (error) {
    // Code 1: merge with conflicts. The first line is the tree, then the conflicting files.
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

/** Local and origin branches, most recent first. */
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

// ── Commit ───────────────────────────────────────────────────────────────────

/** For each git call of the commit: slow hooks (lint, test) get time, a stuck one doesn't. */
export const GIT_COMMIT_TIMEOUT_MS = 5 * 60_000

/**
 * Outcome of a "raw" git: code and text of stdout+stderr together (hooks write to both). It stops, with
 * the whole process group (hooks included), if it doesn't finish within `timeoutMs`.
 */
async function gitRaw(repo: string, args: string[], input?: string, timeoutMs = GIT_COMMIT_TIMEOUT_MS, literalPathspecs = true): Promise<{ code: number; output: string }> {
  // Hooks (husky, lint-staged) call pnpm, npx, node: in the packaged app they need the login shell PATH.
  const PATH = await shellPath().catch(() => process.env.PATH)
  return new Promise((resolve, reject) => {
    // No forced identity (author from the user's config) and no interactive prompt.
    const child = spawn('git', ['-C', repo, ...(literalPathspecs ? ['--literal-pathspecs'] : []), '-c', 'core.quotePath=false', ...args], {
      env: { ...cleanEnv(), PATH, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
      detached: true
    })
    let output = ''
    let timedOut = false
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 3_000).unref()
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('error', (error) => (clearTimeout(timer), reject(error)))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error(t('git {command} did not finish in {minutes} minutes and was stopped: a hook of the repository may be stuck.', { command: args[0], minutes: String(Math.max(1, Math.round(timeoutMs / 60_000))) })))
      resolve({ code: code ?? 1, output: output.trim() })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/**
 * Git write (switch, stash): hooks included, login shell PATH, never interactive, with a timeout. Returns the output;
 * if git exits with an error it throws with the output (cleaned of colors and credentials), which the caller can translate.
 */
export async function gitWrite(repo: string, args: string[], timeoutMs = GIT_COMMIT_TIMEOUT_MS): Promise<string> {
  // Without `--literal-pathspecs`: with `stash push -u` git passes it to its internal `git clean` and untracked files stay in place. The arguments are ours, never user paths.
  const { code, output } = await gitRaw(repo, args, undefined, timeoutMs, false)
  if (code !== 0) throw new Error(redactUrls(tailOutput(output)) || t('git {command} exited with {code}', { command: args[0], code: String(code) }))
  return output
}

/** Last lines of git's output, without colors, for a readable error (hooks can write a lot). */
export function tailOutput(output: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  return clean.length > 4000 ? `…${clean.slice(-4000)}` : clean
}

/** Strip credentials from URLs (`https://user:token@host`): git and hook output ends up in user-facing messages. */
export function redactUrls(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')
}

/** Readable reason for a failed git command: the cleaned stderr (no colors or credentials) or, if missing, the first line of the error. */
export function gitFailure(error: unknown): string {
  const e = error as { stderr?: unknown; message?: unknown }
  const text = String(e?.stderr ?? '').trim() || String(e?.message ?? '').split('\n')[0]
  return redactUrls(tailOutput(text.trim()))
}

/**
 * Commit in the `repo` folder with the given message, without touching it (verbatim cleanup, no trailer) and without skipping
 * the hooks. If something is staged, that is committed; otherwise `paths` ('all' or a list) is staged
 * first (git add -A, which respects .gitignore). Message from stdin: never interpolated into a shell.
 */
export async function commitChanges(repo: string, subject: string, body: string | undefined, paths: string[] | 'all' | undefined, timeoutMs = GIT_COMMIT_TIMEOUT_MS): Promise<{ hash: string; subject: string }> {
  const title = subject.trim()
  if (!title) throw new Error(t('The commit needs a subject.'))
  if (/[\r\n]/.test(title)) throw new Error(t('The commit subject must be a single line.'))
  if (title.length > MAX_COMMIT_SUBJECT) throw new Error(t('The commit subject is too long ({max} characters at most).', { max: String(MAX_COMMIT_SUBJECT) }))
  const text = body ? body.replace(/^(\s*\n)+/, '').trimEnd() : ''
  if (title.includes('\0') || text.includes('\0')) throw new Error(t('The commit message contains invalid characters.'))
  if (Array.isArray(paths) && paths.some((p) => typeof p !== 'string' || !p || p.includes('\0'))) throw new Error(t('The commit message contains invalid characters.'))

  // Exits 0 = nothing staged, 1 = something staged; any other code (128: not a repo, unreadable index…) is a git error.
  const hasStaged = async (): Promise<boolean> => {
    const check = await gitRaw(repo, ['diff', '--cached', '--quiet'], undefined, timeoutMs)
    if (check.code !== 0 && check.code !== 1) throw new Error(t('Could not read the staged changes: {output}', { output: tailOutput(check.output) || `git exit ${check.code}` }))
    return check.code === 1
  }
  if (!(await hasStaged())) {
    if (paths === 'all' || (Array.isArray(paths) && paths.length > 0)) {
      const add = await gitRaw(repo, ['add', '-A', ...(paths === 'all' ? [] : ['--', ...(paths as string[])])], undefined, timeoutMs)
      if (add.code !== 0) throw new Error(t('Could not stage the changes: {output}', { output: tailOutput(add.output) }))
    }
    if (!(await hasStaged())) throw new Error(t('Nothing to commit.'))
  }

  const message = text ? `${title}\n\n${text}\n` : `${title}\n`
  const commit = await gitRaw(repo, ['commit', '--cleanup=verbatim', '-F', '-'], message, timeoutMs)
  if (commit.code !== 0) throw new Error(t('Commit failed:\n{output}', { output: tailOutput(commit.output) || `git exit ${commit.code}` }))
  const head = await gitRaw(repo, ['rev-parse', '--short', 'HEAD'], undefined, timeoutMs)
  if (head.code !== 0 || !/^[0-9a-f]{4,}$/.test(head.output)) throw new Error(t('The commit was created, but its hash could not be read: {output}', { output: tailOutput(head.output) || `git exit ${head.code}` }))
  const hash = head.output
  return { hash, subject: title }
}
// ── end of commit ────────────────────────────────────────────────────────────
