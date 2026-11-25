// Map of the sessions' branches relative to the main branch. Git reads only, on the main checkout, on references
// (never on worktree folders: if the folder is gone the branch can still be read), no writes and no gh calls
// (not even for the main branch: the host resolves it from origin/HEAD, main or master).
// Cost: one `for-each-ref` per round reads sha, date and title of all branches; the real counts (merge-base, ahead/behind, lines) are
// recomputed only when a pair changes (branch sha, main branch sha) and stay cached.
import type { AgentId, BranchMap, BranchMapEntry, BranchMapProblem, PrStatus, RunState } from '@shared/protocol'
import { t } from '@shared/i18n'
import { currentBranch } from './branches'
import { dirtyCount, gitRead } from './git'

/** Maximum worktree rows in the map (active or merged): the most recent sessions. */
export const MAX_BRANCH_MAP_ENTRIES = 50
/** Maximum sessions of the main checkout (they cost no git reads): needed to say "you are on main" when the checkout is on the main branch. */
const MAX_BASE_ENTRIES = 20
/** Maximum worktree rows examined to fill the map: an archived session's merged state is known only by reading git. */
const MAX_EXAMINED = 200
/** An archived session older than this doesn't even enter the calculation (a branch merged more than 7 days ago is hidden by the UI). */
const MAX_ARCHIVED_AGE_MS = 30 * 24 * 3_600_000
/** Maximum time for each git command. */
const READ_TIMEOUT_MS = 10_000
/** Maximum concurrent git commands (cold, with many branches). */
const CONCURRENCY = 6
/** Bursts of changes (fs, turns, fetch) merge into a single calculation. */
const DEBOUNCE_MS = 600
/** Periodic reread for projects with a subscribed window: picks up pushes, fetches and commits that no event signaled. */
const POLL_MS = 60_000
const CACHE_MAX = 600
const SHA = /^[0-9a-f]{40,64}$/

/** Data of a session that the host knows without git. */
export interface BranchMapRow {
  sessionId: string
  title: string
  agent: AgentId
  run: RunState
  archived: boolean
  activityAt: number
  prState: PrStatus['state'] | null
  isWorktree: boolean
  worktreeMissing: boolean
  /** Working folder: key for the uncommitted changes read by the tracker. */
  cwd: string
  branch: string | null
  /** Commit the worktree was born from (sha), if known. */
  start: string | null
  /** Known merged PR (not from a previous session with the same branch name): date (mergedAt) and PR head. */
  prMerged: { at: number; oid: string | null } | null
  /** Merge recorded when the session was archived (survives restart); `at` null if the date is unknown. */
  saved: { via: 'git' | 'pr'; at: number | null } | null
}

export interface BranchMapSource {
  /** The project's main checkout, where all reads run. */
  root: string
  /** Main branch (same as the Merge panel); null if the project isn't git or the folder is missing. */
  base: string | null
  rows: BranchMapRow[]
}

export interface BranchMapHooks {
  /** Raw project data; throws if the project doesn't exist. */
  source: (projectId: string) => Promise<BranchMapSource>
  emit: (projectId: string, map: BranchMap) => void
  /** Files with uncommitted changes in a folder, if the git tracker has already read it. */
  dirty: (cwd: string) => number | null
}

interface Facts {
  problem: BranchMapProblem | null
  mergeBase: string | null
  mergeBaseAt: number | null
  ahead: number | null
  behind: number | null
  merged: 'git' | 'pr' | null
  mergedAt: number | null
  added: number | null
  removed: number | null
}

interface RefInfo {
  sha: string
  at: number
  subject: string
}

interface Watched {
  count: number
  last: string | null
  timer: NodeJS.Timeout | null
  poll: NodeJS.Timeout
  running: boolean
  again: boolean
}

export class BranchMapService {
  private readonly facts = new Map<string, Promise<Facts>>()
  /** One calculation at a time per project: whoever arrives during it shares it. */
  private readonly inflight = new Map<string, Promise<BranchMap>>()
  private readonly watched = new Map<string, Watched>()
  /** Uncommitted files of the main checkout when the tracker isn't watching it: reread only if the folder changed or on the poll, not on every calculation. */
  private readonly mainDirty = new Map<string, { value: number | null; stale: boolean }>()
  private stopped = false

  constructor(private readonly hooks: BranchMapHooks) {}

  /** Current map (`project.branchMap` command); also updates the last sent one, so the next event doesn't repeat it. */
  async read(projectId: string): Promise<BranchMap> {
    const map = await this.build(projectId)
    const entry = this.watched.get(projectId)
    if (entry) entry.last = JSON.stringify(map)
    return map
  }

