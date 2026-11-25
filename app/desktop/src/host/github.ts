// GitHub through the user's gh CLI: Ladder neither reads nor stores tokens, gh uses its own login.
// LADDER_GH points to a fake gh for automated tests.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { t } from '@shared/i18n'
import type { IssueItem, MergeCheck, PrStatus, ReviewComment } from '@shared/protocol'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cleanEnv } from './agents/common'
import { toolDir } from './downloads'
import { git } from './git'

const run = promisify(execFile)

let ghPath: Promise<string | null> | null = null

/** gh downloaded by Ladder: lives in the data folder, after the user's. */
export const downloadedGhPath = () => join(toolDir('gh'), 'gh')

/** Path of gh: GUI apps do not see the shell's PATH, so it asks the login shell; then the one downloaded by Ladder. */
export function findGh(): Promise<string | null> {
  ghPath ??= (async () => {
    if (process.env.LADDER_GH) return process.env.LADDER_GH
    try {
      const { stdout } = await run(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v gh'], { timeout: 5000, env: cleanEnv() })
      const path = stdout.trim().split('\n').pop() ?? ''
      if (path.startsWith('/')) return path
    } catch {
      // Not in the user's PATH: try the downloaded one.
    }
    return existsSync(downloadedGhPath()) ? downloadedGhPath() : null
  })()
  return ghPath
}

/** After a download, a login or a logout: gh must be looked up again and the login state re-read. */
export function resetGh(): void {
  ghPath = null
  authCache.clear()
}

export class GhError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    /** gh was stopped on timeout: the operation may still have succeeded on the other side. */
    readonly timedOut = false
  ) {
    super(message)
  }
}

export async function gh(cwd: string, args: string[], timeout = 20000): Promise<string> {
  const path = await findGh()
  if (!path) throw new GhError(t('gh is not installed'), '')
  try {
    const { stdout } = await run(path, args, {
      cwd,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      // No interactive prompts or colors: the output must stay JSON.
      env: { ...cleanEnv(), GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' }
    })
    return stdout
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '').trim()
    throw new GhError(stderr.split('\n')[0] || (error as Error).message, stderr, (error as { killed?: boolean }).killed === true)
  }
}

/** Does the repository have a remote on GitHub? Without one, gh has nothing to read. */
export async function hasGithubRemote(cwd: string): Promise<boolean> {
  try {
    return /github\.com[:/]/.test(await git(cwd, ['remote', '-v']))
  } catch {
    return false
  }
}

const authCache = new Map<string, { at: number; ok: boolean }>()

export type GhState = 'ok' | 'missing' | 'unauthenticated' | 'no-remote' | 'error'

/**
 * Outcome of `gh auth status`. Without a network gh writes "Failed to log in … The token in keyring is invalid" as for a token
 * that was really rejected: in that case GitHub is asked (gh api rate_limit) and only a 401 counts as logged out.
 */
export async function ghAuthCheck(path: string, env: Record<string, string | undefined>, cwd?: string): Promise<'ok' | 'unauthenticated' | 'error'> {
  const read = async (args: string[]): Promise<{ ok: boolean; text: string }> => {
    try {
      const { stdout, stderr } = await run(path, args, { cwd, env, timeout: 10000, maxBuffer: 1024 * 1024 })
      return { ok: true, text: `${stdout}\n${stderr}` }
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string }
      return { ok: false, text: `${e.stdout ?? ''}\n${e.stderr ?? ''}` }
    }
  }
  const auth = await read(['auth', 'status', '--hostname', 'github.com'])
  if (auth.ok) return 'ok'
  if (/not logged into any|no longer valid/i.test(auth.text)) return 'unauthenticated'
  if (!/Failed to log in/i.test(auth.text)) return 'error'
  const probe = await read(['api', 'rate_limit'])
  if (probe.ok) return 'error'
  return /Bad credentials|HTTP 401/i.test(probe.text) ? 'unauthenticated' : 'error'
}

