// Avanzamento del pannello merge (LAD-69): Commit → Pubblica/Push → Crea PR → Merge → Archivia. Funzioni pure, senza I/O:
// l'host le calcola in un punto solo (merge.info) e il chip dell'intestazione e il pannello non possono divergere.
import type { MergeBlock, MergeCheck, NextAction, PrStatus } from '@shared/protocol'

export interface MergeBlockFacts {
  pr: PrStatus | null
  checks: MergeCheck[]
  /** `mergeStateStatus` di GitHub, o null. */
  mergeState: string | null
  /** File in conflitto con la base calcolati in locale (merge-tree). */
  conflicts: string[]
}

/**
 * Perché la PR non si può unire, in ordine di priorità. Vuoto se non c'è una PR aperta.
 * `blocked` (regole del repo che non sappiamo spiegare) c'è solo se nessun altro blocco lo spiega: il motivo lo dà gh.
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
  /** null = HEAD staccato. */
  branch: string | null
  isDefaultBranch: boolean
  isWorktree: boolean
  dirty: number
  /** Commit del branch rispetto alla base. */
  ahead: number
  /** Commit non inviati all'upstream; null se non c'è upstream. */
  unpushed: number | null
  behindUpstream: number
  hasUpstream: boolean
  hasRemote: boolean
  gh: 'ok' | 'missing' | 'unauthenticated' | 'no-remote' | 'error'
  pr: PrStatus | null
  /** Se la PR è unita: il branch locale è tutto dentro la PR (HEAD è la testa della PR o un suo antenato). Falso = commit nuovi dopo il merge. */
  prMergedCoversHead: boolean
  blocks: MergeBlock[]
  agentBusy: boolean
}

const go = (kind: NextAction['kind'], blocked = false, reason: NextAction['reason'] = null): NextAction => ({ kind, blocked, reason })
const none = (reason: NonNullable<NextAction['reason']>): NextAction => go('none', true, reason)

/**
 * Tabella di verità, in ordine (vince la prima riga che combacia):
 *  1. HEAD staccato                                           → none (detached)
 *  2. PR unita e il branch è tutto dentro                     → archive; disabilitato se (worktree) dirty>0 → dirty, unpushed>0 → unpushed, agente al lavoro → agent_busy
 *  3. dirty > 0                                               → commit
 *  4. branch predefinito: unpushed>0 → push (come 6); altrimenti → none (default_branch)
 *  5. senza upstream con commit sulla base (ahead>0): remote → publish (disabilitato se agente al lavoro); nessun remote → none (no_remote)
 *  6. unpushed>0                                              → push; disabilitato se behindUpstream>0 → behind_upstream, agente al lavoro → agent_busy
 *  7. nessun commit sulla base e nessuna PR aperta            → none (no_commits)
 *  8. gh non pronto                                           → none (github_missing | github_unauthenticated | no_github_remote | github_error)
 *  9. nessuna PR aperta (assente, chiusa o unita con commit nuovi) → create_pr (reason pr_closed se l'ultima PR è chiusa o unita)
 * 10. PR aperta o bozza                                       → merge; disabilitato se blocks non è vuoto (reason = il primo) o agente al lavoro (agent_busy)
 * Un branch senza upstream e senza commit sulla base (ahead=0) non ha niente da pubblicare: passa alla riga 7.
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
