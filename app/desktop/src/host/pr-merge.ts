// Merge della PR con `gh pr merge` (LAD-69): solo su azione esplicita dell'utente, con metodo scelto, dopo i controlli.
// Mai --admin, mai --auto, mai --delete-branch (la cancellazione del branch remoto è un passo a parte, richiesto).
import { t } from '@shared/i18n'
import type { MergeBlock, PrMergeMethod, PrMergeResult } from '@shared/protocol'
import { gitRead, redactUrls, tailOutput } from './git'
import { validBranchName, withRepoLock } from './git-push'
import { GhError, gh, ghState, prFromRaw, type RawPr } from './github'
import { mergeBlocks } from './merge-flow'

const METHODS: readonly PrMergeMethod[] = ['merge', 'squash', 'rebase']
const MERGE_TIMEOUT_MS = 90_000
const VIEW_FIELDS = 'number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt'

export function validMergeRequest(number: unknown, method: unknown): { number: number; method: PrMergeMethod } {
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) throw new Error(t('The pull request number is not valid.'))
  if (typeof method !== 'string' || !(METHODS as readonly string[]).includes(method)) throw new Error(t('The merge method must be merge, squash or rebase.'))
  return { number, method: method as PrMergeMethod }
}

/** Testo per un blocco: perché la PR non si può unire. */
export function blockText(block: MergeBlock, base: string): string {
  switch (block.kind) {
    case 'draft':
      return t('The pull request is a draft: mark it ready for review on GitHub first.')
    case 'conflicts':
      return t('The pull request has conflicts with {base}: resolve them first.', { base })
    case 'ci_failing':
      return t('CI is failing: fix the failing checks before merging.')
    case 'ci_pending':
      return t('CI is still running: wait for the checks to finish.')
    case 'changes_requested':
      return t('A reviewer requested changes.')
    case 'review_required':
      return t('The pull request needs a review before it can be merged.')
    case 'behind':
      return t('The branch is behind {base}: update it first.', { base })
    case 'blocked':
      return t('The repository rules block this merge.')
  }
}

/**
 * Controlla e poi unisce la PR `number`, che deve essere quella del `branch` della sessione. Se un controllo fallisce `merge` non
 * viene chiamato. Le regole del repo che gh fa rispettare (blocchi che non sappiamo spiegare) tornano con il motivo di gh.
 */
