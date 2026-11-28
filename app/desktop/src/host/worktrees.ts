// Session worktrees and per-folder ports.
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { cp, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { t } from '@shared/i18n'
import type { Project, WorktreeFiles, WorktreeInfo } from '@shared/protocol'
import { validBranchName } from '@shared/branch-name'
import { DEFAULT_BRANCH_PREFIX } from '@shared/worktree-prefs'
import type { Db } from './db'
import { cleanEnv, shellPath } from './agents/common'
import { addWorktree, addWorktreeForBranch, fetchRef, gitFailure, gitRemoveWorktree, ignoredAmong, matchingUntracked, resolveCommit } from './git'
import { insideRoot } from './files'
import { loadProjectSettings } from './project-settings'

/** The folder chosen in preferences, otherwise ~/Developer/.ladder/worktrees if ~/Developer exists, otherwise ~/.ladder/worktrees. LADDER_WORKTREES wins over everything, for tests. */
export function worktreesRoot(custom?: string | null): string {
  if (process.env.LADDER_WORKTREES) return process.env.LADDER_WORKTREES
  if (custom) return custom
  const developer = join(homedir(), 'Developer')
  return existsSync(developer) ? join(developer, '.ladder', 'worktrees') : join(homedir(), '.ladder', 'worktrees')
}

export function slugify(text: string): string {
  const base = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-')
  return `${base || t('session')}-${randomBytes(2).toString('hex')}`
}

export interface WorktreeBranch {
  name: string
  /** True: the branch already exists (locally, on origin or as a PR) and is checked out. False: new branch from HEAD. */
  existing: boolean
  pr?: number
}

/** Worktree preferences (AppPrefs.worktreesDir and branchPrefix). */
export interface WorktreeOptions {
  dir?: string | null
  branchPrefix?: string
  /** Local branch a new-branch worktree starts from; absent = the current commit of the main checkout. If it doesn't exist: error. */
  startFrom?: string
  /** Exact commit the worktree starts from with a new branch (takes precedence over `startFrom`): for example the real HEAD of another working folder. */
  startCommit?: string
  /** The user chose the new branch name: if it already exists (created in the meantime) it is an error, not silently checked out. */
  strictName?: boolean
}

const INCLUDE_FILE = '.worktreeinclude'
const DEFAULT_INCLUDE = ['.env*']

/**
 * The ignored files to copy into a new worktree: those listed by `.worktreeinclude` (.gitignore syntax)
 * and ignored by git; without the file, `.env*`. Git's own engine matches the patterns, so `!`, `**` and folders
 * work as in .gitignore. `node_modules` is never entered.
 */
export async function worktreeIncludeFiles(root: string): Promise<WorktreeFiles> {
  const file = join(root, INCLUDE_FILE)
  const raw = existsSync(file) ? await readFile(file, 'utf8').catch(() => null) : null
  const patterns = raw === null ? DEFAULT_INCLUDE : raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const source = raw === null ? 'default' : 'file'
  if (patterns.length === 0) return { source, patterns, files: [] }
  const candidates = await matchingUntracked(root, raw === null ? ['--exclude=.env*'] : [`--exclude-from=${file}`]).catch(() => [])
  const files = (await ignoredAmong(root, candidates.filter((p) => !p.split('/').includes('node_modules')))).sort()
  return { source, patterns, files }
}

/**
 * Creates a worktree and copies untracked files: those in `copy` (explicit paths) and those from `.worktreeinclude`.
 * Without `wanted` the branch is `<prefix><slug>` (default `ladder/`) from the current commit;
 * with an existing branch (a PR, a chosen branch) the worktree checks it out, after fetching it from origin.
 * Copying never overwrites; symlinks stay symlinks and are skipped if they point outside the project.
 */
export async function createWorktree(
  project: Project,
  title: string,
  copy: string[],
  wanted?: WorktreeBranch | null,
  options: WorktreeOptions = {}
): Promise<{ info: WorktreeInfo; copied: string[]; missing: string[] }> {
  const start = options.startFrom && !wanted?.existing ? options.startFrom : null
  // The chosen starting point is a local branch: a valid name, never an option or a revision (`main~3`, `HEAD^`).
  if (start && !validBranchName(start)) throw new Error(t('The branch “{branch}” does not exist in this project.', { branch: start }))
  const exact = options.startCommit && !wanted?.existing ? await resolveCommit(project.path, options.startCommit) : null
  const head = exact ?? (await resolveCommit(project.path, start ? `refs/heads/${start}` : 'HEAD'))
  if (start && !head && !exact) throw new Error(t('The branch “{branch}” does not exist in this project.', { branch: start }))
  if (!head) throw new Error(t('The project has no commits yet: a worktree starts from a commit.'))
  const prefix = options.branchPrefix ?? DEFAULT_BRANCH_PREFIX
  const slug = slugify((wanted?.name.startsWith(prefix) && prefix ? wanted.name.slice(prefix.length) : wanted?.name.replace(/^ladder\//, '')) ?? title)
  const path = join(worktreesRoot(options.dir), project.name, slug)
  let branch = wanted?.name ?? `${prefix}${slug}`
  // A "new" branch that already exists (a second session on the same issue) is checked out instead of recreated.
  const existing = wanted?.existing || (wanted ? Boolean(await resolveCommit(project.path, `refs/heads/${wanted.name}`)) : false)
  if (options.strictName && wanted && !wanted.existing && existing) throw new Error(t('A branch named “{name}” already exists.', { name: wanted.name }))
  if (wanted && existing) {
    // The branch updated from origin; if the PR comes from a fork, its pull/N/head ref into a local branch.
    await fetchRef(project.path, wanted.name).catch(() => undefined)
    try {
      await addWorktreeForBranch(project.path, path, wanted.name)
    } catch (error) {
      if (!wanted.pr) throw error
      branch = `${prefix}pr-${wanted.pr}`
      await fetchRef(project.path, `pull/${wanted.pr}/head:${branch}`)
      await addWorktreeForBranch(project.path, path, branch)
    }
  } else {
    await addWorktree(project.path, path, branch, head)
  }
  const base = (await resolveCommit(path, 'HEAD')) ?? head
  const copied: string[] = []
  const missing: string[] = []
  const copyOne = async (rel: string): Promise<boolean> => {
    try {
      const from = insideRoot(project.path, rel)
      if (!(await lstat(from).then(() => true, () => false))) return false
      const to = insideRoot(path, rel)
      // No escaping the roots: source and destination folders (even via symlink) and a source that doesn't point outside.
      const [rootReal, wtReal] = await Promise.all([realpath(project.path), realpath(path)])
      const under = (child: string, parent: string) => child === parent || child.startsWith(parent + sep)
      if (!under(await realpath(dirname(from)), rootReal)) return false
      // A symlink is also copied only if its target is inside the project (one pointing outside, or broken, is skipped).
      if (!under(await realpath(from), rootReal)) return false
      await mkdir(dirname(to), { recursive: true })
      if (!under(await realpath(dirname(to)), wtReal)) return false
      await cp(from, to, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true })
      return true
    } catch {
      return false
    }
  }
  for (const rel of copy) (await copyOne(rel)) ? copied.push(rel) : missing.push(rel)
  // Ignored files: an error on one doesn't stop the others and doesn't count as "missing" (the file was there, it just couldn't be copied).
  const include = await worktreeIncludeFiles(project.path).catch(() => null)
  for (const rel of include?.files ?? []) if (!copied.includes(rel) && (await copyOne(rel))) copied.push(rel)
  return { info: { path, branch, base }, copied, missing }
}

/** How long the cleanup script can run before it is stopped and the removal proceeds anyway. */
export const CLEANUP_TIMEOUT_MS = 60_000

export interface CleanupResult {
  /** Exit code; null if it timed out or was killed by a signal. */
  code: number | null
  timedOut: boolean
  /** Coda dell'output (stdout e stderr insieme). */
  output: string
}

/**
 * Runs the cleanup script (`[worktree] archive`) in the worktree folder, in this process and not in a
 * session terminal: it waits for the end (or the timeout) and captures the output. Never throws.
 */
export async function runCleanupScript(cwd: string, script: string, port: number | null, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<CleanupResult> {
  const env: Record<string, string | undefined> = { ...cleanEnv(), PATH: await shellPath().catch(() => process.env.PATH) }
  for (const key of Object.keys(env)) if (/^(ELECTRON_|LADDER_)/.test(key) || key === 'NODE_OPTIONS') delete env[key]
  if (port !== null) env.LADDER_PORT = String(port)
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    let done = false
    // Its own process group: on timeout, whatever the script started is stopped too.
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', script], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4000)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      // A background process can keep the pipes open: they are closed, the output already read stays.
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({ code, timedOut, output: output.trim() })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      finish(null)
    }, timeoutMs)
    child.on('error', (error) => {
      output += error.message
      finish(null)
    })
    // It finishes when the script exits, not when the pipes close; a short wait lets the last output arrive.
    child.on('exit', (code) => {
      const wait = setTimeout(() => finish(code), 200)
      child.once('close', () => {
        clearTimeout(wait)
        finish(code)
      })
    })
  })
}

