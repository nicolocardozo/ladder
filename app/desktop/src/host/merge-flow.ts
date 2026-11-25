// Progress of the merge panel: Commit → Publish/Push → Create PR → Merge → Archive. Pure functions, no I/O:
// the host computes them in a single place (merge.info) so the header chip and the panel cannot diverge.
import type { MergeBlock, MergeCheck, NextAction, PrStatus } from '@shared/protocol'

export interface MergeBlockFacts {
  pr: PrStatus | null
  checks: MergeCheck[]
  /** GitHub's `mergeStateStatus`, or null. */
  mergeState: string | null
  /** Files in conflict with the base, computed locally (merge-tree). */
  conflicts: string[]
}

/**
 * Why the PR cannot be merged, in priority order. Empty if there is no open PR.
 * `blocked` (repo rules we cannot explain) is present only if no other block explains it: gh gives the reason.
 */
export function mergeBlocks(f: MergeBlockFacts): MergeBlock[] {
  const pr = f.pr
  if (!pr || (pr.state !== 'open' && pr.state !== 'draft')) return []
  const blocks: MergeBlock[] = []
  if (pr.state === 'draft') blocks.push({ kind: 'draft' })
  if (pr.mergeable === 'conflicts' || f.conflicts.length > 0 || f.mergeState === 'DIRTY') blocks.push({ kind: 'conflicts', count: f.conflicts.length || undefined })
  const failing = f.checks.filter((c) => c.state === 'failing').length
  const pending = f.checks.filter((c) => c.state === 'pending').length
  if (pr.checks === 'failing') blocks.push({ kind: 'ci_failing', count: failing || undefined })
  else if (pr.checks === 'pending') blocks.push({ kind: 'ci_pending', count: pending || undefined })
  if (pr.review === 'changes') blocks.push({ kind: 'changes_requested' })
  else if (pr.review === 'pending') blocks.push({ kind: 'review_required' })
  if (f.mergeState === 'BEHIND') blocks.push({ kind: 'behind' })
  if (f.mergeState === 'BLOCKED' && blocks.length === 0) blocks.push({ kind: 'blocked' })
  return blocks
}

export interface NextActionFacts {
  /** null = detached HEAD. */
  branch: string | null
  isDefaultBranch: boolean
  isWorktree: boolean
  dirty: number
  /** Branch commits relative to the base. */
  ahead: number
  /** Commits not sent to the upstream; null if there is no upstream. */
  unpushed: number | null
  behindUpstream: number
  hasUpstream: boolean
  hasRemote: boolean
  gh: 'ok' | 'missing' | 'unauthenticated' | 'no-remote' | 'error'
  pr: PrStatus | null
  /** If the PR is merged: the local branch is entirely inside the PR (HEAD is the PR's head or one of its ancestors). False = new commits after the merge. */
  prMergedCoversHead: boolean
  blocks: MergeBlock[]
  agentBusy: boolean
}

const go = (kind: NextAction['kind'], blocked = false, reason: NextAction['reason'] = null): NextAction => ({ kind, blocked, reason })
const none = (reason: NonNullable<NextAction['reason']>): NextAction => go('none', true, reason)

/**
 * Truth table, in order (the first matching row wins):
 *  1. detached HEAD                                           → none (detached)
 *  2. PR merged and the branch is entirely inside             → archive; disabled if (worktree) dirty>0 → dirty, unpushed>0 → unpushed, agent working → agent_busy
 *  3. dirty > 0                                               → commit
 *  4. default branch: unpushed>0 → push (as 6); otherwise → none (default_branch)
 *  5. no upstream with commits on the base (ahead>0): remote → publish (disabled if agent working); no remote → none (no_remote)
 *  6. unpushed>0                                              → push; disabled if behindUpstream>0 → behind_upstream, agent working → agent_busy
 *  7. no commits on the base and no open PR                   → none (no_commits)
 *  8. gh not ready                                            → none (github_missing | github_unauthenticated | no_github_remote | github_error)
 *  9. no open PR (missing, closed or merged with new commits) → create_pr (reason pr_closed if the last PR is closed or merged)
 * 10. open or draft PR                                        → merge; disabled if blocks is not empty (reason = the first) or agent working (agent_busy)
 * A branch with no upstream and no commits on the base (ahead=0) has nothing to publish: it falls to row 7.
 */
export function nextAction(f: NextActionFacts): NextAction {
  if (f.branch === null) return none('detached')
  const pr = f.pr
  const openPr = pr && (pr.state === 'open' || pr.state === 'draft') ? pr : null
  if (!f.isDefaultBranch && pr?.state === 'merged' && f.prMergedCoversHead) {
    if (f.isWorktree && f.dirty > 0) return go('archive', true, 'dirty')
    if (f.isWorktree && (f.unpushed ?? 0) > 0) return go('archive', true, 'unpushed')
    return f.agentBusy ? go('archive', true, 'agent_busy') : go('archive')
  }
  if (f.dirty > 0) return go('commit')
  if (f.isDefaultBranch) {
    if ((f.unpushed ?? 0) > 0) return push(f)
    return none('default_branch')
  }
  if (!f.hasUpstream && f.ahead > 0) return f.hasRemote ? go('publish', f.agentBusy, f.agentBusy ? 'agent_busy' : null) : none('no_remote')
  if ((f.unpushed ?? 0) > 0) return push(f)
  if (f.ahead === 0 && !openPr) return none('no_commits')
  if (f.gh !== 'ok') return none(f.gh === 'missing' ? 'github_missing' : f.gh === 'unauthenticated' ? 'github_unauthenticated' : f.gh === 'no-remote' ? 'no_github_remote' : 'github_error')
  if (!openPr) return go('create_pr', false, pr ? 'pr_closed' : null)
  if (f.blocks.length > 0) return go('merge', true, f.blocks[0].kind)
  return f.agentBusy ? go('merge', true, 'agent_busy') : go('merge')
}

function push(f: NextActionFacts): NextAction {
  if (f.behindUpstream > 0) return go('push', true, 'behind_upstream')
  return f.agentBusy ? go('push', true, 'agent_busy') : go('push')
}
