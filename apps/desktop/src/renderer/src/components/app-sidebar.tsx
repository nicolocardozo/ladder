import { ChevronLeft, ChevronRight, Ellipsis, Folder, FolderOpen, FolderPlus, GitFork, GitPullRequest, Inbox, PanelLeft, Plus, Search, Settings, SquarePen, SquareTerminal, UserRound, X, type LucideIcon } from 'lucide-react'
import { forwardRef, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import type { Project, SessionSummary } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { IconButton } from '@/components/icon-button'
import { GroupMenuContent, ProjectMenuContent, RemoveProjectDialog, SessionMenuContent } from '@/components/session-menu'
import { AgentMark, useAgentLine } from '@/components/agent-mark'
import { AllSessionsButton } from '@/components/all-sessions'
import { runningSubagents } from '@/components/agent-map'
import { InboxPanel } from '@/components/inbox'
import { ProjectBadges, RunningRing, SessionGlyph, UnreadCount, WaitingCount } from '@/components/status'
import { Kbd } from '@/components/ui/kbd'
import { MarqueeText } from '@/components/ui/marquee-text'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSettings } from '@/hooks/use-theme'
import { request, send } from '@/lib/host-client'
import { noteTone, prNote, projectAttention, sessionNote, sessionState, sidebarSessions } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { canNavigate, useApp, type AwaySummary } from '@/store/app-store'

/** Elemento che aveva il focus prima di aprire "In attesa": ci torna alla chiusura (il composer, con la bozza). */
let focusBeforeInbox: HTMLElement | null = null
let pointerAt = 0

/** Al clic il focus passa al pulsante prima che il popover si apra: si ricorda dov'era un attimo prima. */
function rememberFocus(): void {
  const active = document.activeElement
  focusBeforeInbox = active instanceof HTMLElement && active !== document.body ? active : null
  pointerAt = Date.now()
}

export function openInbox(): void {
  const state = useApp.getState()
  rememberFocus()
  if (!state.sidebarOpen) state.toggleSidebar()
  state.setInboxOpen(true)
}



export async function addProjectFromDialog(): Promise<void> {
  const path = await window.ladder?.pickFolder()
  if (!path) return
  const project = await request<{ id: string }>({ type: 'project.add', path })
  useApp.getState().select({ kind: 'new', projectId: project.id })
}

/** Pulsante per riaprire la sidebar, nella barra in alto quando è nascosta. */
export function ShowSidebarButton() {
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  return <IconButton icon={PanelLeft} label={t('Show sidebar')} shortcut="⌘B" onClick={toggleSidebar} className="hover:bg-accent" />
}

