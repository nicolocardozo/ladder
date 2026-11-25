// Branches tab: the vertical branch map. On the left the main branch line (theme accent) with its dot at the bottom;
// from there a connector leaves for each branch, ending in a filled dot with the state color and a ring in the background color.
// Merged branches are an empty circle with a check. Rows are in groups (Working, Ready to merge, Merged, others); the row of the
// open session carries the merge actions below it (`detail`). Color is never the only signal: there are also the shape and the state word.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, FolderOpen } from 'lucide-react'
import type { BranchMap as BranchMapData, BranchMapEntry, SessionSummary } from '@shared/protocol'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isElectron } from '@/lib/host-client'
import { isMac } from '@/lib/send-key'
import { relativeAge } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { plural, t } from '@shared/i18n'
import { FAR_BEHIND, groupRows, hasNoSession, kindOf, kindWord, MERGED_SHOWN, problemText, visibleEntries, type GroupId, type MapKind, type Row } from './branch-map-layout'

/** Watches the project map only while `enabled`: host subscription with cleanup, no request on every render. */
export function useBranchMap(projectId: string | null, enabled: boolean) {
  const watch = useApp((s) => s.watchBranchMap)
  const unwatch = useApp((s) => s.unwatchBranchMap)
  useEffect(() => {
    if (!projectId || !enabled) return
    watch(projectId)
    return () => unwatch(projectId)
  }, [projectId, enabled, watch, unwatch])
  return useApp((s) => (projectId ? s.branchMaps[projectId] : undefined))
}

/** The host may send `error` inside the map (failed git reads): with empty rows it is an error, not "no worktrees". */
type MapWithError = BranchMapData & { error?: string | null }

// Pixel geometry of the drawing on the left: the main line sits at RAIL, branch dots at DOT, rows are ROW tall.
const RAIL = 9
const RAIL_WIDTH = 2
const DOT = 22
const DOT_R = 4.5
const ROW = 36
const GUTTER = 28

/** Line color (main and connectors): solid, the secondary text gray mixed with the background. No transparency, which would add up where strokes touch. */
const LINE = 'color-mix(in oklab, var(--muted-foreground) 45%, var(--background))'

/** State colors, only from theme tokens: running, waiting for you, error, ready to merge, merged (accent), stopped. */
function tone(kind: MapKind, group: GroupId): string {
  if (kind === 'working') return 'text-running'
  if (kind === 'waiting') return 'text-attention'
  if (kind === 'error') return 'text-destructive'
  if (kind === 'merged') return 'text-primary'
  return group === 'ready' ? 'text-success' : 'text-muted-foreground'
}

const wordTone = (kind: MapKind, group: GroupId) => cn(tone(kind, group), kind === 'waiting' && 'font-medium')

/** State word shown in the row: "ready to merge" for stopped branches with commits ahead, otherwise the usual one. */
const stateWord = (kind: MapKind, group: GroupId) => (kind === 'idle' && group === 'ready' ? t('ready to merge') : kindWord(kind))

/**
 * Connector from the main line to the branch dot, and the dot: filled with a background ring; empty circle with check if merged.
 * The main line and the connectors have the same solid color (LINE) and the same thickness: the connector starts from the center of the line and curves
 * toward the dot, so the joint is not visible. The state color is only on the dot.
 */
function RowMark({ kind, group }: { kind: MapKind; group: GroupId }) {
  const cy = ROW / 2
  const merged = kind === 'merged'
  return (
    <svg aria-hidden width={GUTTER} height={ROW} viewBox={`0 0 ${GUTTER} ${ROW}`} className={cn('pointer-events-none absolute top-0 left-0', tone(kind, group))}>
      <path d={`M${RAIL} ${cy - 9} Q${RAIL} ${cy} ${RAIL + 9} ${cy} L${DOT - DOT_R} ${cy}`} fill="none" strokeWidth={RAIL_WIDTH} style={{ stroke: LINE }} />
      {merged ? (
        <>
          <circle cx={DOT} cy={cy} r={DOT_R} className="fill-background" strokeWidth={1.5} stroke="currentColor" />
          <path d={`M${DOT - 2.2} ${cy + 0.1} L${DOT - 0.6} ${cy + 1.7} L${DOT + 2.3} ${cy - 1.6}`} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <circle cx={DOT} cy={cy} r={DOT_R} fill="currentColor" className="stroke-background" strokeWidth={3} style={{ paintOrder: 'stroke' }} />
      )}
    </svg>
  )
}