export async function mergePullRequest(
  root: string,
  branch: string,
  request: { number: number; method: PrMergeMethod; deleteBranch?: boolean; expectedHeadOid?: string },
  busy: () => boolean
): Promise<PrMergeResult> {
  const { number, method } = validMergeRequest(request.number, request.method)
  const state = await ghState(root)
  if (state === 'missing' || state === 'unauthenticated') throw new Error(t('GitHub is not connected: connect it in Settings → Subscriptions (Connect GitHub).'))
  if (state === 'no-remote') throw new Error(t('The repository has no GitHub remote.'))
  if (state === 'error') throw new Error(t('Could not check the GitHub login. Check your connection.'))
  return withRepoLock(root, async () => {
    const working = () => new Error(t('The agent is working in this folder: wait for it to finish before merging.'))
    if (busy()) throw working()
    let raw: RawPr
    try {
      raw = JSON.parse(await gh(root, ['pr', 'view', String(number), '--json', VIEW_FIELDS])) as RawPr
    } catch (error) {
      if (error instanceof GhError && /could not resolve|no pull requests? found|not found/i.test(error.stderr || error.message)) throw new Error(t('Pull request #{number} does not exist.', { number }))
      throw error
    }
    if (raw.number !== number) throw new Error(t('Pull request #{number} does not exist.', { number }))
    if (raw.state === 'MERGED') throw new Error(t('Pull request #{number} is already merged.', { number }))
    if (raw.state === 'CLOSED') throw new Error(t('Pull request #{number} is closed: reopen it on GitHub or open a new one.', { number }))
    if (raw.headRefName !== branch) throw new Error(t('Pull request #{number} belongs to branch “{pr}”, not to “{branch}”.', { number, pr: raw.headRefName ?? '?', branch }))
    // Una PR da fork con lo stesso nome di branch (es. patch-1) non è quella di questa sessione: mai unita da qui.
    if (raw.isCrossRepository) throw new Error(t('Pull request #{number} comes from a fork: Ladder only merges pull requests from this repository.', { number }))
    const headOid = raw.headRefOid ?? ''
    if (!/^[0-9a-f]{40,64}$/.test(headOid)) throw new Error(t('GitHub did not report the head commit of pull request #{number}: try again.', { number }))
    // L'oid che l'utente ha visto nel dialogo: se la PR è cambiata nel frattempo si riapre la conferma.
    if (request.expectedHeadOid !== undefined && request.expectedHeadOid !== headOid) throw new Error(t('The pull request changed after you opened the confirmation: reopen it.'))
    // La testa della PR deve essere il HEAD locale, l'upstream o lo stesso branch su un remote (ultimo pubblicato): altrimenti è un'altra PR, o il branch è indietro.
    const sha = (rev: string) => gitRead(root, ['rev-parse', '--verify', '-q', rev]).then((out) => out.trim(), () => '')
    const published = validBranchName(branch) ? (await gitRead(root, ['for-each-ref', '--format=%(objectname)', `refs/remotes/*/${branch}`]).catch(() => '')).split('\n').map((l) => l.trim()) : []
    const local = [await sha('HEAD'), await sha('@{upstream}'), ...published]
    if (!local.includes(headOid)) throw new Error(t('The pull request head is not the commit of this branch (local or published): update the branch from the remote and reopen the confirmation.'))
    const { status, checks } = prFromRaw(raw)
    // `blocked` (regole del repo) lo spiega gh: qui si ferma solo ciò che sappiamo dire noi.
    const blocks = mergeBlocks({ pr: status, checks, mergeState: raw.mergeStateStatus ?? null, conflicts: [] }).filter((b) => b.kind !== 'blocked')
    if (blocks.length > 0) throw new Error(blocks.map((b) => blockText(b, status.base)).join('\n'))

    // --match-head-commit: se la PR riceve un commit tra il controllo e il merge, gh si rifiuta.
    const args = ['pr', 'merge', String(number), `--${method}`, '--match-head-commit', headOid]
    // L'agente può essersi messo al lavoro durante le chiamate a gh.
    if (busy()) throw working()
    try {
      await gh(root, args, MERGE_TIMEOUT_MS)
    } catch (error) {
      // gh fermato per il tempo scaduto: GitHub potrebbe aver unito comunque. Non è un rifiuto.
      if (error instanceof GhError && error.timedOut) throw new Error(t('No answer from GitHub: check the status of the pull request before trying again (it may have been merged).'))
      const reason = redactUrls(tailOutput(error instanceof GhError ? error.stderr || error.message : (error as Error).message))
      throw new Error(t('GitHub did not merge the pull request:\n{reason}', { reason }))
    }

    let branchDeleted = false
    let branchDeleteError: string | null = null
    if (request.deleteBranch === true) {
      if (raw.isCrossRepository) branchDeleteError = t('The pull request comes from a fork: its branch was not deleted.')
      else if (!validBranchName(branch)) branchDeleteError = t('The branch name is not one Ladder deletes.')
      else {
        try {
          // Solo il branch remoto, con l'API dei riferimenti: gh pr merge --delete-branch toccherebbe anche il checkout locale.
          const ref = branch.split('/').map(encodeURIComponent).join('/')
          await gh(root, ['api', '--method', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${ref}`])
          branchDeleted = true
        } catch (error) {
          branchDeleteError = t('The pull request was merged, but its remote branch was not deleted: {reason}', { reason: error instanceof GhError ? error.stderr || error.message : (error as Error).message })
        }
      }
    }
    return { number, method, pr: null, branchDeleted, branchDeleteError }
  })
}
