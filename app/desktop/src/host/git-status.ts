// Git status for the session header: re-read on every change and silent background fetch.
import { spawn } from 'node:child_process'
import type { GitStatus } from '@shared/protocol'
import { cleanEnv, shellPath } from './agents/common'
import { gitRead, gitStatus, validRemoteName } from './git'
import { registerFetch, repoLocked } from './repo-lock'

/** How often to fetch from the upstream (on open and then continuously). */
export const FETCH_INTERVAL_MS = 5 * 60_000
/** After errors the interval doubles on every failure, up to this cap. */
export const FETCH_BACKOFF_MAX_MS = 60 * 60_000
/** A fetch that does not finish within this time is stopped (no network, unresponsive host). */
export const FETCH_TIMEOUT_MS = 60_000
/** If the agent is working in the folder or another fetch is running, retry after this long. */
const FETCH_RETRY_MS = 30_000
/** Periodic re-read of the status: catches changes the watcher does not see (push from a terminal, commit in a worktree). */
const POLL_MS = 60_000
/** Minimum distance between two status reads of the same folder. */
const MIN_GAP_MS = 400
/** Same as above while a session is working in the folder: each read costs ~7 git processes and re-reading new files. */
const BUSY_GAP_MS = 3_000
/** A tracker read is valid for `merge.info` until there has been a change and as long as it is no older than this. */
const FRESH_MS = 5_000

interface Entry {
  count: number
  last: string | null
  running: boolean
  pending: boolean
  lastRunAt: number
  /** Grows on every re-read request (change in the folder): a read counts only if it is from the current version. */
  version: number
  fresh: { status: GitStatus; version: number; at: number } | null
  refreshTimer: NodeJS.Timeout | null
  pollTimer: NodeJS.Timeout
  fetchTimer: NodeJS.Timeout | null
  /** Git folder shared by all worktrees of the same repo: the fetch key. */
  repo: string | null
}

interface RepoFetch {
  failures: number
  nextAt: number
  /** A fetch of this repo is in progress (set synchronously, before any await). */
  running: boolean
  cancel: (() => void) | null
}

export interface GitStatusHooks {
  emit: (status: GitStatus) => void
  isWorktree: (root: string) => boolean
  /** A session is working in this folder (a turn may be running git). */
  busy: (root: string) => boolean
  /** A fetch succeeded: remote branches changed even if the folder's status did not (branch map). */
  fetched?: (root: string) => void
}

export class GitStatusTracker {
  private readonly roots = new Map<string, Entry>()
  private readonly repos = new Map<string, RepoFetch>()
  private stopped = false

  constructor(private readonly hooks: GitStatusHooks) {}

  /** Current status (`git.status` command); also updates the last one sent, so the next event does not repeat it. */
  async read(root: string): Promise<GitStatus | null> {
    const status = await gitStatus(root, this.hooks.isWorktree(root))
    const entry = this.roots.get(root)
    if (entry && status) entry.last = JSON.stringify(status)
    return status
  }

  /** Recent tracker read (no change since, at most 5 s) or, if none, a fresh read: `merge.info` does not redo everything on every `fs.changed`. */
  async recent(root: string): Promise<GitStatus | null> {
    const fresh = this.roots.get(root)?.fresh
    if (fresh && fresh.version === this.roots.get(root)!.version && Date.now() - fresh.at < FRESH_MS) return fresh.status
    return gitStatus(root, this.hooks.isWorktree(root))
  }

  /** Last status read by the tracker for the folder (no new read); null if it is not followed or not yet read. */
  peek(root: string): GitStatus | null {
    return this.roots.get(root)?.fresh?.status ?? null
  }

  /** One more subscriber: the first time it reads right away and schedules the first fetch. */
  track(root: string): void {
    if (this.stopped) return
    const current = this.roots.get(root)
    if (current) {
      current.count++
      return
    }
    const entry: Entry = {
      count: 1,
      last: null,
      running: false,
      pending: false,
      lastRunAt: 0,
      version: 0,
      fresh: null,
      refreshTimer: null,
      pollTimer: setInterval(() => this.refresh(root), POLL_MS),
      fetchTimer: null,
      repo: null
    }
    entry.pollTimer.unref()
    this.roots.set(root, entry)
    this.refresh(root)
    this.scheduleFetch(root, 2_000)
  }

  untrack(root: string): void {
    const entry = this.roots.get(root)
    if (!entry) return
    if (--entry.count > 0) return
    this.drop(root, entry)
  }