/** Click opens the session, ⌘click (Ctrl outside macOS) opens it side by side, like tabs. Archived ones can't be opened. */
function useOpenEntry(projectId: string) {
  const sessions = useApp((s) => s.sessions)
  const select = useApp((s) => s.select)
  const openSplit = useApp((s) => s.openSplit)
  return {
    canOpen: (entry: BranchMapEntry) => Boolean(sessions[entry.sessionId] && !sessions[entry.sessionId].archived),
    /** ⌘Enter (Ctrl+Enter) = ⌘click: the browser doesn't turn it into a click on its own. */
    onKey: (entry: BranchMapEntry, event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(isMac ? event.metaKey : event.ctrlKey)) return
      event.preventDefault()
      if (sessions[entry.sessionId] && !sessions[entry.sessionId].archived) openSplit(projectId, entry.sessionId)
    },
    open: (entry: BranchMapEntry, event: MouseEvent) => {
      if (!sessions[entry.sessionId] || sessions[entry.sessionId].archived) return
      if (isMac ? event.metaKey : event.ctrlKey) openSplit(projectId, entry.sessionId)
      else select({ kind: 'session', projectId, sessionId: entry.sessionId })
    }
  }
}

const commits = (e: BranchMapEntry) => ({ ahead: e.ahead ?? 0, behind: e.behind ?? 0 })

/** Sentence for screen readers: title or branch, state, distance from main. */
function entryLabel(e: BranchMapEntry, word: string, base: string): string {
  const { ahead, behind } = commits(e)
  const branch = e.branch ?? t('Detached HEAD')
  const parts = [e.mainCheckout || hasNoSession(e) ? branch : e.title]
  if (e.mainCheckout) {
    parts.push(t('main checkout'))
    // The main checkout with a real session: the title is also read, if it is not the branch name.
    if (!hasNoSession(e) && e.title !== e.branch) parts.push(e.title)
  } else parts.push(branch)
  parts.push(word)
  const problem = problemText(e)
  if (problem) parts.push(problem)
  else {
    parts.push(plural(ahead, '{n} commit ahead of {base}', '{n} commits ahead of {base}', { base }))
    parts.push(plural(behind, '{n} commit behind {base}', '{n} commits behind {base}', { base }))
  }
  return parts.join(', ')
}

/** Tooltip content, also from the keyboard: title, agent, changed lines, last commit, uncommitted files. */
function EntryTip({ entry, word }: { entry: BranchMapEntry; word: string }) {
  const agent = useApp((s) => s.agents.find((a) => a.agent === entry.agent)?.name ?? entry.agent)
  const openable = useApp((s) => Boolean(s.sessions[entry.sessionId] && !s.sessions[entry.sessionId].archived))
  const mod = isMac ? '⌘' : 'Ctrl'
  // The main checkout without sessions has neither title nor agent: it just says where it is.
  const bare = hasNoSession(entry)
  return (
    <div className="flex min-w-0 max-w-64 flex-col gap-0.5">
      <p className="break-words font-medium">{entry.mainCheckout ? t('{branch} · main checkout', { branch: entry.branch ?? t('Detached HEAD') }) : entry.title}</p>
      {entry.mainCheckout ? <p className="opacity-80">{t('Your project folder, not a worktree')}</p> : <p className="break-all font-mono opacity-80">{entry.branch ?? t('Detached HEAD')}</p>}
      <p>
        {bare ? '' : `${agent} · `}
        {word}
      </p>
      {entry.mainCheckout && !bare && entry.title !== entry.branch && <p className="break-words opacity-80">{entry.title}</p>}
      {entry.added !== null && entry.removed !== null && (
        <p className="tabular-nums">
          {t('{lines} lines changed', { lines: `+${entry.added} −${entry.removed}` })}
        </p>
      )}
      {entry.lastCommit && (
        <p className="break-words">
          {entry.lastCommit.subject} · {relativeAge(entry.lastCommit.at)}
        </p>
      )}
      {entry.dirty !== null && <p>{entry.dirty > 0 ? plural(entry.dirty, '{n} uncommitted file', '{n} uncommitted files') : t('No uncommitted changes')}</p>}
      {entry.worktreeMissing && <p>{t('The worktree folder is missing')}</p>}
      {openable && <p className="opacity-70">{t('{mod}click to open side by side', { mod })}</p>}
    </div>
  )
}