/**
 * The only way Ladder removes a worktree: first the services are stopped, then the cleanup script (if any), then `git worktree remove`.
 * If the script fails or times out it proceeds anyway; the caller gets the outcome to leave a note.
 * Git refuses if there are changes or untracked files: `removed` is false and the worktree stays.
 */
export async function removeWorktree(
  project: Project,
  path: string,
  options: { port?: number | null; skipCleanup?: boolean; stopServices?: () => Promise<void> } = {}
): Promise<{ removed: boolean; cleanup: CleanupResult | null; /** Why git didn't remove it (cleaned stderr); null if it was removed or the folder was already gone. */ error: string | null }> {
  if (!existsSync(path)) return { removed: false, cleanup: null, error: null }
  // The worktree's services are stopped first: the cleanup script, for example `docker compose down`, finds them already off and the ports free.
  await options.stopServices?.().catch(() => undefined)
  const script = options.skipCleanup ? null : (await loadProjectSettings(project.path)).worktree.archive
  const cleanup = script ? await runCleanupScript(path, script, options.port ?? null) : null
  let error: string | null = null
  const removed = await gitRemoveWorktree(project.path, path).then(
    () => true,
    (failure) => {
      error = gitFailure(failure)
      return false
    }
  )
  return { removed, cleanup, error }
}