  /** Re-reads the status (bursts merge into a single read) and sends it if it changed. */
  refresh(root: string): void {
    const entry = this.roots.get(root)
    if (entry) entry.version++
    if (!entry || entry.refreshTimer || this.stopped) return
    const gap = this.hooks.busy(root) ? BUSY_GAP_MS : MIN_GAP_MS
    const wait = Math.max(0, entry.lastRunAt + gap - Date.now())
    entry.refreshTimer = setTimeout(() => {
      entry.refreshTimer = null
      void this.run(root, entry)
    }, wait)
    entry.refreshTimer.unref()
  }

  shutdown(): void {
    this.stopped = true
    for (const [root, entry] of [...this.roots]) this.drop(root, entry)
    for (const repo of this.repos.values()) repo.cancel?.()
    this.repos.clear()
  }

  private drop(root: string, entry: Entry): void {
    clearInterval(entry.pollTimer)
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
    if (entry.fetchTimer) clearTimeout(entry.fetchTimer)
    this.roots.delete(root)
    // If it was the repo's last folder, a fetch in progress is no longer needed.
    if (entry.repo && ![...this.roots.values()].some((e) => e.repo === entry.repo)) this.repos.get(entry.repo)?.cancel?.()
  }

  private async run(root: string, entry: Entry): Promise<void> {
    if (entry.running) {
      entry.pending = true
      return
    }
    entry.running = true
    const version = entry.version
    try {
      const status = await gitStatus(root, this.hooks.isWorktree(root))
      if (status) entry.fresh = { status, version, at: Date.now() }
      if (status && this.roots.get(root) === entry) {
        const json = JSON.stringify(status)
        if (json !== entry.last) {
          entry.last = json
          this.hooks.emit(status)
        }
      }
    } catch {
      // Read failed (repo in a transient state): retry on the next change.
    } finally {
      entry.running = false
      entry.lastRunAt = Date.now()
      if (entry.pending) {
        entry.pending = false
        this.refresh(root)
      }
    }
  }

  private scheduleFetch(root: string, delay: number): void {
    const entry = this.roots.get(root)
    if (!entry || this.stopped) return
    if (entry.fetchTimer) clearTimeout(entry.fetchTimer)
    entry.fetchTimer = setTimeout(() => {
      entry.fetchTimer = null
      void this.fetchTick(root, entry)
    }, delay)
    entry.fetchTimer.unref()
  }

  private async fetchTick(root: string, entry: Entry): Promise<void> {
    try {
      // Never while a turn is working in the folder (or in another one of the same repo): it might be running git.
      entry.repo ??= await commonDir(root)
      const key = entry.repo
      if (!key) return
      const siblings = [...this.roots].filter(([, e]) => e.repo === key).map(([r]) => r)
      if (siblings.some((r) => this.hooks.busy(r)) || repoLocked(key)) return this.scheduleFetch(root, FETCH_RETRY_MS)
      let repo = this.repos.get(key)
      if (!repo) this.repos.set(key, (repo = { failures: 0, nextAt: 0, running: false, cancel: null }))
      // One fetch at a time per repo; whoever arrives later waits for the deadline set by the one that finished (even after an error).
      if (repo.running) return this.scheduleFetch(root, FETCH_RETRY_MS)
      const wait = repo.nextAt - Date.now()
      if (wait > 0) return this.scheduleFetch(root, Math.min(wait, FETCH_INTERVAL_MS) + 500)
      repo.running = true
      let ok: boolean
      let preempted = false
      let unregister = () => {}
      try {
        const remote = await fetchRemote(root)
        if (!remote) {
          // No upstream or no remote: nothing to fetch; check again, it might get published later.
          repo.nextAt = Date.now() + FETCH_INTERVAL_MS
          return this.scheduleFetch(root, FETCH_INTERVAL_MS)
        }
        // A push, a merge or an archive started while the remote was being read: yield.
        if (repoLocked(key)) return this.scheduleFetch(root, FETCH_RETRY_MS)
        const job = startFetch(root, remote)
        const cancel = () => {
          preempted = true
          job.cancel()
        }
        repo.cancel = job.cancel
        // Whoever takes the repo lock (push, merge, archive) stops this fetch and waits for it; here it does not count as an error.
        unregister = registerFetch(key, { cancel, done: job.done })
        ok = await job.done
      } finally {
        unregister()
        repo.running = false
        repo.cancel = null
      }
      if (this.stopped) return
      if (preempted) return this.scheduleFetch(root, FETCH_RETRY_MS)
      repo.failures = ok ? 0 : repo.failures + 1
      repo.nextAt = Date.now() + (ok ? FETCH_INTERVAL_MS : Math.min(FETCH_INTERVAL_MS * 2 ** repo.failures, FETCH_BACKOFF_MAX_MS))
      for (const r of siblings) this.refresh(r)
      if (ok) this.hooks.fetched?.(root)
      this.scheduleFetch(root, repo.nextAt - Date.now() + 500)
    } catch {
      this.scheduleFetch(root, FETCH_INTERVAL_MS)
    }
  }
}

