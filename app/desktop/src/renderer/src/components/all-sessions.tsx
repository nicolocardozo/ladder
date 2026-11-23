// Tutte le sessioni del progetto, in una seconda sidebar che si apre al passaggio sul pulsante: la chat resta dov'è.
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { Archive, Check, ChevronDown, ChevronRight, GitFork, Search, X } from 'lucide-react'
import type { Project, SessionSummary } from '@shared/protocol'
import { localeTag, plural, t } from '@shared/i18n'
import { AgentMark, useAgentLine } from '@/components/agent-mark'
import { useSessionProfileName } from '@/lib/profiles'
import { SessionMenuContent } from '@/components/session-menu'
import { SessionGlyph } from '@/components/status'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { MarqueeText } from '@/components/ui/marquee-text'
import { isUnreadState, lastTouched, noteTone, sessionNote, sessionState } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

type StatusFilter = 'all' | 'attention' | 'running' | 'unread' | 'idle'

// Testi inglesi: si traducono dove si mostrano.
const STATUS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'unread', label: 'Unread' },
  { id: 'idle', label: 'Idle' }
]

function matchesStatus(session: SessionSummary, filter: StatusFilter): boolean {
  const state = sessionState(session)
  if (filter === 'attention') return state === 'waiting' || state === 'error'
  if (filter === 'running') return state === 'running'
  if (filter === 'unread') return isUnreadState(state)
  if (filter === 'idle') return state === 'idle'
  return true
}

/** Solo le sessioni ferme si archiviano in blocco: una al lavoro o in attesa va prima chiusa da sola. */
const canArchive = (session: SessionSummary) => session.run === 'idle' || session.run === 'error'

function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(at: number, now: number): string {
  if (dayKey(at) === dayKey(now)) return t('Today')
  if (dayKey(at) === dayKey(now - 24 * 60 * 60_000)) return t('Yesterday')
  return new Intl.DateTimeFormat(localeTag(), { weekday: 'long', day: 'numeric', month: 'long' }).format(at)
}

const chip = 'flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

