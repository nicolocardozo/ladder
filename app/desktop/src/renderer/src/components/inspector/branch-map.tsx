// Mappa dei worktree (LAD-80): la linea di main in orizzontale, il tempo da sinistra a destra, una curva per ogni sessione in un worktree.
// La curva parte dal punto in cui il branch si è staccato da main e finisce con un segno sullo stato attuale, oppure rientra in main se è unita.
// Colore, forma del segno ed etichetta dicono lo stesso stato (in esecuzione, ti aspetta, unita, ferma), mai solo il colore.
// Il disegno è in pixel e le etichette sono HTML: il testo non si rimpicciolisce mai, quando il pannello si stringe si accorcia con i puntini.
// Le etichette sono anche l'elenco accessibile (un <li> con un bottone per branch); la lista completa ("+N") ha le stesse informazioni.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, GitBranch } from 'lucide-react'
import type { BranchMap as BranchMapData, BranchMapEntry, SessionSummary } from '@shared/protocol'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isElectron } from '@/lib/host-client'
import { isMac } from '@/lib/send-key'
import { relativeAge } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { plural, t } from '@shared/i18n'
import { kindOf, kindWord, layoutMap, pickCurves, problemText, visibleEntries, type CurveGeometry, type MapKind } from './branch-map-layout'

/** Osserva la mappa del progetto solo finché `enabled`: iscrizione all'host con pulizia, nessuna richiesta a ogni render. */
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

/** L'host può mandare `error` dentro la mappa (letture git fallite): con le righe vuote è un errore, non "nessun worktree". */
type MapWithError = BranchMapData & { error?: string | null }

const TONE: Record<MapKind, { text: string; word: string }> = {
  working: { text: 'text-running', word: 'text-running' },
  waiting: { text: 'text-attention', word: 'font-medium text-attention' },
  error: { text: 'text-destructive', word: 'text-destructive' },
  merged: { text: 'text-success', word: 'rounded-full bg-success/15 px-1.5 text-success' },
  idle: { text: 'text-muted-foreground', word: 'text-muted-foreground' },
  archived: { text: 'text-muted-foreground', word: 'text-muted-foreground' }
}

/** Segno di stato, centrato in (x, y): pallino pieno (in esecuzione), anello (ti aspetta), spunta (unito), trattino (fermo), croce (errore). */
function Marker({ kind, x, y, r = 5 }: { kind: MapKind; x: number; y: number; r?: number }) {
  const tone = TONE[kind].text
  switch (kind) {
    case 'working':
      return <circle cx={x} cy={y} r={r} fill="currentColor" className={tone} />
    case 'waiting':
      return <circle cx={x} cy={y} r={r - 1} strokeWidth={2.2} stroke="currentColor" className={cn(tone, 'fill-background')} />
    case 'merged':
      return (
        <g className={tone}>
          <circle cx={x} cy={y} r={r + 1} fill="currentColor" />
          <path d={`M${x - 2.6} ${y + 0.2} L${x - 0.6} ${y + 2.2} L${x + 2.8} ${y - 2}`} fill="none" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="stroke-background" />
        </g>
      )
    case 'error':
      return (
        <path d={`M${x - 3.5} ${y - 3.5} L${x + 3.5} ${y + 3.5} M${x + 3.5} ${y - 3.5} L${x - 3.5} ${y + 3.5}`} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" className={tone} />
      )
    default:
      return <path d={`M${x} ${y - r} V${y + r}`} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" className={tone} />
  }
}

function MarkerIcon({ kind }: { kind: MapKind }) {
  return (
    <svg aria-hidden width={12} height={12} viewBox="0 0 12 12" className="shrink-0">
      <Marker kind={kind} x={6} y={6} r={4} />
    </svg>
  )
}