export function AppSidebar() {
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const drafts = useApp((s) => s.drafts)
  const selection = useApp((s) => s.selection)
  const select = useApp((s) => s.select)
  const selectProject = useApp((s) => s.selectProject)
  const renaming = useApp((s) => s.renaming)
  const ui = useApp((s) => s.ui)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const setPaletteOpen = useApp((s) => s.setPaletteOpen)
  const navigate = useApp((s) => s.navigate)
  const canBack = useApp((s) => canNavigate(s, -1))
  const canForward = useApp((s) => canNavigate(s, 1))
  const inboxOpen = useApp((s) => s.inboxOpen)
  const setInboxOpen = useApp((s) => s.setInboxOpen)
  const away = useApp((s) => s.away)
  const [removing, setRemoving] = useState<Project | null>(null)

  const byProject = useMemo(() => {
    const known = new Set(projects.map((p) => p.id))
    const map = new Map<string, SessionSummary[]>()
    for (const session of Object.values(sessions)) {
      if (session.archived || !known.has(session.projectId)) continue
      const list = map.get(session.projectId) ?? []
      list.push(session)
      map.set(session.projectId, list)
    }
    // Ordine stabile: per data di creazione, la più recente in alto. Lo stato non sposta le righe.
    for (const list of map.values()) list.sort((a, b) => b.createdAt - a.createdAt)
    return map
  }, [sessions, projects])

  let waitingTotal = 0
  let unreadTotal = 0
  for (const list of byProject.values()) {
    waitingTotal += list.reduce((n, s) => n + (s.run === 'waiting' ? Math.max(1, s.openRequests) : 0), 0)
    unreadTotal += list.filter((s) => sessionState(s) === 'unread' || (s.run === 'error' && s.unread)).length
  }

  return (
    <aside className="flex h-full w-[262px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground select-none">
      {/* Barra del titolo: lo spazio a sinistra lascia posto ai semafori di macOS. */}
      <div className="drag flex h-11 shrink-0 items-center gap-0.5 pr-2 pl-[82px]">
        <IconButton icon={PanelLeft} label={t('Hide sidebar')} shortcut="⌘B" onClick={toggleSidebar} />
        <IconButton icon={Search} label={t('Search')} shortcut="⌘K" onClick={() => setPaletteOpen(true)} />
        <span className="flex-1" />
        <HistoryButton icon={ChevronLeft} label={t('Back')} shortcut="⌘[" disabled={!canBack} onClick={() => navigate(-1)} />
        <HistoryButton icon={ChevronRight} label={t('Forward')} shortcut="⌘]" disabled={!canForward} onClick={() => navigate(1)} />
      </div>

      <nav className="flex flex-col gap-px px-2 pt-1" aria-label={t('Actions')}>
        <SidebarAction
          icon={SquarePen}
          label={t('New chat')}
          trailing={<Kbd className="text-muted-foreground">⌘N</Kbd>}
          active={selection.kind === 'new'}
          onClick={() => select({ kind: 'new', projectId: selection.projectId ?? projects[0]?.id ?? null })}
        />
        <Popover
          open={inboxOpen}
          onOpenChange={(open) => {
            // Da tastiera (Invio sul pulsante) non c'è stato un clic: il focus torna al pulsante.
            if (open && Date.now() - pointerAt > 1000) focusBeforeInbox = null
            setInboxOpen(open)
          }}
        >
          <PopoverTrigger
            render={
              <SidebarAction
                icon={Inbox}
                label={t('Waiting')}
                active={inboxOpen}
                onPointerDown={() => !inboxOpen && rememberFocus()}
                trailing={
                  waitingTotal > 0 ? (
                    <WaitingCount count={waitingTotal} label={plural(waitingTotal, '{n} pending request', '{n} pending requests')} />
                  ) : unreadTotal > 0 ? (
                    <UnreadCount count={unreadTotal} label={t('{n} unread', { n: unreadTotal })} />
                  ) : null
                }
              />
            }
          />
          <PopoverContent
            side="right"
            align="start"
            sideOffset={10}
            className="w-[460px] gap-0 overflow-hidden p-0"
            // Chiuso il pannello, il focus torna dov'era: di solito il composer, con il cursore al suo posto.
            // Se intanto hai aperto un'altra sessione (Apri, ⌘⇧A), il focus resta dove l'ha messo lei.
            finalFocus={() => (focusBeforeInbox?.isConnected ? focusBeforeInbox : false)}
          >
            <InboxPanel />
          </PopoverContent>
        </Popover>
      </nav>

      <div className="flex items-center justify-between pt-5 pr-3 pb-1 pl-4 text-xs text-muted-foreground">
        <span>{t('Projects')}</span>
        <IconButton icon={FolderPlus} label={t('Add project')} className="size-6" onClick={() => void addProjectFromDialog()} />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1.5 px-2 pb-3">
          {projects.length === 0 && (
            <button
              type="button"
              onClick={() => void addProjectFromDialog()}
              className="mx-1 mt-1 rounded-md border border-dashed border-sidebar-border px-3 py-3 text-left text-sm text-muted-foreground outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {t('Add a project folder to get started.')}
            </button>
          )}
          {projects.map((project) => {
            // Si apre solo il progetto selezionato: le righe sotto sono sempre quelle delle tab in alto.
            const open = project.id === selection.projectId
            const all = byProject.get(project.id) ?? []
            const attention = projectAttention(all)
            const FolderIcon = open ? FolderOpen : Folder
            const isSelected = (id: string) => selection.kind === 'session' && selection.sessionId === id
            const groups = ui[project.id]?.groups ?? []
            const groupOf = ui[project.id]?.groupOf ?? {}
            const inGroup = (id: string) => all.filter((s) => groupOf[s.id] === id)
            const free = all.filter((s) => !groups.some((g) => g.id === groupOf[s.id]))
            const list = open ? sidebarSessions(free, (s) => isSelected(s.id) || s.id === renaming || Boolean(drafts[s.id]?.trim())) : []
            return (
              <div key={project.id} className="flex flex-col gap-1">
                <div className="group/project relative">
                  <ContextMenu>
                    <ContextMenuTrigger
                      render={<button type="button" />}
                      aria-expanded={open}
                      aria-current={open ? 'true' : undefined}
                      onClick={(event) => {
                        // Un clic sul simbolo di stato di un altro progetto apre la sessione che lo ha generato.
                        if (!open && attention.target && (event.target as HTMLElement).closest('[data-attention]')) {
                          useApp.getState().openSessionAt(attention.target.id, attention.target.request?.id ?? null)
                          return
                        }
                        if (!open) selectProject(project.id)
                      }}
                      title={project.path}
                      className={cn(
                        'flex min-h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none',
                        'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-sidebar-accent/60',
                        open && 'bg-sidebar-accent/50 font-medium text-sidebar-accent-foreground'
                      )}
                    >
                      <FolderIcon className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
                      <span className="truncate">{project.name}</span>
                      <span className="ml-auto flex items-center group-hover/project:invisible group-has-[:focus-visible]/project:invisible">
                        {open ? attention.running && <RunningRing /> : <ProjectBadges attention={attention} />}
                      </span>
                    </ContextMenuTrigger>
                    <ProjectMenuContent project={project} onRemove={() => setRemoving(project)} />
                  </ContextMenu>
                  <IconButton
                    icon={Plus}
                    label={t('New chat in {project}', { project: project.name })}
                    onClick={() => select({ kind: 'new', projectId: project.id })}
                    className="absolute top-[3px] right-[3px] size-6 opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100"
                  />
                </div>

                {open && away[project.id] && <AwayRow projectId={project.id} summary={away[project.id]} />}

                {open && groups.map((group) => <SessionGroup key={group.id} project={project} group={group} sessions={inGroup(group.id)} isSelected={isSelected} />)}

                {list.map((session) => (
                  <SessionRow key={session.id} session={session} project={project} selected={isSelected(session.id)} hasDraft={Boolean(drafts[session.id]?.trim())} />
                ))}

                {open && all.length === 0 && <p className="ml-5 py-1 pl-2.5 text-xs text-faint">{t('No sessions. Press ⌘N to start.')}</p>}

                {open && list.length < free.length && <AllSessionsButton project={project} count={all.length} />}
              </div>
            )
          })}
        </div>
      </ScrollArea>

      <footer className="flex items-center gap-1 border-t border-sidebar-border p-2">
        <AccountButton />
        <IconButton icon={Settings} label={t('Settings')} shortcut="⌘," onClick={() => useSettings.getState().setSettingsOpen(true)} />
      </footer>

      <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
    </aside>
  )
}

