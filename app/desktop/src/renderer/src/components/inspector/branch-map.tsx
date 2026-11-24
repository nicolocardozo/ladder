// Scheda Branches: la mappa dei branch in verticale. A sinistra la linea del ramo principale (accento del tema) con in fondo il suo pallino;
// da lì parte un raccordo per ogni branch, che finisce in un pallino pieno col colore dello stato e un anello del colore dello sfondo.
// I branch uniti sono un cerchio vuoto con la spunta. Le righe stanno in gruppi (Working, Ready to merge, Merged, altri); la riga della
// sessione aperta porta sotto di sé le azioni di unione (`detail`). Il colore non è mai l'unico segnale: ci sono la forma e la parola dello stato.
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

// Geometria in pixel del disegno a sinistra: la linea di main sta a RAIL, i pallini dei branch a DOT, le righe sono alte ROW.
const RAIL = 9
const RAIL_WIDTH = 2
const DOT = 22
const DOT_R = 4.5
const ROW = 36
const GUTTER = 28

/** Colore delle linee (main e raccordi): pieno, il grigio del testo secondario mescolato con lo sfondo. Niente trasparenze, che si sommano dove i tratti si toccano. */
const LINE = 'color-mix(in oklab, var(--muted-foreground) 45%, var(--background))'

/** Colori di stato, solo dai token del tema: in corso, ti aspetta, errore, pronto all'unione, unito (accento), fermo. */
function tone(kind: MapKind, group: GroupId): string {
  if (kind === 'working') return 'text-running'
  if (kind === 'waiting') return 'text-attention'
  if (kind === 'error') return 'text-destructive'
  if (kind === 'merged') return 'text-primary'
  return group === 'ready' ? 'text-success' : 'text-muted-foreground'
}

const wordTone = (kind: MapKind, group: GroupId) => cn(tone(kind, group), kind === 'waiting' && 'font-medium')

/** Parola dello stato mostrata nella riga: "ready to merge" per i fermi con commit avanti, altrimenti quella di sempre. */
const stateWord = (kind: MapKind, group: GroupId) => (kind === 'idle' && group === 'ready' ? t('ready to merge') : kindWord(kind))

/**
 * Raccordo dalla linea di main al pallino del branch, e il pallino: pieno con anello di sfondo; cerchio vuoto con spunta se unito.
 * Linea di main e raccordi hanno lo stesso colore pieno (LINE) e lo stesso spessore: il raccordo nasce dal centro della linea e curva
 * verso il pallino, così la giunta non si vede. Il colore dello stato sta solo sul pallino.
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

/** Frase per gli screen reader: titolo o branch, stato, distanza da main. */
function entryLabel(e: BranchMapEntry, word: string, base: string): string {
  const { ahead, behind } = commits(e)
  const branch = e.branch ?? t('Detached HEAD')
  const parts = [e.mainCheckout || hasNoSession(e) ? branch : e.title]
  if (e.mainCheckout) {
    parts.push(t('main checkout'))
    // Il checkout principale con una sessione vera: si dice anche il titolo, se non è il nome del branch.
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

/** Contenuto del tooltip, anche da tastiera: titolo, agente, righe cambiate, ultimo commit, file non committati. */
function EntryTip({ entry, word }: { entry: BranchMapEntry; word: string }) {
  const agent = useApp((s) => s.agents.find((a) => a.agent === entry.agent)?.name ?? entry.agent)
  const openable = useApp((s) => Boolean(s.sessions[entry.sessionId] && !s.sessions[entry.sessionId].archived))
  const mod = isMac ? '⌘' : 'Ctrl'
  // Il checkout principale senza sessioni non ha né titolo né agente: si dice dov'è e basta.
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

/** Seconda riga della riga: branch · stato · ↑avanti ↓indietro · +righe −righe. "Indietro" si evidenzia quando è molto indietro. */
function Detail({ row, base }: { row: Row; base: string }) {
  const { entry, kind, group } = row
  const { ahead, behind } = commits(entry)
  const problem = problemText(entry)
  const far = behind >= FAR_BEHIND
  // Nel gruppo "Ready to merge" l'intestazione dice già lo stato: la riga non lo ripete (resta nell'etichetta per gli screen reader).
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
  /** Dove stanno le azioni di unione: solo la riga della sessione aperta ha lo slot (il contenuto vi viene proiettato, non si rimonta). */
  slotRef?: (el: HTMLDivElement | null) => void
  /** Ultima sessione già portata in vista: non si riporta se è la stessa. */
  scrolled: MutableRefObject<string | null>
}

function BranchRow({ row, base, current, canOpen, onOpen, onKey, slotRef, scrolled }: BranchRowProps) {
  const { entry, kind, group } = row
  const word = stateWord(kind, group)
  const ref = useRef<HTMLLIElement>(null)
  // La sessione aperta si porta in vista quando la scheda si apre o la sessione cambia: con molti branch non resta fuori schermo.
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
  /** Sessione aperta: la sua riga è evidenziata e porta `detail` sotto di sé. */
  currentSessionId: string | null
  /** Azioni di unione: stanno sotto la riga della sessione aperta; se la sua riga non c'è (per esempio sul ramo principale) vengono prima della lista. */
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
  // La sessione aperta nel checkout principale evidenzia la riga del checkout principale (che porta l'id della più recente, non sempre questa).
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

  // Le azioni di unione hanno UNA istanza, sempre sotto lo stesso genitore: si proiettano con un portale in un nodo che si sposta nello slot
  // della riga aperta (o in cima, se la riga non c'è). Cambi di gruppo, arrivo della mappa e rimontaggi delle righe non toccano il suo stato.
  const host = useMemo(() => document.createElement('div'), [])
  const topSlot = useRef<HTMLDivElement>(null)
  const [rowSlot, setRowSlot] = useState<HTMLDivElement | null>(null)
  const scrolled = useRef<string | null>(null)
  useLayoutEffect(() => {
    const target = rowSlot?.isConnected ? rowSlot : topSlot.current
    if (target && host.parentNode !== target) target.appendChild(host)
  })

  // Richiesta fallita senza mappa, o mappa vuota con l'errore dell'host: si mostra l'errore, mai lo stato vuoto o "Reading branches…".
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
          {/* La linea del ramo principale: dall'alto fino al suo pallino, che sta in fondo alla riga di `base`. */}
          <span aria-hidden className="absolute" style={{ left: RAIL - RAIL_WIDTH / 2, width: RAIL_WIDTH, top: 0, bottom: ROW / 2, background: LINE }} />
          {groups.map((group) => {
            // Gli uniti si piegano a uno solo, ma la sessione aperta resta sempre in vista.
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
          {/* Fondo della linea: il ramo principale, col suo sha corto se si sa. */}
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