/** Clic apre la sessione, ⌘clic (Ctrl fuori da macOS) la affianca, come le tab (LAD-74). Le archiviate non si aprono. */
function useOpenEntry(projectId: string) {
  const sessions = useApp((s) => s.sessions)
  const select = useApp((s) => s.select)
  const openSplit = useApp((s) => s.openSplit)
  return {
    canOpen: (entry: BranchMapEntry) => Boolean(sessions[entry.sessionId] && !sessions[entry.sessionId].archived),
    /** ⌘Invio (Ctrl+Invio) = ⌘clic: il browser non lo trasforma in un clic da solo. */
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

/** Frase per gli screen reader: branch, stato, distanza da main e titolo della sessione. */
function entryLabel(e: BranchMapEntry, kind: MapKind, base: string): string {
  const { ahead, behind } = commits(e)
  const parts = [e.branch ?? t('Detached HEAD'), kindWord(kind)]
  if (e.problem === null) {
    parts.push(plural(ahead, '{n} commit ahead of {base}', '{n} commits ahead of {base}', { base }))
    parts.push(plural(behind, '{n} commit behind {base}', '{n} commits behind {base}', { base }))
  }
  parts.push(e.title)
  return parts.join(', ')
}

function Distance({ entry, className }: { entry: BranchMapEntry; className?: string }) {
  const { ahead, behind } = commits(entry)
  if (entry.problem !== null) return null
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums', className)}>
      <span className="inline-flex items-center">
        <ArrowUp className="size-3" strokeWidth={2} />
        {ahead}
      </span>
      <span className="inline-flex items-center">
        <ArrowDown className="size-3" strokeWidth={2} />
        {behind}
      </span>
    </span>
  )
}

/** Contenuto del tooltip, anche da tastiera: titolo, agente, righe cambiate, ultimo commit, file non committati. */
function EntryTip({ entry, kind }: { entry: BranchMapEntry; kind: MapKind }) {
  const agent = useApp((s) => s.agents.find((a) => a.agent === entry.agent)?.name ?? entry.agent)
  const mod = isMac ? '⌘' : 'Ctrl'
  return (
    <div className="flex min-w-0 max-w-64 flex-col gap-0.5">
      <p className="break-words font-medium">{entry.title}</p>
      <p className="break-all font-mono opacity-80">{entry.branch ?? t('Detached HEAD')}</p>
      <p>
        {agent} · {kindWord(kind)}
      </p>
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
      <p className="opacity-70">{t('{mod}click to open side by side', { mod })}</p>
    </div>
  )
}

interface BranchMapProps {
  projectId: string
  /** Sessione aperta: il suo branch è evidenziato, gli altri più tenui. */
  currentSessionId: string | null
  /** `compact`: solo main e il branch della sessione aperta, per la scheda Merge. */
  variant?: 'full' | 'compact'
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

export function BranchMap({ projectId, currentSessionId, variant = 'full' }: BranchMapProps) {
  const compact = variant === 'compact'
  const map = useBranchMap(projectId, true)
  const sessions = useApp((s) => s.sessions)
  const { canOpen, open, onKey } = useOpenEntry(projectId)
  const [expanded, setExpanded] = useState(false)
  const [tip, setTip] = useState<string | null>(null)
  // Il contenitore può comparire dopo il montaggio (compact: senza mappa il componente non rende nulla): lo si segue con un ref a stato.
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const fetchError = useApp((s) => s.branchMapError[projectId])
  const retry = useApp((s) => s.retryBranchMap)

  useLayoutEffect(() => {
    if (!box) return
    const read = () => setWidth(Math.round(box.getBoundingClientRect().width))
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(box)
    return () => observer.disconnect()
  }, [box])

  const base = map?.base ?? 'main'
  const { rows, curves } = useMemo(() => {
    if (!map) return { rows: [] as BranchMapEntry[], curves: [] as BranchMapEntry[] }
    if (compact) {
      const own = map.entries.filter((e) => e.sessionId === currentSessionId && e.isWorktree && !e.isBase)
      return { rows: own, curves: pickCurves(own, currentSessionId) }
    }
    const visible = visibleEntries(map.entries, Date.now())
    return { rows: visible, curves: pickCurves(visible, currentSessionId) }
  }, [map, compact, currentSessionId])
  const rest = rows.filter((e) => !curves.includes(e))
  const onBase = Boolean(map?.entries.some((e) => e.isBase && e.sessionId === currentSessionId))
  const geometry = useMemo(() => (width > 0 ? layoutMap(curves, width, base, map?.baseAt ?? null) : null), [curves, width, base, map?.baseAt])
  const kinds = useMemo(() => new Map(rows.map((e) => [e.sessionId, kindOf(e, sessions[e.sessionId] as SessionSummary | undefined)])), [rows, sessions])
  const kindFor = (e: BranchMapEntry): MapKind => kinds.get(e.sessionId) ?? 'idle'
  const hasCurrent = curves.some((e) => e.sessionId === currentSessionId)

  // Animazione solo quando cambia qualcosa: un branch nuovo si disegna, un'unione fa rientrare la curva. Il primo render e i
  // refresh identici non animano; con movimento ridotto niente.
  const paths = useRef(new Map<string, SVGPathElement>())
  const seen = useRef<Map<string, boolean> | null>(null)
  useLayoutEffect(() => {
    if (!map || !geometry) return
    const previous = seen.current
    seen.current = new Map(curves.map((e) => [e.sessionId, Boolean(e.merged)]))
    if (!previous || reducedMotion()) return
    for (const e of curves) {
      const wasMerged = previous.get(e.sessionId)
      const draw = (el: SVGPathElement | undefined, delay: number) =>
        el?.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 700, delay, easing: 'cubic-bezier(.6,0,.2,1)', fill: 'backwards' })
      if (wasMerged === undefined) {
        draw(paths.current.get(`${e.sessionId}:a`), 0)
        if (e.merged) draw(paths.current.get(`${e.sessionId}:b`), 600)
      } else if (e.merged && !wasMerged) draw(paths.current.get(`${e.sessionId}:b`), 0)
    }
  }, [map, geometry, curves])

  const summary = useMemo(() => {
    const lines = curves.map((e) => entryLabel(e, kindFor(e), base))
    return plural(curves.length, 'Branch map against {base}: {n} worktree. {list}', 'Branch map against {base}: {n} worktrees. {list}', { base, list: lines.join('. ') })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curves, base, kinds])

  // Richiesta fallita senza mappa, o mappa vuota con l'errore dell'host: si mostra l'errore, mai lo stato vuoto o "Reading branches…".
  const failed = isElectron && (map ? Boolean((map as MapWithError).error) && map.entries.length === 0 : Boolean(fetchError))
  // Sulla scheda Merge, senza branch da mostrare, non c'è niente da aggiungere.
  if (compact && curves.length === 0 && !failed) return null

  const heading = compact ? t('Distance from {base}', { base }) : t('Worktrees')
  const empty = rows.length === 0
  const geo = geometry

  return (
    <section aria-label={heading} className={cn('flex shrink-0 flex-col', compact ? 'border-b border-border' : 'border-b border-border pb-1')}>
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
        <GitBranch aria-hidden className="size-3.5 shrink-0" />
        <h3 className="min-w-0 truncate">{heading}</h3>
      </div>
      {failed && (
        <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 text-xs text-muted-foreground">
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
      {!failed && !map && isElectron && <p className="px-3 pb-2 text-xs text-muted-foreground">{t('Reading branches…')}</p>}
      {!failed && (map || !isElectron) && empty && <p className="px-3 pb-2 text-xs text-muted-foreground">{t('No worktrees. Sessions in a worktree appear here.')}</p>}
      <div ref={setBox} className="relative min-w-0 overflow-hidden px-1">
        {geo && curves.length > 0 && (
          <div className="relative" style={{ height: geo.height }}>
            <svg role="img" aria-label={summary} width={geo.width} height={geo.height} viewBox={`0 0 ${geo.width} ${geo.height}`} className="absolute inset-0 block overflow-visible">
              <title>{heading}</title>
              <line x1={geo.lineStart} x2={geo.width - 12} y1={geo.mainY} y2={geo.mainY} strokeWidth={2} strokeLinecap="round" className="stroke-muted-foreground/75" />
              {onBase && <circle cx={geo.width - 12} cy={geo.mainY} r={5} className="fill-foreground" />}
              {geo.curves.map((c) => {
                const entry = curves.find((e) => e.sessionId === c.id)!
                const kind = kindFor(entry)
                const current = c.id === currentSessionId
                const dim = hasCurrent && !current
                return (
                  <g key={c.id} className={cn(TONE[kind].text, 'transition-opacity motion-reduce:transition-none', dim && 'opacity-75')} onMouseEnter={() => setTip(c.id)} onMouseLeave={() => setTip((v) => (v === c.id ? null : v))}>
                    <circle cx={c.xs} cy={geo.mainY} r={3.5} strokeWidth={2} className="fill-background stroke-muted-foreground" />
                    <CurvePath c={c} current={current} paths={paths} onPick={(e) => open(entry, e)} />
                    <Marker kind={kind} x={c.markX} y={c.markY} />
                  </g>
                )
              })}
            </svg>
            <span className="absolute left-1 font-mono text-xs text-muted-foreground" style={{ top: geo.mainY - 8, width: geo.labelWidth }}>
              <span className="block truncate" title={base}>
                {base}
              </span>
            </span>
            <ul className="m-0 list-none p-0">
              {geo.curves.map((c) => {
                const entry = curves.find((e) => e.sessionId === c.id)!
                const kind = kindFor(entry)
                const current = c.id === currentSessionId
                return (
                  <li key={c.id} className="absolute flex" style={{ left: c.labelLeft, top: c.labelTop, height: 20, maxWidth: geo.width - c.labelLeft - 8 }}>
                    <Tooltip open={tip === c.id} onOpenChange={(o) => setTip((v) => (o ? c.id : v === c.id ? null : v))}>
                      <TooltipTrigger
                        render={<button type="button" />}
                        aria-label={entryLabel(entry, kind, base)}
                        aria-current={current ? 'true' : undefined}
                        aria-disabled={canOpen(entry) ? undefined : true}
                        onClick={(e: MouseEvent) => open(entry, e)}
                        onKeyDown={(e: KeyboardEvent) => onKey(entry, e)}
                        className={cn(
                          'inline-flex h-5 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50',
                          current ? 'bg-accent/60 font-semibold text-foreground' : hasCurrent ? 'text-muted-foreground' : 'text-foreground',
                          canOpen(entry) ? 'cursor-pointer' : 'cursor-default'
                        )}
                      >
                        <span className="min-w-0 truncate font-mono">{entry.branch}</span>
                        <span className={cn('shrink-0 whitespace-nowrap font-normal', TONE[kind].word)}>{kindWord(kind)}</span>
                        <Distance entry={entry} />
                      </TooltipTrigger>
                      <TooltipContent side={c.up ? 'top' : 'bottom'}>
                        <EntryTip entry={entry} kind={kind} />
                      </TooltipContent>
                    </Tooltip>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
      {!compact && rest.length > 0 && (
        <div className="px-2 pt-0.5 pb-1">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronDown aria-hidden className={cn('size-3 transition-transform motion-reduce:transition-none', expanded && 'rotate-180')} />
            {expanded ? t('Hide full list') : plural(rest.length, '+{n} more session', '+{n} more sessions')}
          </button>
        </div>
      )}
      {!compact && (expanded || (curves.length === 0 && rest.length > 0)) && (
        <ul className="m-0 flex list-none flex-col p-0 pb-1">
          {rows.map((entry) => (
            <FullRow key={entry.sessionId} entry={entry} kind={kindFor(entry)} base={base} current={entry.sessionId === currentSessionId} canOpen={canOpen(entry)} onOpen={(e) => open(entry, e)} onKey={(e) => onKey(entry, e)} />
          ))}
        </ul>
      )}
      {!compact && map && map.hidden > 0 && <p className="px-3 pb-1 text-xs text-muted-foreground">{plural(map.hidden, '{n} older session not shown', '{n} older sessions not shown')}</p>}
    </section>
  )
}

function CurvePath({ c, current, paths, onPick }: { c: CurveGeometry; current: boolean; paths: RefObject<Map<string, SVGPathElement>>; onPick: (e: MouseEvent) => void }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: current ? 2.75 : 2, strokeLinecap: 'round' as const, pathLength: 1, strokeDasharray: '1 1' }
  const ref = (name: string) => (el: SVGPathElement | null) => {
    if (el) paths.current.set(`${c.id}:${name}`, el)
    else paths.current.delete(`${c.id}:${name}`)
  }
  return (
    <>
      <path d={c.d} ref={ref('a')} {...common} />
      {c.back && <path d={c.back} ref={ref('b')} {...common} />}
      {/* Zona sensibile larga, per il mouse: da tastiera ci sono le etichette. */}
      <path d={c.back ? `${c.d} ${c.back.replace('M', 'L')}` : c.d} fill="none" stroke="transparent" strokeWidth={14} strokeLinecap="round" className="cursor-pointer" onClick={onPick} aria-hidden />
    </>
  )
}

/** Una riga della lista completa: stesse informazioni della mappa, titolo e età in più. */
function FullRow({ entry, kind, base, current, canOpen, onOpen, onKey }: { entry: BranchMapEntry; kind: MapKind; base: string; current: boolean; canOpen: boolean; onOpen: (e: MouseEvent) => void; onKey: (e: KeyboardEvent) => void }) {
  const problem = problemText(entry)
  return (
    <li>
      <button
        type="button"
        aria-label={problem ? `${entry.branch ?? t('Detached HEAD')}, ${problem}, ${entry.title}` : entryLabel(entry, kind, base)}
        aria-current={current ? 'true' : undefined}
        aria-disabled={canOpen ? undefined : true}
        onClick={onOpen}
        onKeyDown={onKey}
        className={cn('flex w-full min-w-0 flex-col items-start gap-0.5 px-3 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50', current && 'bg-accent/60')}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <MarkerIcon kind={kind} />
          <span className={cn('min-w-0 truncate font-mono', current && 'font-semibold')}>{entry.branch ?? t('Detached HEAD')}</span>
          <span className={cn('shrink-0 whitespace-nowrap', TONE[kind].word)}>{kindWord(kind)}</span>
          <Distance entry={entry} />
        </span>
        <span className="w-full min-w-0 truncate pl-[18px] text-muted-foreground">
          {entry.title}
          {problem ? ` · ${problem}` : entry.lastCommit ? ` · ${relativeAge(entry.lastCommit.at)}` : ''}
          {entry.worktreeMissing ? ` · ${t('worktree folder missing')}` : ''}
        </span>
      </button>
    </li>
  )
}