interface SessionRowProps {
  session: SessionSummary
  project: Project
  selected: boolean
  hasDraft: boolean
  /** Dentro un gruppo: un livello più a destra. */
  nested?: boolean
}

/** Gruppo di chat creato da te: si apre e si chiude, e da chiuso mostra quello che ti aspetta. */
function SessionGroup({ project, group, sessions, isSelected }: { project: Project; group: { id: string; name: string; collapsed?: boolean }; sessions: SessionSummary[]; isSelected: (id: string) => boolean }) {
  const toggleGroup = useApp((s) => s.toggleGroup)
  const renameGroup = useApp((s) => s.renameGroup)
  const stopRenameGroup = useApp((s) => s.stopRenameGroup)
  const startRenameGroup = useApp((s) => s.startRenameGroup)
  const renaming = useApp((s) => s.renamingGroup === group.id)
  const drafts = useApp((s) => s.drafts)
  // La sessione aperta resta sempre visibile, anche in un gruppo chiuso.
  const open = !group.collapsed || sessions.some((s) => isSelected(s.id))
  return (
    <div className="flex flex-col gap-1">
      <ContextMenu disabled={renaming}>
        <ContextMenuTrigger className="ml-5 rounded-md">
          {renaming ? (
            <GroupNameField
              name={group.name}
              onDone={(name) => {
                if (name) renameGroup(project.id, group.id, name)
                stopRenameGroup()
              }}
            />
          ) : (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => toggleGroup(project.id, group.id)}
              onDoubleClick={() => startRenameGroup(group.id)}
              className="flex min-h-7 w-full items-center gap-1.5 rounded-md pr-2 pl-2 text-left text-xs font-medium text-muted-foreground outline-none hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <ChevronRight aria-hidden className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
              <span className="truncate">{group.name}</span>
              <span className="font-normal text-faint tabular-nums">{sessions.length}</span>
              {!open && <ProjectBadges attention={projectAttention(sessions)} />}
            </button>
          )}
        </ContextMenuTrigger>
        <GroupMenuContent projectId={project.id} groupId={group.id} />
      </ContextMenu>
      {open && sessions.map((session) => <SessionRow key={session.id} session={session} project={project} selected={isSelected(session.id)} hasDraft={Boolean(drafts[session.id]?.trim())} nested />)}
    </div>
  )
}