  isWatched(projectId: string): boolean {
    return this.watched.has(projectId)
  }

  watch(projectId: string): void {
    if (this.stopped) return
    const current = this.watched.get(projectId)
    if (current) {
      current.count++
      return
    }
    const poll = setInterval(() => this.touch(projectId, true), POLL_MS)
    poll.unref()
    this.watched.set(projectId, { count: 1, last: null, timer: null, poll, running: false, again: false })
    this.touch(projectId)
  }

  unwatch(projectId: string): void {
    const entry = this.watched.get(projectId)
    if (!entry || --entry.count > 0) return
    this.forget(projectId)
  }

  /** Project removed, or last subscriber gone: no more timers. */
  forget(projectId: string): void {
    const entry = this.watched.get(projectId)
    if (!entry) return
    clearInterval(entry.poll)
    if (entry.timer) clearTimeout(entry.timer)
    this.watched.delete(projectId)
    this.mainDirty.delete(projectId)
  }

  /** Something that may change the map happened: if there is a subscriber it is reread (in bursts, only once) and sent if it changed. */
  touch(projectId: string, mainChanged = false): void {
    // The mark stays even without subscribers: the next calculation rereads the uncommitted files.
    if (mainChanged) {
      const cached = this.mainDirty.get(projectId)
      if (cached) cached.stale = true
    }
    const entry = this.watched.get(projectId)
    if (!entry || this.stopped) return
    if (entry.running) {
      entry.again = true
      return
    }
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.tick(projectId, entry)
    }, DEBOUNCE_MS)
    entry.timer.unref()
  }

  shutdown(): void {
    this.stopped = true
    for (const id of [...this.watched.keys()]) this.forget(id)
    this.facts.clear()
  }

  private async tick(projectId: string, entry: Watched): Promise<void> {
    entry.running = true
    try {
      // A calculation already in progress (for example from a `read`) started before this change: wait and redo it, instead of
      // reusing its result and missing the change until the 60 s round.
      await this.inflight.get(projectId)?.catch(() => undefined)
      const map = await this.build(projectId)
      if (this.stopped || this.watched.get(projectId) !== entry) return
      const json = JSON.stringify(map)
      if (json !== entry.last) {
        entry.last = json
        this.hooks.emit(projectId, map)
      }
    } catch {
      // Project gone or repo in a transient state: retry at the next change.
    } finally {
      entry.running = false
      if (entry.again) {
        entry.again = false
        this.touch(projectId)
      }
    }
  }

  private build(projectId: string): Promise<BranchMap> {
    let run = this.inflight.get(projectId)
    if (!run) {
      run = this.compute(projectId).finally(() => this.inflight.delete(projectId))
      this.inflight.set(projectId, run)
    }
    return run
  }

  private async compute(projectId: string): Promise<BranchMap> {
    // If the project no longer exists it throws: it is not a map to show.
    const source = await this.hooks.source(projectId)
    const empty: BranchMap = { projectId, base: null, baseAt: null, baseSha: null, entries: [], hidden: 0 }
    if (!source.root || !source.base || !validRefName(source.base)) return empty
    try {
      return await this.mapOf(projectId, source as BranchMapSource & { base: string })
    } catch {
      // A failure in the calculation doesn't leave the UI on "Reading…" forever: empty map with the error.
      return { ...empty, error: t('Could not read the branches') }
    }
  }

  private async mapOf(projectId: string, source: BranchMapSource & { base: string }): Promise<BranchMap> {
    const now = Date.now()
    const recent = source.rows.filter((r) => !(r.archived && now - r.activityAt > MAX_ARCHIVED_AGE_MS)).sort((a, b) => b.activityAt - a.activityAt)
    // The limit applies only to what the UI shows: the worktrees. Sessions on the main checkout don't consume it
    // (few are needed, for "you are on main"); those on another branch without a worktree are neither drawn nor sent.
    const worktrees = recent.filter((r) => r.isWorktree)
    // The main checkout's branch is read from git, not from the sessions (their `branch` is the one seen at the last snapshot, and without
    // sessions there is nothing to read): if it isn't the main branch it appears as a row of its own, otherwise the "you are on main" sessions apply.
    const head = await currentBranch(source.root)
    const inMain = recent.filter((r) => !r.isWorktree)
    const onBase = (head === null ? inMain.filter((r) => r.branch === source.base) : head === source.base ? inMain.map((r) => ({ ...r, branch: head })) : []).slice(0, MAX_BASE_ENTRIES)
    const mainRow = head !== null && head !== source.base && validRefName(head) ? mainCheckoutRow(projectId, source, head, inMain) : null
    const baseRef = await readBaseRef(source.root, source.base)

    // An archived session that isn't merged is abandoned work: it has no curve. Whether it is merged is known only by reading git
    // (or from the recorded merge): it is examined in blocks, in date order, until the valid rows are enough.
    const kept: BranchMapEntry[] = []
    let next = 0
    while (next < worktrees.length && kept.length < MAX_BRANCH_MAP_ENTRIES && next < MAX_EXAMINED) {
      const part = worktrees.slice(next, next + MAX_BRANCH_MAP_ENTRIES)
      next += part.length
      for (const e of await this.entriesFor(source, baseRef, part)) if (!e.archived || e.merged) kept.push(e)
    }
    const shown = kept.slice(0, MAX_BRANCH_MAP_ENTRIES)
    // Those that would have room but aren't there: the remainder and the unexamined rows that certainly count (an underestimate).
    const hidden = kept.length - shown.length + worktrees.slice(next).filter((r) => !r.archived || r.prMerged || r.saved).length
    const rest = await this.entriesFor(source, baseRef, mainRow ? [...onBase, mainRow] : onBase)
    if (mainRow) {
      const entry = rest[rest.length - 1]
      entry.mainCheckout = true
      // The tracker knows only the folders a window is watching: without open sessions on the main checkout the uncommitted files are counted here.
      if (entry.dirty === null) {
        const cached = this.mainDirty.get(projectId)
        if (cached && !cached.stale) entry.dirty = cached.value
        else {
          const value = await dirtyCount(source.root).catch(() => null)
          this.mainDirty.set(projectId, { value, stale: false })
          entry.dirty = value
        }
      }
      // Without sessions the row has no activity of its own: the branch's last commit counts.
      if (!inMain.some((r) => !r.archived)) entry.activityAt = entry.lastCommit?.at ?? entry.activityAt
    }
    const entries = [...shown, ...rest].sort((a, b) => b.activityAt - a.activityAt)
    return { projectId, base: source.base, baseAt: baseRef && baseRef.at > 0 ? baseRef.at : null, baseSha: baseRef?.sha ?? null, entries, hidden }
  }

  /** The map rows for these sessions (with the git facts of the branches). */
  private async entriesFor(source: BranchMapSource & { base: string }, baseRef: RefInfo | null, rows: BranchMapRow[]): Promise<BranchMapEntry[]> {
    if (rows.length === 0) return []
    // One process per round: sha, date and title of the last commit of each relevant branch (and of origin/<branch>, for fast-forward merges).
    const branches = [...new Set(rows.map((r) => r.branch).filter((b): b is string => !!b && b !== source.base && validRefName(b)))]
    const refs = branches.length > 0 ? await readRefs(source.root, source.base, branches) : new Map<string, RefInfo>()

    const entries: BranchMapEntry[] = []
    const jobs: { index: number; row: BranchMapRow; head: RefInfo; remote: RefInfo | null }[] = []
    for (const row of rows) {
      const entry = baseEntry(row)
      const head = row.branch && validRefName(row.branch) ? (refs.get(`refs/heads/${row.branch}`) ?? null) : null
      entry.dirty = row.worktreeMissing ? null : this.hooks.dirty(row.cwd)
      if (!row.branch) entry.problem = 'detached'
      else if (row.branch === source.base) entry.isBase = true
      else if (!head) entry.problem = 'branch_missing'
      else if (!baseRef) entry.problem = 'no_base'
      else {
        entry.lastCommit = { subject: head.subject, at: head.at }
        jobs.push({ index: entries.length, row, head, remote: refs.get(`refs/remotes/origin/${row.branch}`) ?? null })
      }
      entries.push(entry)
    }
    await pool(jobs, CONCURRENCY, async ({ index, row, head, remote }) => {
      const key = [source.root, head.sha, remote?.sha ?? '', baseRef!.sha, row.start ?? '', row.prMerged?.oid ?? '', row.prMerged?.at ?? ''].join('\0')
      let facts = this.facts.get(key)
      if (!facts) {
        if (this.facts.size >= CACHE_MAX) for (const k of [...this.facts.keys()].slice(0, CACHE_MAX / 2)) this.facts.delete(k)
        facts = factsFor(source.root, head, remote, baseRef!.sha, row)
        this.facts.set(key, facts)
        facts.catch(() => this.facts.delete(key))
      }
      Object.assign(entries[index], await facts.catch((): Partial<Facts> => ({})))
    })
    // Archived as merged and git doesn't confirm it (squash after a restart, PR no longer cached): the recorded merge applies.
    rows.forEach((row, i) => {
      const entry = entries[i]
      if (!row.archived || !row.saved || entry.merged) return
      entry.merged = row.saved.via
      entry.mergedAt = row.saved.at ?? entry.lastCommit?.at ?? row.activityAt
    })
    return entries
  }
}