/** Git folder shared by all worktrees of the repo, absolute; null if it is not a repo. */
async function commonDir(root: string): Promise<string | null> {
  try {
    return (await gitRead(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() || null
  } catch {
    return null
  }
}

/** Remote the current branch's upstream is fetched from; null if there is no upstream or the upstream is a local branch. */
async function fetchRemote(root: string): Promise<string | null> {
  try {
    const ref = (await gitRead(root, ['symbolic-ref', '-q', 'HEAD'])).trim()
    if (!ref) return null
    const remote = (await gitRead(root, ['for-each-ref', '--format=%(upstream:remotename)', ref])).trim()
    // Only real remote names: never a URL or anything git would read as an option.
    return remote && remote !== '.' && validRemoteName(remote) ? remote : null
  } catch {
    return null
  }
}

/**
 * Environment of a git that talks to the network (fetch, push): clean env (without the ANTHROPIC and CLAUDE variables), login shell's PATH,
 * no credential prompts (git's credential helpers keep working), SSH in BatchMode if the user
 * has not already configured one (the ~/.ssh/config configuration applies anyway).
 */
export async function gitNetworkEnv(root: string): Promise<Record<string, string | undefined>> {
  const PATH = await shellPath().catch(() => process.env.PATH)
  const env: Record<string, string | undefined> = { ...cleanEnv(), PATH, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/true', GCM_INTERACTIVE: 'never' }
  // GIT_SSH_COMMAND wins over core.sshCommand: set it only if the user has neither that nor GIT_SSH.
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
    const configured = await gitRead(root, ['config', '--get', 'core.sshCommand']).then((v) => v.trim(), () => '')
    if (!configured) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  }
  return env
}

/**
 * Light, non-interactive `git fetch`: no tags, no prune, no submodules, no background gc. stdin closed,
 * no credential prompts (git's credential helpers keep working), SSH in BatchMode if the user has not
 * already configured one (the ~/.ssh/config configuration applies anyway). Own process group: on timeout everything is stopped.
 */
function startFetch(root: string, remote: string): { done: Promise<boolean>; cancel: () => void } {
  let child: ReturnType<typeof spawn> | null = null
  let cancelled = false
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child?.pid) process.kill(-child.pid, signal)
    } catch {
      child?.kill(signal)
    }
  }
  const cancel = () => {
    cancelled = true
    killGroup('SIGTERM')
    setTimeout(() => killGroup('SIGKILL'), 3_000).unref()
  }
  const done = (async () => {
    const env = await gitNetworkEnv(root)
    if (cancelled) return false
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined
      try {
        child = spawn(
          'git',
          [
            '-C', root, '--no-optional-locks', '--literal-pathspecs', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
            // A hostile .git/config does not open dangerous transports (`ext::` runs commands) nor launch fsmonitor. `protocol.file.allow`
            // stays as it is: local remotes (folders, bare repos in /tmp) are legitimate. Residual risk: `remote.<name>.uploadpack`
            // of a local remote is a command run by the fetch, as in the terminal; `core.sshCommand`
            // and `credential.helper` are not overridden (they would break legitimate configs).
            '-c', 'protocol.ext.allow=never', '-c', 'core.fsmonitor=false',
            'fetch', '--quiet', '--no-tags', '--no-prune', '--no-recurse-submodules', '--', remote
          ],
          { env, detached: true, stdio: 'ignore' }
        )
      } catch {
        return resolve(false)
      }
      timer = setTimeout(cancel, FETCH_TIMEOUT_MS)
      child.on('error', () => (clearTimeout(timer), resolve(false)))
      child.on('close', (code) => (clearTimeout(timer), resolve(code === 0 && !cancelled)))
    })
  })()
  return { done, cancel }
}