/** Nome del gruppo nella riga. Invio o clic altrove salva, Esc lascia quello di prima. */
function GroupNameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  const finish = (save: boolean) => {
    if (finished.current) return
    finished.current = true
    onDone(save ? value.trim() || null : null)
  }
  return (
    <input
      ref={inputRef}
      value={value}
      aria-label={t('Group name')}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') finish(true)
        else if (event.key === 'Escape') {
          event.stopPropagation()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
      className="h-7 w-full rounded-md bg-sidebar-accent px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    />
  )
}

/** Riga di una sessione: clic per aprirla, clic destro o "…" per le azioni, doppio clic per rinominarla. */
function SessionRow({ session, project, selected, hasDraft, nested }: SessionRowProps) {
  const select = useApp((s) => s.select)
  const renaming = useApp((s) => s.renaming === session.id)
  const startRename = useApp((s) => s.startRename)
  const stopRename = useApp((s) => s.stopRename)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const state = sessionState(session)
  const waiting = state === 'waiting'
  const note = sessionNote(session, hasDraft)
  const tone = noteTone(note.code)
  const [hovered, setHovered] = useState(false)
  // Senza simbolo di stato il titolo si riprende lo spazio a sinistra.
  const hasGlyph = state !== 'idle'

  return (
    <ContextMenu disabled={renaming}>
      <ContextMenuTrigger className={cn('group/row relative rounded-md', nested ? 'ml-9' : 'ml-5')} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
        {renaming ? (
          <div className="grid min-h-7 grid-cols-[12px_minmax(0,1fr)] items-center gap-2.5 rounded-md bg-sidebar-accent py-0.5 pr-1 pl-2.5">
            <span className="grid place-items-center">
              <SessionGlyph state={state} />
            </span>
            <RenameField
              session={session}
              onDone={(viaKeyboard) => {
                stopRename()
                // Con Invio o Esc il focus torna sulla riga; con un clic altrove resta dove l'utente l'ha messo.
                if (viaKeyboard) requestAnimationFrame(() => buttonRef.current?.focus())
              }}
            />
          </div>
        ) : (
          <>
            <button
              ref={buttonRef}
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => select({ kind: 'session', projectId: project.id, sessionId: session.id })}
              onDoubleClick={() => startRename(session.id)}
              title={[
                session.title,
                session.queuedReason ?? session.activity,
                session.estimated ? t('estimated status') : null,
                session.worktree?.branch,
                session.pr ? `PR #${session.pr.number}${prNote(session) ? ` · ${prNote(session)!.text}` : ''}` : null
              ]
                .filter(Boolean)
                .join(' · ')}
              className={cn(
                'relative grid w-full items-start gap-x-2 gap-y-1 rounded-lg py-2 pr-2.5 pl-2.5 text-left outline-none',
                hasGlyph ? 'grid-cols-[16px_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]',
                'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50',
                // Riga evidenziata mentre il suo menu (clic destro o "…") è aperto.
                'group-data-[popup-open]/row:bg-sidebar-accent/60 group-has-[[data-popup-open]]/row:bg-sidebar-accent/60',
                selected &&
                  'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent group-data-[popup-open]/row:bg-sidebar-accent group-has-[[data-popup-open]]/row:bg-sidebar-accent',
                // Ti aspetta: un fondo appena tinto d'ambra, oltre a icona ed etichetta.
                waiting && !selected && 'bg-attention/8'
              )}
            >
              {hasGlyph && (
                <span className="row-span-2 grid h-[18px] place-items-center">
                  <SessionGlyph state={state} />
                </span>
              )}
              <MarqueeText active={hovered} className={cn('text-sm', state === 'unread' ? 'font-semibold text-sidebar-accent-foreground' : selected && 'font-medium')}>
                {session.title}
              </MarqueeText>
              {/* Lascia il posto al pulsante "…" quando la riga è sotto il puntatore o ha il focus. */}
              <span
                className={cn(
                  'text-xs leading-[18px] whitespace-nowrap text-faint tabular-nums',
                  'group-hover/row:invisible group-has-[:focus-visible]/row:invisible group-has-[[data-popup-open]]/row:invisible',
                  tone === 'attention' && 'font-semibold text-attention',
                  tone === 'destructive' && 'font-semibold text-destructive',
                  tone === 'success' && 'font-medium text-success'
                )}
              >
                {note.code === 'draft' ? <i>{note.text}</i> : note.text}
              </span>
              <SessionMeta session={session} hasGlyph={hasGlyph} />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t('Actions for {title}', { title: session.title })}
                className={cn(
                  'absolute top-1 right-1 grid size-6 place-items-center rounded-sm text-muted-foreground opacity-0 outline-none',
                  'hover:bg-background/70 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50',
                  'group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 data-[popup-open]:bg-background/70 data-[popup-open]:opacity-100',
                  'dark:hover:bg-background/40 dark:data-[popup-open]:bg-background/40'
                )}
              >
                <Ellipsis className="size-[15px]" strokeWidth={1.75} />
              </DropdownMenuTrigger>
              <SessionMenuContent variant="dropdown" session={session} project={project} />
            </DropdownMenu>
          </>
        )}
      </ContextMenuTrigger>
      <SessionMenuContent variant="context" session={session} project={project} />
    </ContextMenu>
  )
}

