// Mappa dei branch (LAD-80): scelta delle righe, stato a parole e geometria. Funzioni pure, nessun React.
import type { BranchMapEntry, SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { sessionState } from '@/lib/session-state'

/** Stato mostrato per un branch: colore, forma ed etichetta vengono da qui. */
export type MapKind = 'working' | 'waiting' | 'error' | 'merged' | 'idle' | 'archived'

/** Gli uniti da più di 7 giorni spariscono dalla mappa. */
export const MERGED_VISIBLE_MS = 7 * 24 * 60 * 60_000
/** Curve disegnate: gli ultimi 6 attivi, gli altri stanno nella lista completa ("+N"). */
export const MAX_CURVES = 6

/** Stesse regole della sidebar (`sessionState`): in esecuzione, ti aspetta, errore, ferma. L'unito viene dal git, non dalla sessione. */
export function kindOf(entry: BranchMapEntry, session: SessionSummary | undefined): MapKind {
  if (entry.merged) return 'merged'
  if (entry.archived) return 'archived'
  if (session) {
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
      return t('Merged')
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

/** Una riga si disegna come curva solo se ha un punto di stacco da main. */
export const isDrawable = (e: BranchMapEntry): boolean => e.problem === null && e.mergeBaseAt !== null && e.branch !== null

/**
 * Righe della mappa intera: solo worktree (le sessioni sul checkout principale non sono curve), niente archiviati non uniti,
 * niente uniti da più di 7 giorni. Le più recenti prima.
 */
export function visibleEntries(entries: BranchMapEntry[], now: number): BranchMapEntry[] {
  return entries
    .filter((e) => e.isWorktree && !e.isBase)
    .filter((e) => !(e.archived && !e.merged))
    .filter((e) => !(e.merged && now - (e.mergedAt ?? e.activityAt) > MERGED_VISIBLE_MS))
    .sort((a, b) => b.activityAt - a.activityAt)
}

/** Curve da disegnare: le prime `MAX_CURVES` con una curva possibile, e la sessione aperta anche se è più vecchia. */
export function pickCurves(rows: BranchMapEntry[], currentId: string | null): BranchMapEntry[] {
  const drawable = rows.filter(isDrawable)
  const picked = drawable.slice(0, MAX_CURVES)
  const current = currentId ? drawable.find((e) => e.sessionId === currentId) : undefined
  if (current && !picked.includes(current)) picked[MAX_CURVES - 1] = current
  // Una corsia per branch, la più vecchia più vicina a main: i nuovi arrivano all'esterno e non spostano gli altri.
  return picked.sort((a, b) => (validTime(a.mergeBaseAt) ?? 0) - (validTime(b.mergeBaseAt) ?? 0) || a.sessionId.localeCompare(b.sessionId))
}

// ── Geometria ────────────────────────────────────────────────────────────────

export const LANE = 40
export const LABEL_H = 20
const RIGHT_PAD = 16
const MIN_SPAN = 56
const MIN_MERGED_SPAN = 80

export interface CurveGeometry {
  id: string
  up: boolean
  /** Prima parte: dallo stacco da main alla fine (o al punto da cui rientra). */
  d: string
  /** Rientro in main, solo per gli uniti. */
  back: string | null
  xs: number
  ys: number
  /** Dove sta il segno di stato: sul pallino finale, o su main per gli uniti. */
  markX: number
  markY: number
  labelLeft: number
  labelTop: number
  /** Chiave della forma: cambia solo se cambia la geometria. */
  key: string
}

export interface MapGeometry {
  width: number
  height: number
  mainY: number
  lineStart: number
  labelWidth: number
  curves: CurveGeometry[]
}

const r1 = (n: number) => Math.round(n * 10) / 10

/** Un tempo vale solo se è un numero finito e positivo: 0, NaN, negativi e Infinity (date non lette) contano come assenti. */
export const validTime = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null)

/** Fine della curva: il primo tempo valido tra quelli possibili, mai prima dello stacco; null se non ce n'è nessuno. */
function endOf(e: BranchMapEntry): number | null {
  const start = validTime(e.mergeBaseAt)
  const end = e.merged ? (validTime(e.mergedAt) ?? validTime(e.lastCommit?.at) ?? validTime(e.activityAt)) : (validTime(e.lastCommit?.at) ?? validTime(e.activityAt))
  if (end === null) return start
  return start === null ? end : Math.max(start, end)
}

export function layoutMap(curves: BranchMapEntry[], width: number, baseLabel: string, baseAt: number | null): MapGeometry {
  const labelWidth = Math.min(84, Math.max(32, Math.ceil(baseLabel.length * 7.4) + 6))
  const lineStart = labelWidth + 4
  const left = lineStart + 12
  const right = Math.max(left + MIN_SPAN, width - RIGHT_PAD)
  const upCount = Math.ceil(curves.length / 2)
  const downCount = Math.floor(curves.length / 2)
  const mainY = upCount > 0 ? upCount * LANE + LABEL_H + 5 : 16
  const height = downCount > 0 ? mainY + downCount * LANE + LABEL_H + 8 : mainY + 16

  const starts = curves.map((e) => validTime(e.mergeBaseAt))
  const ends = curves.map(endOf)
  const baseTime = validTime(baseAt)
  const times = [...starts, ...ends, ...(baseTime !== null && curves.length > 0 ? [baseTime] : [])].filter((n): n is number => n !== null)
  const tMin = times.length > 0 ? Math.min(...times) : 0
  const tMax = times.length > 0 ? Math.max(...times) : 0
  // Tutti uguali (o quasi, o senza tempi validi): niente asse, posizioni equidistanti.
  const flat = !(tMax - tMin > 1000)
  const span = right - left
  const xOf = (time: number | null, i: number, kind: 'start' | 'end' | 'merge') => {
    if (!flat && time !== null) return left + ((time - tMin) / (tMax - tMin)) * span
    const step = Math.min(24, (span * 0.3) / Math.max(1, curves.length))
    if (kind === 'start') return left + span * 0.04 + i * step
    return left + span * (kind === 'merge' ? 0.9 : 0.7)
  }

  const out: CurveGeometry[] = curves.map((e, i) => {
    const up = i % 2 === 0
    const level = Math.floor(i / 2) + 1
    const ys = up ? mainY - level * LANE : mainY + level * LANE
    const merged = Boolean(e.merged)
    const need = merged ? MIN_MERGED_SPAN : MIN_SPAN
    const xs = Math.min(xOf(starts[i], i, 'start'), right - need)
    const xe = Math.min(right, Math.max(xs + need, xOf(ends[i], i, merged ? 'merge' : 'end')))
    const h = Math.min(26 + level * 8, (xe - xs) / 3)
    const c = h / 2
    const d = `M${r1(xs)} ${mainY} C${r1(xs + c)} ${mainY}, ${r1(xs + c)} ${ys}, ${r1(xs + h)} ${ys}`
    const labelLeft = Math.max(lineStart, Math.min(xs + h * 0.5, width - 250))
    const labelTop = up ? ys - 3 - LABEL_H : ys + 3
    const common = { id: e.sessionId, up, xs: r1(xs), ys, labelLeft: r1(labelLeft), labelTop }
    if (merged) {
      const back = `M${r1(xe - h)} ${ys} C${r1(xe - c)} ${ys}, ${r1(xe - c)} ${mainY}, ${r1(xe)} ${mainY}`
      return { ...common, d: `${d} H${r1(xe - h)}`, back, markX: r1(xe), markY: mainY, key: `${d}|${back}` }
    }
    return { ...common, d: `${d} H${r1(xe)}`, back: null, markX: r1(xe), markY: ys, key: `${d}|${r1(xe)}` }
  })
  return { width, height, mainY, lineStart, labelWidth, curves: out }
}
