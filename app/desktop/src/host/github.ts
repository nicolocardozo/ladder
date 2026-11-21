// GitHub tramite la CLI gh dell'utente: Ladder non legge né conserva token, gh usa il proprio login.
// LADDER_GH punta a un gh finto per le prove automatiche.
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

/** gh scaricato da Ladder (LAD-11): sta nella cartella dati, dopo quello dell'utente. */
export const downloadedGhPath = () => join(toolDir('gh'), 'gh')

/** Percorso di gh: le app GUI non vedono il PATH della shell, quindi lo chiede alla shell di login; poi quello scaricato da Ladder. */
export function findGh(): Promise<string | null> {
  ghPath ??= (async () => {
    if (process.env.LADDER_GH) return process.env.LADDER_GH
    try {
      const { stdout } = await run(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v gh'], { timeout: 5000, env: cleanEnv() })
      const path = stdout.trim().split('\n').pop() ?? ''
      if (path.startsWith('/')) return path
    } catch {
      // Non è nel PATH dell'utente: si prova quello scaricato.
    }
    return existsSync(downloadedGhPath()) ? downloadedGhPath() : null
  })()
  return ghPath
}

/** Dopo un download, un login o un logout: gh va cercato di nuovo e lo stato di accesso riletto. */
export function resetGh(): void {
  ghPath = null
  authCache.clear()
}

export class GhError extends Error {
  constructor(
    message: string,
    readonly stderr: string
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
      // Niente prompt interattivi né colori: l'output deve restare JSON.
      env: { ...cleanEnv(), GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' }
    })
    return stdout
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '').trim()
    throw new GhError(stderr.split('\n')[0] || (error as Error).message, stderr)
  }
}

/** Il repository ha un remote su GitHub? Senza, gh non ha niente da leggere. */
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
 * Esito di `gh auth status`. Senza rete gh scrive "Failed to log in … The token in keyring is invalid" come per un token
 * rifiutato davvero: in quel caso si chiede a GitHub (gh api rate_limit) e solo un 401 vale come scollegato.
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
  // Un errore di rete non si ricorda: alla prossima richiesta si riprova.
  if (result !== 'error') authCache.set(path, { at: Date.now(), ok: result === 'ok' })
  return result
}

/** Branch predefinito: origin/HEAD se c'è, altrimenti quello di GitHub, altrimenti main o master. */
export async function defaultBranch(cwd: string): Promise<string> {
  try {
    const ref = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    if (ref) return ref.replace(/^origin\//, '')
  } catch {
    // origin/HEAD non impostato: si prova con gh.
  }
  if ((await ghState(cwd)) === 'ok') {
    try {
      const data = JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'defaultBranchRef'], 10000)) as { defaultBranchRef?: { name?: string } }
      if (data.defaultBranchRef?.name) return data.defaultBranchRef.name
    } catch {
      // Si ripiega sui nomi più comuni.
    }
  }
  for (const name of ['main', 'master']) {
    try {
      await git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${name}`])
      return name
    } catch {
      // Prossimo nome.
    }
  }
  return 'main'
}

interface RawCheck {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

interface RawPr {
  number: number
  title: string
  url: string
  state: string
  isDraft?: boolean
  mergeable?: string
  reviewDecision?: string
  baseRefName?: string
  updatedAt?: string
  statusCheckRollup?: RawCheck[] | null
  comments?: { author?: { login?: string }; body?: string; createdAt?: string; url?: string }[]
}

function checkState(check: RawCheck): MergeCheck['state'] {
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

function rollup(checks: MergeCheck[]): PrStatus['checks'] {
  const relevant = checks.filter((c) => c.state !== 'skipped')
  if (relevant.length === 0) return 'none'
  if (relevant.some((c) => c.state === 'failing')) return 'failing'
  if (relevant.some((c) => c.state === 'pending')) return 'pending'
  return 'passing'
}

export interface PrDetails {
  status: PrStatus
  checks: MergeCheck[]
  comments: ReviewComment[]
}

const PR_FIELDS = 'number,title,url,state,isDraft,mergeable,reviewDecision,baseRefName,updatedAt,statusCheckRollup,comments'

/** PR aperta (o l'ultima) del branch. null se il branch non ha PR. */
export async function prForBranch(cwd: string, branch: string): Promise<PrDetails | null> {
  let raw: RawPr
  try {
    raw = JSON.parse(await gh(cwd, ['pr', 'view', branch, '--json', PR_FIELDS])) as RawPr
  } catch (error) {
    if (error instanceof GhError && /no (open )?pull requests? found|could not find/i.test(error.stderr || error.message)) return null
    throw error
  }
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
    updatedAt: raw.updatedAt ? Date.parse(raw.updatedAt) : Date.now()
  }
  const comments: ReviewComment[] = (raw.comments ?? []).map((c) => ({
    author: c.author?.login ?? t('user'),
    path: null,
    line: null,
    body: c.body ?? '',
    url: c.url ?? null,
    at: c.createdAt ? Date.parse(c.createdAt) : 0
  }))
  // Commenti sulle righe del diff: un'altra API, letta con gh api (i segnaposto {owner}/{repo} li risolve gh).
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
    // Senza i commenti sulle righe il pannello mostra comunque PR e CI.
  }
  comments.sort((a, b) => a.at - b.at)
  return { status, checks, comments }
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