const dot = <span aria-hidden>·</span>

/** Second line of the row: branch · state · ↑ahead ↓behind · +lines −lines. "Behind" is highlighted when it is far behind. */
function Detail({ row, base }: { row: Row; base: string }) {
  const { entry, kind, group } = row
  const { ahead, behind } = commits(entry)
  const problem = problemText(entry)
  const far = behind >= FAR_BEHIND
  // In the "Ready to merge" group the header already states the state: the row doesn't repeat it (it stays in the label for screen readers).
  const quiet = kind === 'idle' && group === 'ready'
  const lead = !entry.mainCheckout || !quiet
  const showLines = entry.added !== null && entry.removed !== null && (entry.added > 0 || entry.removed > 0)
  return (
    <span aria-hidden className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
      {!entry.mainCheckout && <span className="min-w-0 shrink truncate font-mono">{entry.branch ?? t('Detached HEAD')}</span>}
      {!entry.mainCheckout && !quiet && dot}
      {!quiet && <span className={cn('shrink-0 whitespace-nowrap', wordTone(kind, group))}>{stateWord(kind, group)}</span>}
      {problem ? (
        <>
          {lead && dot}
          <span className="min-w-0 truncate">{problem}</span>
        </>
      ) : (
        <>
          {lead && dot}
          <span className="inline-flex shrink-0 items-center tabular-nums">
            <ArrowUp className="size-3" strokeWidth={2} />
            {ahead}
          </span>
          <span className={cn('inline-flex shrink-0 items-center tabular-nums', far && 'font-medium text-attention')} title={far ? plural(behind, '{n} commit behind {base}', '{n} commits behind {base}', { base }) : undefined}>
            <ArrowDown className="size-3" strokeWidth={2} />
            {behind}
          </span>
        </>
      )}
      {showLines && (
        <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
          <span className="text-diff-added">+{entry.added}</span>
          <span className="text-diff-removed">−{entry.removed}</span>
        </span>
      )}
    </span>
  )
}

interface BranchRowProps {
  row: Row
  base: string
  current: boolean
  canOpen: boolean
  onOpen: (e: MouseEvent) => void
  onKey: (e: KeyboardEvent) => void
  /** Where the merge actions go: only the open session's row has the slot (the content is projected into it, not remounted). */
  slotRef?: (el: HTMLDivElement | null) => void
  /** Last session already scrolled into view: it isn't scrolled again if it is the same. */
  scrolled: MutableRefObject<string | null>
}