/**
 * Data of the main checkout's row on `head` (a branch that isn't the main branch). The session is the most recent non-archived one of the
 * main checkout (the row opens on that); without sessions it has a synthetic id and doesn't open. The state is the most urgent among the non-archived ones.
 */
function mainCheckoutRow(projectId: string, source: BranchMapSource, head: string, inMain: BranchMapRow[]): BranchMapRow {
  const live = inMain.filter((r) => !r.archived)
  const latest = live[0] ?? null
  const run: RunState = live.some((r) => r.run === 'waiting') ? 'waiting' : live.some((r) => r.run === 'running' || r.run === 'starting') ? 'running' : (latest?.run ?? 'idle')
  return {
    sessionId: latest?.sessionId ?? `main-checkout:${projectId}`,
    title: latest?.title ?? head,
    agent: latest?.agent ?? 'claude-code',
    run,
    archived: false,
    activityAt: latest?.activityAt ?? 0,
    // PR and recorded merge belong to a session's branch: they don't apply to the branch read now.
    prState: null,
    isWorktree: false,
    worktreeMissing: false,
    cwd: source.root,
    branch: head,
    start: null,
    prMerged: null,
    saved: null
  }
}

function baseEntry(row: BranchMapRow): BranchMapEntry {
  return {
    sessionId: row.sessionId,
    title: row.title,
    agent: row.agent,
    run: row.run,
    archived: row.archived,
    activityAt: row.activityAt,
    prState: row.prState,
    isWorktree: row.isWorktree,
    worktreeMissing: row.worktreeMissing,
    branch: row.branch,
    isBase: false,
    problem: null,
    mergeBase: null,
    mergeBaseAt: null,
    ahead: null,
    behind: null,
    merged: null,
    mergedAt: null,
    lastCommit: null,
    added: null,
    removed: null,
    dirty: null
  }
}

