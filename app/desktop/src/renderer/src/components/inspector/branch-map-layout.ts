// Branches tab: row selection, state in words and grouping. Pure functions, no React.
import type { BranchMapEntry, SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { sessionState } from '@/lib/session-state'

/** State shown for a branch: color, shape and label come from here. */
export type MapKind = 'working' | 'waiting' | 'error' | 'merged' | 'idle' | 'archived'

/** Merged branches older than 7 days disappear from the map. */
export const MERGED_VISIBLE_MS = 7 * 24 * 60 * 60_000
/** From this gap on, "behind" main is highlighted. */
export const FAR_BEHIND = 10
/** Merged branches shown before "Show N more". */
export const MERGED_SHOWN = 1

/** Same rules as the sidebar (`sessionState`): running, waiting for you, error, stopped. "Merged" comes from git, not from the session. */
export function kindOf(entry: BranchMapEntry, session: SessionSummary | undefined): MapKind {
  if (entry.merged) return 'merged'
  if (entry.archived) return 'archived'
  // The main checkout row summarizes all of its sessions (the host picks the most urgent state): the most recent one alone doesn't count.
  if (session && !entry.mainCheckout) {
    const state = sessionState(session)
    if (state === 'waiting') return 'waiting'
    if (state === 'error') return 'error'
    if (state === 'running' || state === 'agents-running') return 'working'
    return 'idle'
  }
  if (entry.run === 'waiting') return 'waiting'
  if (entry.run === 'error') return 'error'
  if (entry.run === 'running' || entry.run === 'starting') return 'working'
  return 'idle'
}

export function kindWord(kind: MapKind): string {
  switch (kind) {
    case 'working':
      return t('working')
    case 'waiting':
      return t('waiting for you')
    case 'error':
      return t('error')
    case 'merged':
      return t('merged')
    case 'archived':
      return t('archived')
    default:
      return t('idle')
  }
}

export function problemText(entry: BranchMapEntry): string | null {
  switch (entry.problem) {
    case 'detached':
      return t('Detached HEAD')
    case 'branch_missing':
      return t('Branch not found')
    case 'no_base':
      return t('Main branch not found')
    case 'no_merge_base':
      return t('No shared history with main')
    default:
      return null
  }
}

/** A session without a real session behind it: the main checkout row when no session is working there (it can't be opened). */
export const hasNoSession = (e: BranchMapEntry): boolean => e.sessionId.startsWith('main-checkout:')

/**
 * Rows of the full map: the worktrees and, if it is on a branch other than the main one, the main checkout (a single row). Sessions
 * on the main branch are not rows. No unmerged archived ones, no merged ones older than 7 days (the main checkout stays:
 * it is where you are working now). Most recent first.
 */
export function visibleEntries(entries: BranchMapEntry[], now: number): BranchMapEntry[] {
  return entries
    .filter((e) => (e.isWorktree || e.mainCheckout) && !e.isBase)
    .filter((e) => !(e.archived && !e.merged))
    .filter((e) => e.mainCheckout || !(e.merged && now - (e.mergedAt ?? e.activityAt) > MERGED_VISIBLE_MS))
    .sort((a, b) => b.activityAt - a.activityAt)
}

export type GroupId = 'working' | 'ready' | 'merged' | 'other'

export interface Row {
  entry: BranchMapEntry
  kind: MapKind
  group: GroupId
}

export interface Group {
  id: GroupId
  rows: Row[]
}

/** Natural group of a row: working (or waiting, or in error), ready to merge (stopped with commits ahead), merged, other. */
export function groupOf(entry: BranchMapEntry, kind: MapKind): GroupId {
  if (kind === 'working' || kind === 'waiting' || kind === 'error') return 'working'
  if (kind === 'merged') return 'merged'
  if (entry.problem === null && (entry.ahead ?? 0) > 0) return 'ready'
  return 'other'
}

/** Rows in groups, in the order Working, Ready to merge, Merged, others; empty groups are omitted. */
export function groupRows(entries: BranchMapEntry[], kindFor: (e: BranchMapEntry) => MapKind): Group[] {
  const order: GroupId[] = ['working', 'ready', 'merged', 'other']
  const rows: Row[] = entries.map((entry) => {
    const kind = kindFor(entry)
    return { entry, kind, group: groupOf(entry, kind) }
  })
  return order.map((id) => ({ id, rows: rows.filter((r) => r.group === id) })).filter((g) => g.rows.length > 0)
}