/** Seconda riga: chi lavora (segno del provider e modello) e cosa sta facendo, o dove lavora. */
/** In basso a sinistra: con quale account lavorano gli agenti. Apre Impostazioni → Agenti, dove ci sono tutti. */
function AccountButton() {
  const agents = useApp((s) => s.agents)
  const linked = agents.filter((a) => a.kind === 'native' && (a.account || a.email))
  const email = linked.find((a) => a.email)?.email ?? null
  const plans = linked.flatMap((a) => (a.account ? [a.account] : []))
  const name = email ?? plans[0] ?? t('Accounts')
  const detail = (email ? plans : plans.slice(1)).join(' · ')
  return (
    <button
      type="button"
      onClick={() => useSettings.getState().openSection('agents')}
      title={[email, ...plans].filter(Boolean).join('\n') || undefined}
      className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
    >
      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground/10 text-xs font-semibold text-foreground">
        {email ? email.slice(0, 1).toUpperCase() : <UserRound className="size-3.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
    </button>
  )
}

function SessionMeta({ session, hasGlyph }: { session: SessionSummary; hasGlyph: boolean }) {
  const { name, model } = useAgentLine(session.agent, session.model)
  const agents = runningSubagents(session)
  const doing =
    session.queuedReason ??
    (session.run === 'running' || session.run === 'starting' || session.run === 'waiting' ? (session.request?.command ?? session.activity) : null) ??
    (session.mode === 'terminal' ? t('Terminal · {command}', { command: session.command ?? 'claude' }) : null) ??
    session.worktree?.branch ??
    null
  return (
    <span className={cn('col-span-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground', hasGlyph && 'col-start-2')}>
      {session.mode === 'terminal' ? <SquareTerminal aria-label={t('Terminal session')} className="size-3 shrink-0" /> : <AgentMark agent={session.agent} size={12} />}
      <span className="shrink-0">{session.mode === 'terminal' ? (session.command?.split(' ')[0] ?? 'claude') : (model ?? name)}</span>
      {doing && (
        <>
          <span aria-hidden className="text-faint">·</span>
          <span className="min-w-0 truncate">{doing}</span>
        </>
      )}
      {agents > 0 && <span aria-hidden className="text-faint">·</span>}
      {agents > 0 && (
        <span className="shrink-0 tabular-nums text-foreground/70" aria-label={plural(agents, '1 agent running', '{n} agents running')} title={plural(agents, '1 agent running', '{n} agents running')}>
          {plural(agents, '1 agent', '{n} agents')}
        </span>
      )}
      {session.worktree && <GitFork aria-label={`Worktree ${session.worktree.branch}`} className="size-3 shrink-0 text-faint" />}
      {session.pr && <GitPullRequest aria-label={`PR #${session.pr.number}`} className="size-3 shrink-0 text-faint" />}
    </span>
  )
}

/** Titolo modificabile nella riga. Invio salva, Esc annulla, uscire dal campo salva. */
function RenameField({ session, onDone }: { session: SessionSummary; onDone: (viaKeyboard: boolean) => void }) {
  const [value, setValue] = useState(session.title)
  const inputRef = useRef<HTMLInputElement>(null)
  const finished = useRef(false)

  useEffect(() => {
    // Il menu da cui arriva il comando si sta chiudendo: il focus si prende al frame successivo.
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const finish = (save: boolean, viaKeyboard: boolean) => {
    if (finished.current) return
    finished.current = true
    const title = value.trim()
    if (save && title && title !== session.title) {
      // Ottimista: il nuovo titolo si vede subito, l'host lo conferma con session.upsert.
      useApp.setState((s) => ({ sessions: { ...s.sessions, [session.id]: { ...s.sessions[session.id], title } } }))
      send({ type: 'session.rename', sessionId: session.id, title })
    }
    onDone(viaKeyboard)
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(true, true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          finish(false, true)
        }
      }}
      onBlur={() => finish(true, false)}
      aria-label={t('Session title')}
      spellCheck={false}
      maxLength={200}
      className="h-6 w-full min-w-0 rounded-[5px] bg-background px-1.5 text-sm text-foreground ring-1 ring-ring/60 outline-none select-text"
    />
  )
}

interface HistoryButtonProps {
  icon: LucideIcon
  label: string
  shortcut: string
  disabled: boolean
  onClick: () => void
}

/** Indietro/Avanti: come IconButton, ma disattivabile. */
function HistoryButton({ icon: Icon, label, shortcut, disabled, onClick }: HistoryButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" disabled={disabled} />}
        aria-label={label}
        onClick={onClick}
        className={cn(
          'no-drag grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none',
          'hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:opacity-35'
        )}
      >
        <Icon className="size-[15px]" strokeWidth={1.75} />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        <span className="ml-1.5 font-mono text-xs opacity-70">{shortcut}</span>
      </TooltipContent>
    </Tooltip>
  )
}