export async function ghState(cwd: string): Promise<GhState> {
  if (!(await findGh())) return 'missing'
  if (!(await hasGithubRemote(cwd))) return 'no-remote'
  const path = (await findGh())!
  const cached = authCache.get(path)
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.ok ? 'ok' : 'unauthenticated'
  const result = await ghAuthCheck(path, { ...cleanEnv(), GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' }, cwd)
  // A network error is not remembered: retry on the next request.
  if (result !== 'error') authCache.set(path, { at: Date.now(), ok: result === 'ok' })
  return result
}

/** Default branch: origin/HEAD if present, otherwise GitHub's (only with `network`), otherwise main or master. */
export async function defaultBranch(cwd: string, network = true): Promise<string> {
  try {
    const ref = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    if (ref) return ref.replace(/^origin\//, '')
  } catch {
    // origin/HEAD not set: try gh.
  }
  if (network && (await ghState(cwd)) === 'ok') {
    try {
      const data = JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'defaultBranchRef'], 10000)) as { defaultBranchRef?: { name?: string } }
      if (data.defaultBranchRef?.name) return data.defaultBranchRef.name
    } catch {
      // Fall back to the most common names.
    }
  }
  for (const name of ['main', 'master']) {
    try {
      await git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${name}`])
      return name
    } catch {
      // Next name.
    }
  }
  return 'main'
}

export interface RawCheck {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

export interface RawPr {
  number: number
  title: string
  url: string
  state: string
  isDraft?: boolean
  mergeable?: string
  reviewDecision?: string
  mergeStateStatus?: string
  headRefOid?: string
  headRefName?: string
  isCrossRepository?: boolean
  baseRefName?: string
  updatedAt?: string
  mergedAt?: string | null
  statusCheckRollup?: RawCheck[] | null
  comments?: { author?: { login?: string }; body?: string; createdAt?: string; url?: string }[]
}

export function checkState(check: RawCheck): MergeCheck['state'] {
  if (check.__typename === 'StatusContext' || (check.state && !check.status)) {
    const state = (check.state ?? '').toUpperCase()
    if (state === 'SUCCESS') return 'passing'
    if (state === 'FAILURE' || state === 'ERROR') return 'failing'
    return 'pending'
  }
  if ((check.status ?? '').toUpperCase() !== 'COMPLETED') return 'pending'
  const conclusion = (check.conclusion ?? '').toUpperCase()
  if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL') return 'passing'
  if (conclusion === 'SKIPPED') return 'skipped'
  return 'failing'
}

export function rollup(checks: MergeCheck[]): PrStatus['checks'] {
  const relevant = checks.filter((c) => c.state !== 'skipped')
  if (relevant.length === 0) return 'none'
  if (relevant.some((c) => c.state === 'failing')) return 'failing'
  if (relevant.some((c) => c.state === 'pending')) return 'pending'
  return 'passing'
}

export interface PrDetails {
  status: PrStatus
  /** GitHub's `mergeStateStatus`, and the PR's head commit. */
  mergeState: string | null
  headOid: string | null
  checks: MergeCheck[]
  comments: ReviewComment[]
}

const PR_FIELDS = 'number,title,url,state,isDraft,mergeable,mergeStateStatus,headRefOid,reviewDecision,baseRefName,updatedAt,mergedAt,statusCheckRollup,comments'

/** State and checks of a PR from the JSON of `gh pr view` (also used by the pre-merge check). */
export function prFromRaw(raw: RawPr): { status: PrStatus; checks: MergeCheck[] } {
  const checks: MergeCheck[] = (raw.statusCheckRollup ?? []).map((c) => ({
    name: c.name ?? c.context ?? t('check'),
    state: checkState(c),
    url: c.detailsUrl ?? c.targetUrl ?? null
  }))
  const state: PrStatus['state'] = raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : raw.isDraft ? 'draft' : 'open'
  const review = raw.reviewDecision === 'APPROVED' ? 'approved' : raw.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : raw.reviewDecision === 'REVIEW_REQUIRED' ? 'pending' : null
  const status: PrStatus = {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state,
    checks: rollup(checks),
    mergeable: raw.mergeable === 'CONFLICTING' ? 'conflicts' : raw.mergeable === 'MERGEABLE' ? 'clean' : 'unknown',
    review,
    base: raw.baseRefName ?? 'main',
    updatedAt: raw.updatedAt ? Date.parse(raw.updatedAt) : Date.now(),
    // GitHub sends null (or the date 0001-01-01) if it is not merged.
    mergedAt: state === 'merged' && raw.mergedAt ? Date.parse(raw.mergedAt) || null : null
  }
  return { status, checks }
}

/** Open PR (or the latest) of the branch. null if the branch has no PR. */
export async function prForBranch(cwd: string, branch: string): Promise<PrDetails | null> {
  let raw: RawPr
  try {
    raw = JSON.parse(await gh(cwd, ['pr', 'view', branch, '--json', PR_FIELDS])) as RawPr
  } catch (error) {
    if (error instanceof GhError && /no (open )?pull requests? found|could not find/i.test(error.stderr || error.message)) return null
    throw error
  }
  const { status, checks } = prFromRaw(raw)
  const comments: ReviewComment[] = (raw.comments ?? []).map((c) => ({
    author: c.author?.login ?? t('user'),
    path: null,
    line: null,
    body: c.body ?? '',
    url: c.url ?? null,
    at: c.createdAt ? Date.parse(c.createdAt) : 0
  }))
  // Comments on diff lines: a different API, read with gh api (gh resolves the {owner}/{repo} placeholders).
  try {
    const inline = JSON.parse(await gh(cwd, ['api', `repos/{owner}/{repo}/pulls/${raw.number}/comments?per_page=100`])) as {
      user?: { login?: string }
      path?: string
      line?: number | null
      original_line?: number | null
      body?: string
      html_url?: string
      created_at?: string
    }[]
    for (const c of inline) {
      comments.push({
        author: c.user?.login ?? t('user'),
        path: c.path ?? null,
        line: c.line ?? c.original_line ?? null,
        body: c.body ?? '',
        url: c.html_url ?? null,
        at: c.created_at ? Date.parse(c.created_at) : 0
      })
    }
  } catch {
    // Without line comments the panel still shows the PR and CI.
  }
  comments.sort((a, b) => a.at - b.at)
  return { status, mergeState: raw.mergeStateStatus ?? null, headOid: raw.headRefOid ?? null, checks, comments }
}

export async function listGithubIssues(cwd: string): Promise<IssueItem[]> {
  const raw = JSON.parse(
    await gh(cwd, ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,body,url,updatedAt,state'])
  ) as { number: number; title: string; body?: string; url: string; updatedAt?: string; state?: string }[]
  return raw.map((i) => ({
    source: 'github-issue',
    ref: `#${i.number}`,
    title: i.title,
    body: i.body?.trim() || null,
    url: i.url,
    branch: null,
    state: i.state === 'OPEN' ? t('open') : i.state === 'CLOSED' ? t('closed') : (i.state ?? null),
    updatedAt: i.updatedAt ? Date.parse(i.updatedAt) : null
  }))
}

export async function listGithubPrs(cwd: string): Promise<IssueItem[]> {
  const raw = JSON.parse(
    await gh(cwd, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,body,url,updatedAt,headRefName,isDraft'])
  ) as { number: number; title: string; body?: string; url: string; updatedAt?: string; headRefName?: string; isDraft?: boolean }[]
  return raw.map((p) => ({
    source: 'github-pr',
    ref: `#${p.number}`,
    title: p.title,
    body: p.body?.trim() || null,
    url: p.url,
    branch: p.headRefName ?? null,
    state: p.isDraft ? t('draft') : t('open'),
    updatedAt: p.updatedAt ? Date.parse(p.updatedAt) : null
  }))
}
