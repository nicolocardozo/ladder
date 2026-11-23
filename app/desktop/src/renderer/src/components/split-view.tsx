// Sessioni affiancate: fino a 3 colonne nella vista del progetto, ognuna con la sua chat e il suo composer.
// Una sola colonna è attiva (bordo iris): riceve le scorciatoie e decide cosa mostrano ispettore e terminale.
import { useMemo, type ReactNode } from 'react'
import { Columns2, X } from 'lucide-react'
import type { SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { SessionGlyph } from '@/components/status'
import { MIN_COLUMN_WIDTH, useElementWidth } from '@/lib/use-element-width'
import { noteTone, sessionNote, sessionState } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { liveColumns, MAX_COLUMNS, useApp } from '@/store/app-store'

/** Quanto è larga, in pixel, la fascia sul bordo destro che accoglie una tab trascinata. */
const EDGE_X = 120
/** E quanto è alta la fascia in basso. */
const EDGE_Y = 80
/** Altezza della barra in alto: non fa parte del bordo, altrimenti trascinare una tab fino in fondo alla barra aprirebbe una colonna. */
const BAR_HEIGHT = 52

/** Si può affiancare questa sessione trascinandola? Non se è già visibile, è l'unica aperta o le colonne sono piene. */
export function canDropOnEdge(projectId: string, sessionId: string): boolean {
  const state = useApp.getState()
  const columns = liveColumns(state, projectId)
  if (columns.length >= MAX_COLUMNS || columns.includes(sessionId)) return false
  return !(state.selection.kind === 'session' && state.selection.sessionId === sessionId)
}

/** Il puntatore è sul bordo destro o in basso della vista del progetto. */
export function overSplitEdge(event: PointerEvent): boolean {
  const area = document.querySelector('[data-split-area]')
  if (!area) return false
  const rect = area.getBoundingClientRect()
  const { clientX: x, clientY: y } = event
  if (x < rect.left || x > rect.right || y > rect.bottom || y < rect.top + BAR_HEIGHT) return false
  return x >= rect.right - EDGE_X || y >= rect.bottom - EDGE_Y
}

/** Riquadro che dice dove si aprirà la nuova colonna mentre una tab è sul bordo. */
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

/** Intestazione di una colonna: stato della sessione (in esecuzione, in attesa), titolo e chiusura. */
export function ColumnHeader({ session, active, hidden, onClose }: { session: SessionSummary; active: boolean; hidden: number; onClose: () => void }) {
  const state = sessionState(session)
  // Stato in parole solo quando c'è qualcosa da dire (in attesa, errore); in esecuzione e da leggere basta il simbolo.
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
  /** Contenuto di una colonna. `hidden`: colonne che non entrano nella finestra, da dire nell'intestazione della colonna attiva. */
  renderColumn: (sessionId: string, column: { active: boolean; single: boolean; hidden: number; onClose: () => void }) => ReactNode
}

/**
 * Le colonne affiancate. Se la finestra è stretta si mostrano meno colonne (almeno quella attiva): le altre restano
 * nella disposizione salvata e tornano quando c'è di nuovo spazio.
 */
export function SplitColumns({ projectId, columns, activeId, renderColumn }: SplitColumnsProps) {
  const [ref, width] = useElementWidth()
  const select = useApp((s) => s.select)
  const closeColumn = useApp((s) => s.closeColumn)
  // Una stringa, così le colonne non si ridisegnano a ogni pezzo di streaming delle sessioni.
  const titlesKey = useApp((s) => JSON.stringify(columns.map((id) => s.sessions[id]?.title ?? '')))
  const titles = useMemo<string[]>(() => JSON.parse(titlesKey), [titlesKey])
  const fit = width > 0 ? Math.max(1, Math.floor(width / MIN_COLUMN_WIDTH)) : columns.length
  const visible = useMemo(() => {
    if (columns.length <= fit) return columns
    const at = Math.max(0, columns.indexOf(activeId))
    const start = Math.min(Math.max(at - Math.floor((fit - 1) / 2), 0), columns.length - fit)
    return columns.slice(start, start + fit)
  }, [columns, fit, activeId])
  const hidden = columns.length - visible.length

  // Un clic dentro una colonna la rende attiva, senza toccare quello che si è premuto. Il focus la attiva solo se viene
  // dalla tastiera (Tab): un focus programmatico, per esempio di una card di approvazione, non la deve rubare.
  const activate = (id: string, target: EventTarget, viaFocus = false) => {
    if (id === activeId || (target instanceof Element && target.closest('[data-column-close]'))) return
    if (viaFocus && !(target instanceof Element && target.matches(':focus-visible'))) return
    // Cambiare colonna non è navigare: non aggiunge voci alla cronologia di ⌘[ e ⌘].
    select({ kind: 'session', projectId, sessionId: id }, { history: false })
  }

  // Una colonna sola (finestra stretta a parte) è la sessione aperta e basta: niente cornice né intestazione.
  const single = columns.length === 1

  return (
    <div ref={ref} className={cn('flex min-h-0 min-w-0 flex-1', !single && 'gap-2 px-2 pb-2')}>
      {visible.map((id) => {
        const active = id === activeId
        return (
          <section
            key={id}
            data-column={id}
            aria-label={single ? undefined : t('Column: {title}', { title: titles[columns.indexOf(id)] ?? '' })}
            onPointerDownCapture={(event) => activate(id, event.target)}
            onFocusCapture={(event) => activate(id, event.target, true)}
            className={cn('relative flex min-w-0 flex-1 basis-0 flex-col overflow-hidden', !single && 'rounded-xl border bg-background', !single && (active ? 'border-ring/60' : 'border-border/60'))}
          >
            {renderColumn(id, { active, single, hidden: active ? hidden : 0, onClose: () => closeColumn(projectId, id) })}
          </section>
        )
      })}
    </div>
  )
}