function BranchRow({ row, base, current, canOpen, onOpen, onKey, slotRef, scrolled }: BranchRowProps) {
  const { entry, kind, group } = row
  const word = stateWord(kind, group)
  const ref = useRef<HTMLLIElement>(null)
  // The open session scrolls into view when the tab opens or the session changes: with many branches it doesn't stay off screen.
  useEffect(() => {
    if (!current || scrolled.current === entry.sessionId) return
    scrolled.current = entry.sessionId
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [current, entry.sessionId, scrolled])
  const title = entry.mainCheckout || hasNoSession(entry) ? (entry.branch ?? t('Detached HEAD')) : entry.title
  return (
    <li ref={ref} className="relative pr-2" style={{ paddingLeft: GUTTER }}>
      <RowMark kind={kind} group={group} />
      <Tooltip>
        <TooltipTrigger
          render={<button type="button" />}
          aria-label={entryLabel(entry, word, base)}
          aria-current={current ? 'true' : undefined}
          aria-disabled={canOpen ? undefined : true}
          onClick={onOpen}
          onKeyDown={onKey}
          className={cn(
            'flex w-full min-w-0 flex-col justify-center rounded-md px-2 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50',
            current && 'bg-accent',
            canOpen ? 'cursor-pointer' : 'cursor-default'
          )}
          style={{ height: ROW }}
        >
          <span className={cn('flex min-w-0 items-center gap-1.5 text-sm leading-[18px]', kind === 'merged' && !current ? 'text-muted-foreground' : 'text-foreground', current && 'font-medium')}>
            {entry.mainCheckout && <FolderOpen aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />}
            <span className={cn('min-w-0 truncate', entry.mainCheckout && 'font-mono text-xs')}>{title}</span>
            {entry.mainCheckout && <span className="shrink-0 whitespace-nowrap text-xs font-normal text-muted-foreground">· {t('main checkout')}</span>}
          </span>
          <Detail row={row} base={base} />
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start">
          <EntryTip entry={entry} word={word} />
        </TooltipContent>
      </Tooltip>
      {slotRef && <div ref={slotRef} className="-mr-2 mt-1 empty:hidden" />}
    </li>
  )
}

function groupTitle(id: GroupId): string {
  switch (id) {
    case 'working':
      return t('In progress')
    case 'ready':
      return t('Ready to merge')
    case 'merged':
      return t('Merged')
    default:
      return t('Others')
  }
}

interface BranchMapProps {
  projectId: string
  /** Open session: its row is highlighted and carries `detail` below it. */
  currentSessionId: string | null
  /** Merge actions: they sit below the open session's row; if its row isn't there (for example on the main branch) they come before the list. */
  detail?: ReactNode
}

export function BranchMap({ projectId, currentSessionId, detail }: BranchMapProps) {
  const map = useBranchMap(projectId, true)
  const sessions = useApp((s) => s.sessions)
  const { canOpen, open, onKey } = useOpenEntry(projectId)
  const [showAllMerged, setShowAllMerged] = useState(false)
  const fetchError = useApp((s) => s.branchMapError[projectId])
  const retry = useApp((s) => s.retryBranchMap)

  const base = map?.base ?? 'main'
  // The open session in the main checkout highlights the main checkout row (which carries the id of the most recent one, not always this one).
  const currentInMain = useApp((s) => (currentSessionId && s.sessions[currentSessionId] ? !s.sessions[currentSessionId].worktree : false))
  const currentKey = useMemo(() => {
    if (!currentSessionId || !currentInMain) return currentSessionId
    return map?.entries.find((e) => e.mainCheckout)?.sessionId ?? currentSessionId
  }, [currentSessionId, currentInMain, map])

  const groups = useMemo(() => {
    if (!map) return []
    return groupRows(visibleEntries(map.entries, Date.now()), (e) => kindOf(e, sessions[e.sessionId] as SessionSummary | undefined))
  }, [map, sessions])
  const total = groups.reduce((n, g) => n + g.rows.length, 0)
  const sha = map?.baseSha ? map.baseSha.slice(0, 7) : null

  // The merge actions have ONE instance, always under the same parent: they are projected with a portal into a node that moves into the slot
  // of the open row (or to the top, if the row isn't there). Group changes, the map arriving and row remounts don't touch its state.
  const host = useMemo(() => document.createElement('div'), [])
  const topSlot = useRef<HTMLDivElement>(null)
  const [rowSlot, setRowSlot] = useState<HTMLDivElement | null>(null)
  const scrolled = useRef<string | null>(null)
  useLayoutEffect(() => {
    const target = rowSlot?.isConnected ? rowSlot : topSlot.current
    if (target && host.parentNode !== target) target.appendChild(host)
  })

  // Failed request without a map, or empty map with the host's error: the error is shown, never the empty state or "Reading branches…".
  const failed = isElectron && (map ? Boolean((map as MapWithError).error) && map.entries.length === 0 : Boolean(fetchError))
  const empty = total === 0

  return (
    <section aria-label={t('Branches against {base}', { base })} className="flex flex-col pb-2">
      <div ref={topSlot} />
      {detail !== undefined && createPortal(detail, host)}
      {failed && (
        <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs text-muted-foreground">
          <p className="min-w-0">{t('Couldn’t read the branches.')}</p>
          <button
            type="button"
            onClick={() => retry(projectId)}
            className="inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-xs text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {t('Try again')}
          </button>
        </div>
      )}
      {!failed && !map && isElectron && <p className="px-3 py-2 text-xs text-muted-foreground">{t('Reading branches…')}</p>}
      {!failed && (map || !isElectron) && empty && <p className="px-3 py-2 text-xs text-muted-foreground">{t('No worktrees. Sessions in a worktree appear here.')}</p>}
      {!failed && map && !empty && (
        <div className="relative">
          {/* The main branch line: from the top down to its dot, which sits at the bottom of the `base` row. */}
          <span aria-hidden className="absolute" style={{ left: RAIL - RAIL_WIDTH / 2, width: RAIL_WIDTH, top: 0, bottom: ROW / 2, background: LINE }} />
          {groups.map((group) => {
            // Merged ones fold into a single one, but the open session always stays in view.
            const folded = group.id === 'merged' && !showAllMerged
            const shown = folded ? group.rows.filter((r, i) => i < MERGED_SHOWN || r.entry.sessionId === currentKey) : group.rows
            const hidden = group.rows.length - shown.length
            const headingId = `branches-${group.id}`
            return (
              <div key={group.id}>
                <h4 id={headingId} className="flex items-center gap-1.5 pt-3 pr-3 pb-1 text-xs font-medium text-muted-foreground" style={{ paddingLeft: GUTTER + 8 }}>
                  {groupTitle(group.id)}
                  <span className="font-normal tabular-nums text-faint">{group.rows.length}</span>
                </h4>
                <ul aria-labelledby={headingId} className="m-0 flex list-none flex-col p-0">
                  {shown.map((row) => {
                    const current = row.entry.sessionId === currentKey
                    return <BranchRow key={row.entry.sessionId} row={row} base={base} current={current} canOpen={canOpen(row.entry)} onOpen={(e) => open(row.entry, e)} onKey={(e) => onKey(row.entry, e)} slotRef={current ? setRowSlot : undefined} scrolled={scrolled} />
                  })}
                </ul>
                {group.id === 'merged' && group.rows.length > MERGED_SHOWN && (hidden > 0 || showAllMerged) && (
                  <div style={{ paddingLeft: GUTTER + 8 }} className="pt-0.5">
                    <button
                      type="button"
                      aria-expanded={showAllMerged}
                      onClick={() => setShowAllMerged((v) => !v)}
                      className="inline-flex h-6 items-center rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {showAllMerged ? t('Show fewer') : plural(hidden, 'Show {n} more branch', 'Show {n} more branches')}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          {map.hidden > 0 && <p className="pt-2 pr-3 text-xs text-muted-foreground" style={{ paddingLeft: GUTTER + 8 }}>{plural(map.hidden, '{n} older session not shown', '{n} older sessions not shown')}</p>}
          {/* Line bottom: the main branch, with its short sha if known. */}
          <div className="relative mt-1 flex items-center gap-1.5 pr-3 text-xs" style={{ height: ROW, paddingLeft: GUTTER + 8 }}>
            <svg aria-hidden width={GUTTER} height={ROW} viewBox={`0 0 ${GUTTER} ${ROW}`} className="pointer-events-none absolute top-0 left-0 text-primary">
              <circle cx={RAIL} cy={ROW / 2} r={5} fill="currentColor" className="stroke-background" strokeWidth={3} style={{ paintOrder: "stroke" }} />
            </svg>
            <span className="min-w-0 truncate font-mono font-medium text-foreground" title={base}>
              {base}
            </span>
            {sha && <span className="shrink-0 font-mono text-muted-foreground">{sha}</span>}
            {map.baseAt !== null && <span className="shrink-0 whitespace-nowrap text-faint">· {relativeAge(map.baseAt)}</span>}
          </div>
        </div>
      )}
    </section>
  )
}
