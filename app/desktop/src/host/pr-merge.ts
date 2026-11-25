// PR merge with `gh pr merge`: only on explicit user action, with the chosen method, after the checks.
// Never --admin, never --auto, never --delete-branch (deleting the remote branch is a separate, requested step).
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

/** Text for a block: why the PR cannot be merged. */
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
 * Checks and then merges PR `number`, which must be the one for the session's `branch`. If a check fails `merge` is not
 * called. Repo rules that gh enforces (blocks we cannot explain) come back with gh's reason.
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
    // A PR from a fork with the same branch name (e.g. patch-1) is not this session's: never merged from here.
    if (raw.isCrossRepository) throw new Error(t('Pull request #{number} comes from a fork: Ladder only merges pull requests from this repository.', { number }))
    const headOid = raw.headRefOid ?? ''
    if (!/^[0-9a-f]{40,64}$/.test(headOid)) throw new Error(t('GitHub did not report the head commit of pull request #{number}: try again.', { number }))
    // The oid the user saw in the dialog: if the PR changed in the meantime the confirmation reopens.
    if (request.expectedHeadOid !== undefined && request.expectedHeadOid !== headOid) throw new Error(t('The pull request changed after you opened the confirmation: reopen it.'))
    // The PR's head must be the local HEAD, the upstream or the same branch on a remote (last published): otherwise it is another PR, or the branch is behind.
    const sha = (rev: string) => gitRead(root, ['rev-parse', '--verify', '-q', rev]).then((out) => out.trim(), () => '')
    const published = validBranchName(branch) ? (await gitRead(root, ['for-each-ref', '--format=%(objectname)', `refs/remotes/*/${branch}`]).catch(() => '')).split('\n').map((l) => l.trim()) : []
    const local = [await sha('HEAD'), await sha('@{upstream}'), ...published]
    if (!local.includes(headOid)) throw new Error(t('The pull request head is not the commit of this branch (local or published): update the branch from the remote and reopen the confirmation.'))
    const { status, checks } = prFromRaw(raw)
    // `blocked` (repo rules) is explained by gh: here we stop only what we can describe ourselves.
    const blocks = mergeBlocks({ pr: status, checks, mergeState: raw.mergeStateStatus ?? null, conflicts: [] }).filter((b) => b.kind !== 'blocked')
    if (blocks.length > 0) throw new Error(blocks.map((b) => blockText(b, status.base)).join('\n'))

    // --match-head-commit: if the PR receives a commit between the check and the merge, gh refuses.
    const args = ['pr', 'merge', String(number), `--${method}`, '--match-head-commit', headOid]
    // The agent may have started working during the gh calls.
    if (busy()) throw working()
    try {
      await gh(root, args, MERGE_TIMEOUT_MS)
    } catch (error) {
      // gh stopped on timeout: GitHub may have merged anyway. It is not a refusal.
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
          // Only the remote branch, with the refs API: gh pr merge --delete-branch would also touch the local checkout.
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