const PORT_BASE = 4100
const PORT_BLOCK = 100

/**
 * A block of ports per working folder: LADDER_PORT is the first. The main checkout has 4100,
 * each worktree the next free block, so two dev servers run together.
 */
export class Ports {
  constructor(private readonly db: Db) {}

  private load(): Record<string, number> {
    const row = this.db.prepare(`select value from kv where key = 'ports'`).get() as { value: string } | undefined
    return row ? (JSON.parse(row.value) as Record<string, number>) : {}
  }

  /** Frees the slot of a removed working folder: the block becomes available for a new worktree. */
  release(cwd: string): void {
    const slots = this.load()
    if (slots[cwd] === undefined) return
    delete slots[cwd]
    this.db.prepare(`insert into kv (key, value) values ('ports', ?) on conflict(key) do update set value = excluded.value`).run(JSON.stringify(slots))
  }

  /**
   * Like allocate for a new worktree, but skips slots whose base port is taken (probe bind): setup, shell and [[run]]
   * get the base without further checks. An already assigned slot stays.
   */
  async reserve(cwd: string): Promise<number> {
    if (this.load()[cwd] !== undefined) return this.allocate(cwd)
    for (let slot = 0; slot < 400; slot++) {
      if (Object.values(this.load()).includes(slot) || !(await portIsFree(PORT_BASE + slot * PORT_BLOCK))) continue
      const slots = this.load()
      // The wait may have given the slot to someone else: check again and write right away, with no further await.
      if (Object.values(slots).includes(slot)) continue
      slots[cwd] = slot
      this.db.prepare(`insert into kv (key, value) values ('ports', ?) on conflict(key) do update set value = excluded.value`).run(JSON.stringify(slots))
      return PORT_BASE + slot * PORT_BLOCK
    }
    return this.allocate(cwd)
  }

  /** The port block of a folder if it has one, without assigning a new one. */
  peek(cwd: string): number | null {
    const slot = this.load()[cwd]
    return slot === undefined ? null : PORT_BASE + slot * PORT_BLOCK
  }

  allocate(cwd: string): number {
    const slots = this.load()
    if (slots[cwd] === undefined) {
      const used = new Set(Object.values(slots))
      let slot = 0
      while (used.has(slot)) slot++
      slots[cwd] = slot
      this.db
        .prepare(`insert into kv (key, value) values ('ports', ?) on conflict(key) do update set value = excluded.value`)
        .run(JSON.stringify(slots))
    }
    return PORT_BASE + slots[cwd] * PORT_BLOCK
  }
}

/** Tries to open the port on `host`: false if it is taken. An address the computer doesn't have (no IPv6) doesn't count as taken. */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT'))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/** True if nobody listens on the port, neither on IPv4 and IPv6 loopback nor on all interfaces: a dev server can bind to any of the three. */
export async function portIsFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1', '0.0.0.0']) if (!(await canBind(port, host))) return false
  return true
}

/**
 * The first free port among the `count` starting at `base` that are not in `taken`, or null. It always starts from `base`:
 * under the same conditions a worktree gets the same port on every start, and blocks of different worktrees don't overlap.
 */
export async function freePort(base: number, count: number, taken: ReadonlySet<number>): Promise<number | null> {
  for (let port = base; port < base + count && port <= 65535; port++) if (!taken.has(port) && (await portIsFree(port))) return port
  return null
}
