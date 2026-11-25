// Side-by-side sessions: up to 3 columns in the project view, each with its own chat and composer.
// Only one column is active (iris border): it receives shortcuts and decides what the inspector and terminal show.
import { Fragment, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { Columns2, X } from 'lucide-react'
import type { SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { ResizeHandle, type ResizeRange } from '@/components/resize-handle'
import { SessionGlyph } from '@/components/status'
import { MIN_COLUMN_WIDTH, useElementWidth } from '@/lib/use-element-width'
import { clamp } from '@/lib/panel-size'
import { noteTone, sessionNote, sessionState } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { liveColumns, MAX_COLUMNS, useApp } from '@/store/app-store'

/** Width in pixels of the strip on the right edge that accepts a dragged tab. */
const EDGE_X = 120
/** And the height of the strip at the bottom. */
const EDGE_Y = 80
/** Height of the top bar: not part of the edge, otherwise dragging a tab to the bottom of the bar would open a column. */
const BAR_HEIGHT = 52
/** Margin of the columns' frame (px-2) and width of a divider between two columns. */
const COLUMNS_INSET = 16
const DIVIDER = 8

/** Can this session be split off by dragging? Not if it is already visible, it is the only one open, or the columns are full. */
export function canDropOnEdge(projectId: string, sessionId: string): boolean {
  const state = useApp.getState()
  const columns = liveColumns(state, projectId)
  if (columns.length >= MAX_COLUMNS || columns.includes(sessionId)) return false
  return !(state.selection.kind === 'session' && state.selection.sessionId === sessionId)
}

/** The pointer is on the right or bottom edge of the project view. */
export function overSplitEdge(event: PointerEvent): boolean {
  const area = document.querySelector('[data-split-area]')
  if (!area) return false
  const rect = area.getBoundingClientRect()
  const { clientX: x, clientY: y } = event
  if (x < rect.left || x > rect.right || y > rect.bottom || y < rect.top + BAR_HEIGHT) return false
  return x >= rect.right - EDGE_X || y >= rect.bottom - EDGE_Y
}

/** Box showing where the new column will open while a tab is on the edge. */
export function SplitDropHint() {
  const on = useApp((s) => s.splitDrop)
  if (!on) return null
  return (
    <div aria-hidden className="pointer-events-none absolute inset-y-2 right-2 z-20 flex w-1/3 min-w-[200px] items-center justify-center gap-2 rounded-xl border-2 border-dashed border-ring/60 bg-ring/10 text-sm font-medium text-foreground">
      <Columns2 className="size-4" strokeWidth={1.75} />
      {t('Open side by side')}
    </div>
  )
}

/** Header of a column: session status (running, waiting), title and close button. */
export function ColumnHeader({ session, active, hidden, onClose }: { session: SessionSummary; active: boolean; hidden: number; onClose: () => void }) {
  const state = sessionState(session)
  // Status in words only when there is something to say (waiting, error); for running and unread the symbol is enough.
  const note = state === 'waiting' || state === 'error' || state === 'agents' || state === 'agents-failed' || state === 'agents-running' ? sessionNote(session, false) : null
  const tone = note ? noteTone(note.code) : null
  const label = state === 'running' ? t('Running') : state === 'unread' ? t('Unread') : null
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 pr-1 pl-3 text-sm">
      <span aria-hidden className="grid w-3.5 shrink-0 place-items-center">{state === 'idle' ? <AgentMark agent={session.agent} size={13} /> : <SessionGlyph state={state} />}</span>
      <span className={cn('min-w-0 truncate', active ? 'font-medium text-foreground' : 'text-muted-foreground')} title={session.title}>
        {session.title}
      </span>
      {note ? (
        <span className={cn('shrink-0 text-xs text-muted-foreground', tone === 'attention' && 'font-semibold text-attention', tone === 'destructive' && 'text-destructive')}>{note.text}</span>
      ) : (
        label && <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      )}
      <span className="flex-1" />
      {hidden > 0 && (
        <span className="shrink-0 text-xs text-faint" title={t('There is no room for the other columns. Widen the window to see them.')}>
          {t('+{n} hidden', { n: hidden })}
        </span>
      )}
      <button
        type="button"
        data-column-close
        aria-label={t('Close column {title}', { title: session.title })}
        title={t('Close column (the session stays in its tab)')}
        onClick={onClose}
        className="grid size-6 shrink-0 place-items-center rounded-md text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

interface SplitColumnsProps {
  projectId: string
  columns: string[]
  activeId: string
  /** Content of a column. `hidden`: columns that do not fit in the window, to be mentioned in the active column's header. */
  renderColumn: (sessionId: string, column: { active: boolean; single: boolean; hidden: number; onClose: () => void }) => ReactNode
}

/**
 * The side-by-side columns. If the window is narrow, fewer columns are shown (at least the active one): the others stay
 * in the saved layout and return when there is room again.
 */
export function SplitColumns({ projectId, columns, activeId, renderColumn }: SplitColumnsProps) {
  const [measureRef, width] = useElementWidth()
  const container = useRef<HTMLDivElement | null>(null)
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      container.current = node
      measureRef(node)
    },
    [measureRef]
  )
  const setColumnWidths = useApp((s) => s.setColumnWidths)
  const saved = useApp((s) => s.ui[projectId]?.columnWidths)
  const select = useApp((s) => s.select)
  const closeColumn = useApp((s) => s.closeColumn)
  // A string, so the columns do not redraw on every streaming chunk of the sessions.
  const titlesKey = useApp((s) => JSON.stringify(columns.map((id) => s.sessions[id]?.title ?? '')))
  const titles = useMemo<string[]>(() => JSON.parse(titlesKey), [titlesKey])
  // n columns need n * MIN_COLUMN_WIDTH plus the dividers (8 px). `width` is that of the content, without the frame margin.
  const fit = width > 0 ? Math.max(1, Math.floor((width + DIVIDER) / (MIN_COLUMN_WIDTH + DIVIDER))) : columns.length
  const visible = useMemo(() => {
    if (columns.length <= fit) return columns
    const at = Math.max(0, columns.indexOf(activeId))
    const start = Math.min(Math.max(at - Math.floor((fit - 1) / 2), 0), columns.length - fit)
    return columns.slice(start, start + fit)
  }, [columns, fit, activeId])
  const hidden = columns.length - visible.length

  // Saved proportions (one per column); if they do not match the current columns, equal parts.
  const weights = useMemo(() => (saved && saved.length === columns.length && saved.every((w) => Number.isFinite(w) && w > 0) ? saved : columns.map(() => 1)), [saved, columns])
  const visibleIndex = visible.map((id) => columns.indexOf(id))
  const visibleSum = visibleIndex.reduce((sum, i) => sum + weights[i], 0)
  const available = Math.max(0, (container.current?.clientWidth ?? width + COLUMNS_INSET) - COLUMNS_INSET - DIVIDER * (visible.length - 1))

  /** The visible sections and their current width, measured on the DOM. */
  const nodes = (): HTMLElement[] => visible.map((id) => container.current?.querySelector<HTMLElement>(`[data-column="${CSS.escape(id)}"]`)).filter((node): node is HTMLElement => Boolean(node))
  const drag = useRef<{ nodes: HTMLElement[]; px: number[]; at: number } | null>(null)
  const measure = (at: number): ResizeRange => {
    const list = nodes()
    const px = list.map((node) => node.getBoundingClientRect().width)
    drag.current = { nodes: list, px, at }
    const pair = (px[at] ?? 0) + (px[at + 1] ?? 0)
    return { value: px[at] ?? 0, min: MIN_COLUMN_WIDTH, max: Math.max(MIN_COLUMN_WIDTH, pair - MIN_COLUMN_WIDTH) }
  }
  /** Moves the divider between `at` and `at + 1`: only `flex-grow` on the DOM, without redrawing. */
  const preview = (value: number) => {
    const state = drag.current
    if (!state || state.nodes.length !== state.px.length) return
    const total = state.px.reduce((sum, v) => sum + v, 0)
    if (total <= 0) return
    const pair = state.px[state.at] + state.px[state.at + 1]
    const left = clamp(value, MIN_COLUMN_WIDTH, pair - MIN_COLUMN_WIDTH)
    state.nodes.forEach((node, j) => {
      const px = j === state.at ? left : j === state.at + 1 ? pair - left : state.px[j]
      node.style.flexGrow = String((px / total) * 100)
    })
  }
  const commit = (value: number) => {
    const state = drag.current
    if (!state) return
    preview(value)
    const total = state.px.reduce((sum, v) => sum + v, 0)
    if (total <= 0 || state.px.length !== visible.length) return
    const pair = state.px[state.at] + state.px[state.at + 1]
    const left = clamp(value, MIN_COLUMN_WIDTH, pair - MIN_COLUMN_WIDTH)
    const next = weights.slice()
    state.px.forEach((px, j) => {
      const now = j === state.at ? left : j === state.at + 1 ? pair - left : px
      next[visibleIndex[j]] = Math.round((now / total) * visibleSum * 10000) / 10000
    })
    setColumnWidths(projectId, next)
  }

  // A click inside a column makes it active, without touching what was pressed. Focus activates it only if it
  // comes from the keyboard (Tab): a programmatic focus, for example of an approval card, must not steal it.
  const activate = (id: string, target: EventTarget, viaFocus = false) => {
    if (id === activeId || (target instanceof Element && target.closest('[data-column-close]'))) return
    if (viaFocus && !(target instanceof Element && target.matches(':focus-visible'))) return
    // Changing column is not navigating: it adds no entries to the ⌘[ and ⌘] history.
    select({ kind: 'session', projectId, sessionId: id }, { history: false })
  }

  // A single column (narrow window aside) is just the open session: no frame or header.
  const single = columns.length === 1

  return (
    <div ref={ref} className={cn('flex min-h-0 min-w-0 flex-1', !single && 'px-2 pb-2')}>
      {visible.map((id, k) => {
        const active = id === activeId
        const share = visibleSum > 0 ? weights[columns.indexOf(id)] / visibleSum : 1 / visible.length
        const next = visible[k + 1]
        const pair = visibleSum > 0 ? (available * (weights[columns.indexOf(id)] + weights[columns.indexOf(next)] || 0)) / visibleSum : 0
        return (
          <Fragment key={id}>
            <section
              data-column={id}
              aria-label={single ? undefined : t('Column: {title}', { title: titles[columns.indexOf(id)] ?? '' })}
              onPointerDownCapture={(event) => activate(id, event.target)}
              onFocusCapture={(event) => activate(id, event.target, true)}
              style={{ flexGrow: share * 100, minWidth: single ? undefined : MIN_COLUMN_WIDTH }}
              className={cn('relative flex min-w-0 basis-0 flex-col overflow-hidden', !single && 'rounded-xl border bg-background', !single && (active ? 'border-ring/60' : 'border-border/60'))}
            >
              {renderColumn(id, { active, single, hidden: active ? hidden : 0, onClose: () => closeColumn(projectId, id) })}
            </section>
            {next && (
              <ResizeHandle
                label={t('Resize columns {a} and {b}', { a: columns.indexOf(id) + 1, b: columns.indexOf(next) + 1 })}
                value={share * available}
                min={MIN_COLUMN_WIDTH}
                max={Math.max(MIN_COLUMN_WIDTH, pair - MIN_COLUMN_WIDTH)}
                measure={() => measure(k)}
                onPreview={preview}
                onCommit={commit}
                onReset={() => setColumnWidths(projectId, undefined)}
                className="shrink-0 self-stretch"
              />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
