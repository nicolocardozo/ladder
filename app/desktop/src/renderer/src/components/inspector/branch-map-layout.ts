// Scheda Branches: scelta delle righe, stato a parole e raggruppamento. Funzioni pure, nessun React.
import type { BranchMapEntry, SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { sessionState } from '@/lib/session-state'

/** Stato mostrato per un branch: colore, forma ed etichetta vengono da qui. */
export type MapKind = 'working' | 'waiting' | 'error' | 'merged' | 'idle' | 'archived'

/** Gli uniti da più di 7 giorni spariscono dalla mappa. */
export const MERGED_VISIBLE_MS = 7 * 24 * 60 * 60_000
/** Da questo scarto in poi "indietro" rispetto a main si evidenzia. */
export const FAR_BEHIND = 10
/** Uniti mostrati prima di "Show N more". */
export const MERGED_SHOWN = 1

/** Stesse regole della sidebar (`sessionState`): in esecuzione, ti aspetta, errore, ferma. L'unito viene dal git, non dalla sessione. */
export function kindOf(entry: BranchMapEntry, session: SessionSummary | undefined): MapKind {
  if (entry.merged) return 'merged'
  if (entry.archived) return 'archived'
  // La riga del checkout principale riassume tutte le sue sessioni (l'host sceglie lo stato più urgente): non vale quello della sola più recente.
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

/** Sessione senza una sessione vera dietro: la riga del checkout principale quando nessuna sessione ci lavora (non si apre). */
export const hasNoSession = (e: BranchMapEntry): boolean => e.sessionId.startsWith('main-checkout:')

/**
 * Righe della mappa intera: i worktree e, se è su un branch diverso dal ramo principale, il checkout principale (una riga sola). Le
 * sessioni sul ramo principale non sono righe. Niente archiviati non uniti, niente uniti da più di 7 giorni (il checkout principale resta:
 * è dove lavori adesso). Le più recenti prima.
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

/** Gruppo naturale di una riga: al lavoro (o in attesa, o in errore), pronta all'unione (ferma con commit avanti), unita, altro. */
export function groupOf(entry: BranchMapEntry, kind: MapKind): GroupId {
  if (kind === 'working' || kind === 'waiting' || kind === 'error') return 'working'
  if (kind === 'merged') return 'merged'
  if (entry.problem === null && (entry.ahead ?? 0) > 0) return 'ready'
  return 'other'
}

/** Righe in gruppi, nell'ordine Working, Ready to merge, Merged, altri; i gruppi vuoti non ci sono. */
export function groupRows(entries: BranchMapEntry[], kindFor: (e: BranchMapEntry) => MapKind): Group[] {
  const order: GroupId[] = ['working', 'ready', 'merged', 'other']
  const rows: Row[] = entries.map((entry) => {
    const kind = kindFor(entry)
    return { entry, kind, group: groupOf(entry, kind) }
  })
  return order.map((id) => ({ id, rows: rows.filter((r) => r.group === id) })).filter((g) => g.rows.length > 0)
}