function FilterMenu({ label, value, options, onChange }: { label: string; value: string | null; options: { id: string; label: string }[]; onChange: (id: string | null) => void }) {
  const current = options.find((o) => o.id === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(chip, 'min-w-0', current ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground')}>
        <span className="truncate">{current?.label ?? label}</span>
        <ChevronDown className="size-3 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem onClick={() => onChange(null)}>
          <Check className={value ? 'size-3.5 opacity-0' : 'size-3.5'} />
          {label}
        </DropdownMenuItem>
        {options.map((option) => (
          <DropdownMenuItem key={option.id} onClick={() => onChange(option.id)}>
            <Check className={option.id === value ? 'size-3.5' : 'size-3.5 opacity-0'} />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SessionListRow({ session, project, checked, selecting, onToggle, onOpen }: { session: SessionSummary; project: Project; checked: boolean; selecting: boolean; onToggle: () => void; onOpen: () => void }) {
  const select = useApp((s) => s.select)
  const current = useApp((s) => s.selection.kind === 'session' && s.selection.sessionId === session.id)
  const hasDraft = useApp((s) => Boolean(s.drafts[session.id]?.trim()))
  const { name, model } = useAgentLine(session.agent, session.model)
  const profile = useSessionProfileName(session)
  const [hovered, setHovered] = useState(false)
  const state = sessionState(session)
  const note = sessionNote(session, hasDraft)
  const tone = noteTone(note.code)
  const hasGlyph = state !== 'idle'
  return (
    <ContextMenu>
      <ContextMenuTrigger
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        className={cn('group/row flex items-center rounded-lg pr-2 pl-0.5 hover:bg-sidebar-accent/60 data-[popup-open]:bg-sidebar-accent/60', current && 'bg-sidebar-accent')}
      >
        <span className="grid size-6 shrink-0 place-items-center">
          {canArchive(session) && (
            <input
              type="checkbox"
              checked={checked}
              onChange={onToggle}
              aria-label={t('Select {title}', { title: session.title })}
              className={cn('size-3.5 accent-primary', !checked && !selecting && 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100')}
            />
          )}
        </span>
        <button
          type="button"
          aria-current={current ? 'page' : undefined}
          onClick={() => {
            select({ kind: 'session', projectId: project.id, sessionId: session.id })
            onOpen()
          }}
          title={session.title}
          className={cn('ml-1 grid min-w-0 flex-1 items-start gap-x-2 gap-y-1 rounded-md py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50', hasGlyph ? 'grid-cols-[16px_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]')}
        >
          {hasGlyph && (
            <span className="row-span-2 grid h-[18px] place-items-center">
              <SessionGlyph state={state} />
            </span>
          )}
          <MarqueeText active={hovered} className={cn('text-sm', isUnreadState(state) && 'font-semibold')}>
            {session.title}
          </MarqueeText>
          <span className={cn('text-xs leading-[18px] whitespace-nowrap text-faint tabular-nums', tone === 'attention' && 'font-semibold text-attention', tone === 'destructive' && 'font-semibold text-destructive', tone === 'success' && 'font-medium text-success')}>
            {note.code === 'draft' ? <i>{note.text}</i> : note.text}
          </span>
          <span className={cn('col-span-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground', hasGlyph && 'col-start-2')}>
            <AgentMark agent={session.agent} size={12} />
            <span className="shrink-0">{model ?? name}</span>
            {profile && (
              <>
                <span aria-hidden className="text-faint">·</span>
                <span className="max-w-24 shrink-0 truncate" title={t('Account: {name}', { name: profile })}>{profile}</span>
              </>
            )}
            {session.branch && (
              <>
                <span aria-hidden className="text-faint">·</span>
                <span className="min-w-0 truncate">{session.branch}</span>
              </>
            )}
            {session.worktree && <GitFork aria-label={`Worktree ${session.worktree.branch}`} className="size-3 shrink-0 text-faint" />}
          </span>
        </button>
      </ContextMenuTrigger>
      <SessionMenuContent variant="context" session={session} project={project} />
    </ContextMenu>
  )
}

interface PanelProps {
  project: Project
  autoFocus: boolean
  panelRef: RefObject<HTMLElement | null>
  /** Con una ricerca, dei filtri o una selezione in corso il pannello non si chiude da solo. */
  busy: MutableRefObject<boolean>
  onClose: () => void
  onPointerEnter: () => void
  onPointerLeave: () => void
}

function AllSessionsPanel({ project, autoFocus, panelRef, busy, onClose, onPointerEnter, onPointerLeave }: PanelProps) {
  const sessions = useApp((s) => s.sessions)
  const agents = useApp((s) => s.agents)
  const archiveSession = useApp((s) => s.archiveSession)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [agent, setAgent] = useState<string | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  busy.current = Boolean(query || agent || branch || status !== 'all' || checked.size > 0)

  const all = useMemo(
    () => Object.values(sessions).filter((s) => s.projectId === project.id && !s.archived).sort((a, b) => lastTouched(b) - lastTouched(a)),
    [sessions, project.id]
  )
  const agentOptions = [...new Set(all.map((s) => s.agent))].map((id) => ({ id: id as string, label: agents.find((a) => a.agent === id)?.name ?? id }))
  const branchOptions = [...new Set(all.flatMap((s) => (s.branch ? [s.branch] : [])))].sort().map((id) => ({ id, label: id }))

  const needle = query.trim().toLowerCase()
  const shown = all.filter(
    (s) =>
      matchesStatus(s, status) &&
      (!agent || s.agent === agent) &&
      (!branch || s.branch === branch) &&
      (!needle || s.title.toLowerCase().includes(needle) || (s.branch ?? '').toLowerCase().includes(needle))
  )

  const now = Date.now()
  const days: { key: string; label: string; items: SessionSummary[] }[] = []
  for (const session of shown) {
    const key = dayKey(lastTouched(session))
    const last = days[days.length - 1]
    if (last?.key === key) last.items.push(session)
    else days.push({ key, label: dayLabel(lastTouched(session), now), items: [session] })
  }

  // Una sessione archiviata o ripartita nel frattempo esce dalla selezione.
  const selected = all.filter((s) => checked.has(s.id) && canArchive(s))
  const eligible = shown.filter(canArchive)
  const allChecked = eligible.length > 0 && eligible.every((s) => checked.has(s.id))

  const toggle = (id: string) => {
    setConfirming(false)
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = () => {
    setConfirming(false)
    setChecked(allChecked ? new Set() : new Set(eligible.map((s) => s.id)))
  }
  const archiveSelected = () => {
    for (const session of selected) archiveSession(session.id)
    setChecked(new Set())
    setConfirming(false)
  }

  const button = 'h-6 rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

  return (
    <aside
      ref={panelRef}
      data-all-sessions
      aria-label={t('All sessions')}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      data-native-overlay
      className="no-drag fixed inset-y-0 left-[var(--sidebar-w,262px)] z-40 flex w-[320px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-[0_12px_32px_rgb(0_0_0/.32)] duration-150 animate-in fade-in-0 slide-in-from-left-2 motion-reduce:animate-none"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 pr-2 pl-4">
        <h2 className="text-sm font-semibold">{t('All sessions')}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{all.length}</span>
        <button type="button" aria-label={t('Close')} onClick={onClose} className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 border-b border-sidebar-border px-3 pb-2.5">
        <label className="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2 focus-within:ring-2 focus-within:ring-ring/50">
          <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus={autoFocus}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('Search by title or branch')}
            aria-label={t('Search sessions')}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
        </label>
        <div className="flex flex-wrap items-center gap-0.5">
          {STATUS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={status === item.id}
              onClick={() => setStatus(item.id)}
              className={cn(chip, status === item.id ? 'bg-sidebar-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground')}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          {agentOptions.length > 1 && <FilterMenu label={t('Any agent')} value={agent} options={agentOptions} onChange={setAgent} />}
          {branchOptions.length > 1 && <FilterMenu label={t('Any branch')} value={branch} options={branchOptions} onChange={setBranch} />}
          {eligible.length > 0 && (
            <label className="ml-auto flex h-6 shrink-0 items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <input type="checkbox" checked={allChecked} onChange={toggleAll} className="size-3.5 accent-primary" />
              {t('Select all')}
            </label>
          )}
        </div>
      </div>

      {selected.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 border-b border-sidebar-border px-3 py-1.5 text-xs">
          {confirming ? (
            <>
              <span className="min-w-0 flex-1 truncate">{plural(selected.length, 'Archive this session?', 'Archive these {n} sessions?')}</span>
              <button type="button" onClick={archiveSelected} className={cn(button, 'bg-primary font-medium text-primary-foreground hover:opacity-90')}>
                {t('Archive')}
              </button>
              <button type="button" onClick={() => setConfirming(false)} className={cn(button, 'hover:bg-sidebar-accent')}>
                {t('Cancel')}
              </button>
            </>
          ) : (
            <>
              <span className="flex-1 tabular-nums">{t('{n} selected', { n: selected.length })}</span>
              <button type="button" onClick={() => setChecked(new Set())} className={cn(button, 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground')}>
                {t('Clear selection')}
              </button>
              <button type="button" onClick={() => setConfirming(true)} className={cn(button, 'flex items-center gap-1 border border-input hover:bg-sidebar-accent')}>
                <Archive className="size-3" />
                {t('Archive')}
              </button>
            </>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {shown.length === 0 && <p className="mt-8 text-center text-sm text-muted-foreground">{t('No sessions match these filters.')}</p>}
        {days.map((day) => (
          <section key={day.key} className="mt-3">
            <h3 className="mb-1 pl-2 text-xs font-semibold text-muted-foreground first-letter:uppercase">{day.label}</h3>
            <div className="flex flex-col gap-1">
              {day.items.map((session) => (
                <SessionListRow key={session.id} session={session} project={project} checked={checked.has(session.id)} selecting={selected.length > 0} onToggle={() => toggle(session.id)} onOpen={onClose} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  )
}

/** Riga "All sessions · N": al passaggio apre il pannello, un clic lo tiene aperto e porta il cursore nella ricerca. */
export function AllSessionsButton({ project, count }: { project: Project; count: number }) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement | null>(null)
  const busy = useRef(false)

  const close = () => {
    window.clearTimeout(timer.current)
    setOpen(false)
    setPinned(false)
    busy.current = false
  }
  const hoverIn = () => {
    window.clearTimeout(timer.current)
    if (!open) timer.current = window.setTimeout(() => setOpen(true), 120)
  }
  const hoverOut = () => {
    window.clearTimeout(timer.current)
    if (pinned) return
    timer.current = window.setTimeout(() => {
      // Un menu aperto dal pannello sta fuori dal pannello: non conta come "uscito".
      if (busy.current || panel.current?.querySelector('[data-popup-open]')) return
      setOpen(false)
    }, 240)
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element
      if (panel.current?.contains(target) || trigger.current?.contains(target) || target.closest('[role="menu"]')) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="menu"]')) return
      event.stopPropagation()
      close()
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        onClick={() => {
          window.clearTimeout(timer.current)
          if (open && pinned) close()
          else {
            setOpen(true)
            setPinned(true)
          }
        }}
        className={cn(
          'ml-5 flex min-h-7 items-center justify-between rounded-md pr-2 pl-2.5 text-left text-xs text-muted-foreground outline-none hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
          open && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
        )}
      >
        {t('All sessions · {n}', { n: count })}
        <ChevronRight aria-hidden className="size-3" />
      </button>
      {open && <AllSessionsPanel project={project} autoFocus={pinned} panelRef={panel} busy={busy} onClose={close} onPointerEnter={hoverIn} onPointerLeave={hoverOut} />}
    </>
  )
}