/** Branch name usable in a reference: no control characters or wildcards (git forbids them), never an option. */
function validRefName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith('-') && !/[\u0000-\u001f\u007f\s*?[\\~^:]/.test(name)
}

/** Main branch for this round: origin/<base> if present, otherwise the local one. */
async function readBaseRef(root: string, base: string): Promise<RefInfo | null> {
  const refs = await readRefs(root, base, [])
  return refs.get(`refs/remotes/origin/${base}`) ?? refs.get(`refs/heads/${base}`) ?? null
}

/** Sha, date (ms) and title of the last commit of the requested references. */
async function readRefs(root: string, base: string, branches: string[]): Promise<Map<string, RefInfo>> {
  const patterns = [
    ...new Set([`refs/heads/${base}`, `refs/remotes/origin/${base}`, ...branches.flatMap((b) => [`refs/heads/${b}`, `refs/remotes/origin/${b}`])])
  ]
  const out = new Map<string, RefInfo>()
  let text: string
  try {
    text = await gitRead(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(subject)', ...patterns], READ_TIMEOUT_MS)
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const [name, sha, at, subject] = line.split('\0')
    // The pattern `refs/heads/foo` also matches `refs/heads/foo/bar`: keep only what was requested.
    if (!name || !SHA.test(sha ?? '') || !patterns.includes(name)) continue
    out.set(name, { sha, at: (Number(at) || 0) * 1000, subject: (subject ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) })
  }
  return out
}

async function factsFor(root: string, head: RefInfo, remote: RefInfo | null, baseSha: string, row: BranchMapRow): Promise<Facts> {
  const none: Facts = { problem: null, mergeBase: null, mergeBaseAt: null, ahead: null, behind: null, merged: null, mergedAt: null, added: null, removed: null }
  const read = (args: string[]) => gitRead(root, args, READ_TIMEOUT_MS)
  const mergeBase = (await read(['merge-base', baseSha, head.sha]).catch(() => '')).trim()
  // Unrelated histories (or unreadable merge-base): no curve with a starting point.
  if (!SHA.test(mergeBase)) return { ...none, problem: 'no_merge_base' }
  const [counts, mergeBaseAt, shortstat] = await Promise.all([
    read(['rev-list', '--left-right', '--count', `${head.sha}...${baseSha}`]).catch(() => ''),
    read(['log', '-1', '--format=%ct', mergeBase]).catch(() => ''),
    read(['diff', '--shortstat', '--no-ext-diff', '--no-textconv', '--no-renames', mergeBase, head.sha]).catch(() => null)
  ])
  const [a, b] = counts.trim().split(/\s+/).map(Number)
  const ahead = Number.isFinite(a) ? a : null
  const behind = Number.isFinite(b) ? b : null
  const facts: Facts = {
    ...none,
    mergeBase,
    mergeBaseAt: (Number(mergeBaseAt.trim()) || 0) * 1000 || null,
    ahead,
    behind,
    added: shortstat === null ? null : Number(/(\d+) insertion/.exec(shortstat)?.[1] ?? 0),
    removed: shortstat === null ? null : Number(/(\d+) deletion/.exec(shortstat)?.[1] ?? 0)
  }
  // Merged with a known PR (squash and rebase included): only if the branch has no commits after the PR head.
  if (row.prMerged && (await coveredByPr(root, head.sha, row.prMerged.oid))) {
    return { ...facts, merged: 'pr', mergedAt: row.prMerged.at }
  }
  // Merged in git: needs proof that the branch had commits of its own (see `gitMergedAt`), ahead 0 is not enough.
  if (ahead === 0) {
    const at = await gitMergedAt(root, head, remote, baseSha, row.start)
    if (at !== null) return { ...facts, merged: 'git', mergedAt: at }
  }
  return facts
}

/**
 * Is the branch entirely in the main branch (ahead 0): was it merged, or just "advanced" along main (a fast-forward pull or a
 * `reset --hard origin/main` of a branch that never had commits of its own, which in the graph are identical to a fast-forward merge)?
 * It is declared merged only with proof, otherwise null (a missed "merged" is better than a false one). Proofs:
 *  1. merge commit on the main branch that has HEAD as a NON-first parent (merge --no-ff, GitHub's "Create a merge commit"): the merge date;
 *  2. fast-forward: HEAD differs from the birth commit and its branch on origin (published after birth: a descendant of `start`)
 *     is inside the main branch. A branch never published (or with the remote already pruned) and merged by fast-forward stays null.
 * A `reset` that throws away its own commits leaves no proof: null. Rebase-and-merge rewrites the commits (ahead > 0): only the PR covers it.
 */
async function gitMergedAt(root: string, head: RefInfo, remote: RefInfo | null, baseSha: string, start: string | null): Promise<number | null> {
  if (start && start === head.sha) return null
  const mergeAt = await mergeCommitAt(root, head.sha, baseSha)
  if (mergeAt !== null) return mergeAt
  if (!start || !SHA.test(start) || !remote || remote.sha === start) return null
  if ((await isAncestor(root, start, remote.sha)) && (await isAncestor(root, remote.sha, baseSha))) return head.at
  return null
}

/** Is `a` equal to `b` or one of its ancestors? true/false; null if unknown (missing object, timeout). */
async function isAncestor(root: string, a: string, b: string): Promise<boolean | null> {
  try {
    await gitRead(root, ['merge-base', '--is-ancestor', a, b], READ_TIMEOUT_MS)
    return true
  } catch (error) {
    // Exit 1 = not an ancestor; any other error (missing object, timeout) = unknown.
    return (error as { code?: unknown }).code === 1 ? false : null
  }
}

/** Is HEAD the merged PR's head or one of its ancestors? If it can't be said (object not fetched, timeout) no: when in doubt, not merged. Without a known head yes, as for `merge.info`. */
async function coveredByPr(root: string, head: string, oid: string | null): Promise<boolean> {
  if (!oid || !SHA.test(oid)) return true
  return (await isAncestor(root, head, oid)) === true
}

/** Date of the merge commit that brought `head` into the main branch (it has it among its parents, not as the first); null if there is none (fast-forward, rebase) or it can't be read. */
async function mergeCommitAt(root: string, head: string, baseSha: string): Promise<number | null> {
  try {
    const out = await gitRead(root, ['log', '--ancestry-path', '--merges', '--format=%P %ct', `${head}..${baseSha}`], READ_TIMEOUT_MS)
    let at: number | null = null
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/)
      const time = Number(parts.pop())
      // The first parent is the main branch: if HEAD is there, main merely included a commit that was already its own.
      if (parts.indexOf(head) < 1 || !time) continue
      at = at === null ? time : Math.min(at, time)
    }
    return at === null ? null : at * 1000
  } catch {
    return null
  }
}

/** Runs `fn` on all items, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