interface SidebarActionProps extends Omit<ComponentPropsWithoutRef<'button'>, 'children'> {
  icon: LucideIcon
  label: string
  trailing?: ReactNode
  active?: boolean
}

/** Voce in cima alla sidebar. Inoltra ref e proprietà: "In attesa" la usa come trigger del popover. */
const SidebarAction = forwardRef<HTMLButtonElement, SidebarActionProps>(function SidebarAction({ icon: Icon, label, trailing, active, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={cn(
        'flex h-[30px] items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none',
        'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50',
        active && 'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent',
        className
      )}
    >
      <Icon className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
})

/** "Mentre eri via: 2 risposte, 1 sessione conclusa". Un clic apre la prima risposta da leggere. */
function AwayRow({ projectId, summary }: { projectId: string; summary: AwaySummary }) {
  const dismiss = useApp((s) => s.dismissAway)
  const parts = [
    summary.requests && plural(summary.requests, '{n} request', '{n} requests'),
    summary.replies && plural(summary.replies, '{n} reply', '{n} replies'),
    summary.errors && plural(summary.errors, '{n} error', '{n} errors'),
    summary.concluded && plural(summary.concluded, '{n} session done', '{n} sessions done')
  ].filter(Boolean)
  const openFirst = () => {
    const state = useApp.getState()
    const list = Object.values(state.sessions).filter((s) => s.projectId === projectId && !s.archived)
    const target =
      list.filter((s) => s.run === 'waiting').sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0))[0] ??
      list.filter((s) => s.unread).sort((a, b) => b.activityAt - a.activityAt)[0]
    if (target) state.openSessionAt(target.id, target.request?.id ?? null)
    dismiss(projectId)
  }
  return (
    <div role="status" className="group/away relative ml-5 flex min-h-7 items-center rounded-md bg-sidebar-accent/45 pr-1 pl-2.5 text-xs text-muted-foreground">
      <button type="button" onClick={openFirst} className="min-w-0 flex-1 truncate py-1 text-left outline-none hover:text-foreground focus-visible:underline">
        <span className="font-medium text-sidebar-foreground">{t('While you were away:')}</span> {parts.join(', ')}
      </button>
      <button
        type="button"
        aria-label={t('Hide summary')}
        onClick={() => dismiss(projectId)}
        className="grid size-5 shrink-0 place-items-center rounded text-faint outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
