import { Check, ChevronLeft, ChevronRight, Ellipsis, Folder, FolderInput, FolderMinus, FolderOpen, FolderPlus, GitFork, GitPullRequest, Globe, Inbox, ListPlus, PanelLeft, Plus, Search, Settings, Sparkles, SquarePen, SquareTerminal, UserRound, X, type LucideIcon } from 'lucide-react'
import { useShortcutsRevision } from '@/lib/use-shortcuts'
import { shortcutLabel } from '@shared/shortcuts'
import { forwardRef, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId, AgentStatus, ConnectionStatus, Project, ProjectGroup, SessionSummary } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { IconButton } from '@/components/icon-button'
import { GroupMenuContent, ProjectGroupMenuContent, ProjectMenuContent, RemoveProjectDialog, SessionMenuContent } from '@/components/session-menu'
import { AgentMark, useAgentLine } from '@/components/agent-mark'
import { isDefaultProfileId, isProfileAgent, normalizeProfileId, profilesOf, projectProfileId, useSessionProfileName } from '@/lib/profiles'
import { AllSessionsButton } from '@/components/all-sessions'
import { runningSubagents } from '@/components/agent-map'
import { InboxPanel } from '@/components/inbox'
import { ProjectBadges, RunningRing, SessionGlyph, UnreadCount, WaitingCount } from '@/components/status'
import { Kbd } from '@/components/ui/kbd'
import { MarqueeText } from '@/components/ui/marquee-text'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSettings } from '@/hooks/use-theme'
import { request, send } from '@/lib/host-client'
import { NO_SECTION, startProjectDrag, startSectionDrag, useProjectDrag } from '@/lib/project-drag'
import { layoutProjects, type ProjectLayout } from '@/lib/project-groups'
import { NO_GROUP, pickClick, startSessionDrag, useSessionDrag, usePick } from '@/lib/session-drag'
import { isUnreadState, noteTone, prNote, projectAttention, sessionNote, sessionState, sidebarSessions } from '@/lib/session-state'
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
  useShortcutsRevision()
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  return <IconButton icon={PanelLeft} label={t('Show sidebar')} shortcut={shortcutLabel('sidebar.toggle')} onClick={toggleSidebar} className="hover:bg-accent" />
}

export function AppSidebar() {
  useShortcutsRevision()
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
  const projectGroups = useApp((s) => s.projectGroups)
  const sidebarNotice = useApp((s) => s.sidebarNotice)
  const sidebarNoticeTone = useApp((s) => s.sidebarNoticeTone)
  const clearSidebarNotice = useApp((s) => s.clearSidebarNotice)
  const createProjectGroup = useApp((s) => s.createProjectGroup)
  const pick = usePick()
  const dragOver = useSessionDrag((s) => (s.active ? s.over : null))
  const dragging = useProjectDrag((s) => (s.active?.kind === 'project' ? s.active.id : null))
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

  const layout = useMemo(() => layoutProjects(projects, projectGroups), [projects, projectGroups])
  /** Stato aggregato delle sessioni di più progetti: serve alla testata di una sezione chiusa. */
  const attentionOf = (list: Project[]) => projectAttention(list.flatMap((p) => byProject.get(p.id) ?? []))

  let waitingTotal = 0
  let unreadTotal = 0
  for (const list of byProject.values()) {
    waitingTotal += list.reduce((n, s) => n + (s.run === 'waiting' ? Math.max(1, s.openRequests) : 0), 0)
    unreadTotal += list.filter((s) => isUnreadState(sessionState(s)) || (s.run === 'error' && s.unread)).length
  }

  /** Un progetto con le sue sessioni. `slot` è la linea che mostra dove cadrebbe un progetto trascinato. */
  const renderProject = (project: Project, slot: 'before' | 'after' | null) => {
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
    // Righe visibili, dall'alto in basso: serve alla selezione con ⇧.
    const order = open ? [...groups.filter((g) => !g.collapsed || inGroup(g.id).some((s) => isSelected(s.id))).flatMap((g) => inGroup(g.id)), ...list].map((s) => s.id) : []
    const picked = pick.projectId === project.id ? pick.ids.filter((id) => all.some((s) => s.id === id)) : []
    return (
      <div key={project.id} className={cn('relative flex flex-col gap-1', dragging === project.id && 'opacity-50')}>
        {slot && <DropLine position={slot} />}
        <div
          data-project-row={project.id}
          data-drop-group={NO_GROUP}
          data-drop-project={project.id}
          className={cn('group/project relative rounded-md', dragOver === NO_GROUP && open && 'bg-sidebar-accent/60 ring-1 ring-ring/50')}
        >
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
              onPointerDown={(event) => {
                if (event.button !== 0 || event.metaKey || event.shiftKey || event.ctrlKey) return
                startProjectDrag({ event, id: project.id, label: project.name })
              }}
              title={project.path}
              className={cn(
                'flex min-h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none in-data-[sidebar-density=compact]:min-h-7',
                'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-sidebar-accent/60',
                open && 'bg-sidebar-accent/50 font-medium text-sidebar-accent-foreground'
              )}
            >
              <FolderIcon className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
              <span className="truncate">{project.name}</span>
              <span className="ml-auto flex items-center group-hover/project:invisible group-has-[:focus-visible]/project:invisible group-has-[[data-popup-open]]/project:invisible">
                {open ? attention.running && <RunningRing /> : <ProjectBadges attention={attention} />}
              </span>
            </ContextMenuTrigger>
            <ProjectMenuContent project={project} onRemove={() => setRemoving(project)} />
          </ContextMenu>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t('Actions for {title}', { title: project.name })}
              className={cn(
                'absolute top-[3px] right-[29px] grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 outline-none',
                'hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50',
                'group-hover/project:opacity-100 data-[popup-open]:bg-sidebar-accent data-[popup-open]:opacity-100'
              )}
            >
              <Ellipsis className="size-[15px]" strokeWidth={1.75} />
            </DropdownMenuTrigger>
            <ProjectMenuContent variant="dropdown" project={project} onRemove={() => setRemoving(project)} />
          </DropdownMenu>
          <IconButton
            icon={Plus}
            label={t('New chat in {project}', { project: project.name })}
            onClick={() => select({ kind: 'new', projectId: project.id })}
            className="absolute top-[3px] right-[3px] size-6 opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100"
          />
        </div>

        {open && away[project.id] && <AwayRow projectId={project.id} summary={away[project.id]} />}

        {open && picked.length > 0 && <PickBar project={project} ids={picked} groups={groups} groupOf={groupOf} />}

        {open && groups.map((group) => <SessionGroup key={group.id} project={project} group={group} sessions={inGroup(group.id)} isSelected={isSelected} order={order} picked={picked} />)}

        {list.length > 0 && (
          <div data-drop-group={NO_GROUP} data-drop-project={project.id} className={cn('flex flex-col gap-1 rounded-md', dragOver === NO_GROUP && 'bg-sidebar-accent/60 ring-1 ring-ring/50')}>
            {list.map((session) => (
              <SessionRow key={session.id} session={session} project={project} selected={isSelected(session.id)} hasDraft={Boolean(drafts[session.id]?.trim())} order={order} picked={picked} />
            ))}
          </div>
        )}

        {open && all.length === 0 && <p className="ml-5 py-1 pl-2.5 text-xs text-faint">{t('No sessions. Press ⌘N to start.')}</p>}

        {open && list.length < free.length && <AllSessionsButton project={project} count={all.length} />}
      </div>
    )
  }

  return (
    <aside
      className="flex h-full w-[262px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground select-none"
      // Esc toglie la selezione multipla, a meno che non serva a chiudere un menu o un campo.
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && pick.ids.length > 0 && !(event.target instanceof HTMLInputElement)) pick.clear()
      }}
    >
      {/* Barra del titolo: lo spazio a sinistra lascia posto ai semafori di macOS. */}
      <div className="drag flex h-11 shrink-0 items-center gap-0.5 pr-2 pl-[82px]">
        <IconButton icon={PanelLeft} label={t('Hide sidebar')} shortcut={shortcutLabel('sidebar.toggle')} onClick={toggleSidebar} />
        <IconButton icon={Search} label={t('Search')} shortcut={shortcutLabel('palette.toggle')} onClick={() => setPaletteOpen(true)} />
        <span className="flex-1" />
        <HistoryButton icon={ChevronLeft} label={t('Back')} shortcut={shortcutLabel('nav.back')} disabled={!canBack} onClick={() => navigate(-1)} />
        <HistoryButton icon={ChevronRight} label={t('Forward')} shortcut={shortcutLabel('nav.forward')} disabled={!canForward} onClick={() => navigate(1)} />
      </div>

      <nav className="flex flex-col gap-px px-2 pt-1" aria-label={t('Actions')}>
        <SidebarAction
          icon={SquarePen}
          label={t('New chat')}
          trailing={<Kbd className="text-muted-foreground">{shortcutLabel('chat.new')}</Kbd>}
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
            // Abbastanza a destra da staccarsi dal bordo della sidebar: i due fili non devono coincidere.
            sideOffset={16}
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
        <span className="flex items-center">
          <IconButton icon={ListPlus} label={t('New section')} className="size-6" onClick={() => void createProjectGroup()} />
          <IconButton icon={FolderPlus} label={t('Add project')} className="size-6" onClick={() => void addProjectFromDialog()} />
        </span>
      </div>

      <ScrollArea data-project-list className="min-h-0 flex-1">
        <div className="flex flex-col gap-1.5 px-2 pb-3">
          {sidebarNotice && (
            <div role={sidebarNoticeTone === 'error' ? 'alert' : 'status'} className={cn('flex min-h-7 items-center rounded-md bg-sidebar-accent/45 pr-1 pl-2.5 text-xs', sidebarNoticeTone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
              <span className="min-w-0 flex-1 py-1">{sidebarNotice}</span>
              <button
                type="button"
                aria-label={t('Dismiss')}
                onClick={clearSidebarNotice}
                className="grid size-5 shrink-0 place-items-center rounded text-faint outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X className="size-3" />
              </button>
            </div>
          )}
          {projects.length === 0 && (
            <button
              type="button"
              onClick={() => void addProjectFromDialog()}
              className="mx-1 mt-1 rounded-md border border-dashed border-sidebar-border px-3 py-3 text-left text-sm text-muted-foreground outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {t('Add a project folder to get started.')}
            </button>
          )}
          <ProjectLists layout={layout} renderProject={renderProject} attentionOf={attentionOf} selectedId={selection.projectId} />
        </div>
      </ScrollArea>

      <footer className="flex items-center gap-1 border-t border-sidebar-border p-2">
        <AccountButton />
        <IconButton icon={Settings} label={t('Settings')} shortcut={shortcutLabel('app.openSettings')} onClick={() => useSettings.getState().setSettingsOpen(true)} />
      </footer>

      <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
      <SessionDragGhost />
      <ProjectDragGhost />
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
  /** Righe visibili del progetto, per la selezione con ⇧. */
  order: string[]
  /** Sessioni del progetto selezionate con ⌘ e ⇧ clic. */
  picked: string[]
}

/** Gruppo di chat creato da te: si apre e si chiude, e da chiuso mostra quello che ti aspetta. */
function SessionGroup({ project, group, sessions, isSelected, order, picked }: { project: Project; group: { id: string; name: string; collapsed?: boolean }; sessions: SessionSummary[]; isSelected: (id: string) => boolean; order: string[]; picked: string[] }) {
  const toggleGroup = useApp((s) => s.toggleGroup)
  const renameGroup = useApp((s) => s.renameGroup)
  const stopRenameGroup = useApp((s) => s.stopRenameGroup)
  const startRenameGroup = useApp((s) => s.startRenameGroup)
  const renaming = useApp((s) => s.renamingGroup === group.id)
  const drafts = useApp((s) => s.drafts)
  const dropping = useSessionDrag((s) => s.active !== null && s.over === group.id)
  // La sessione aperta resta sempre visibile, anche in un gruppo chiuso.
  const open = !group.collapsed || sessions.some((s) => isSelected(s.id))
  return (
    // Anche da chiuso il gruppo accetta le sessioni trascinate: la riga si apre da sola al rilascio.
    <div data-drop-group={group.id} data-drop-project={project.id} className={cn('flex flex-col gap-1 rounded-md', dropping && 'bg-sidebar-accent/60 ring-1 ring-ring/50')}>
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
      {open && sessions.map((session) => <SessionRow key={session.id} session={session} project={project} selected={isSelected(session.id)} hasDraft={Boolean(drafts[session.id]?.trim())} nested order={order} picked={picked} />)}
    </div>
  )
}

/** Con più sessioni selezionate: quante sono e dove spostarle. Esc o la × tolgono la selezione. */
function PickBar({ project, ids, groups, groupOf }: { project: Project; ids: string[]; groups: { id: string; name: string }[]; groupOf: Record<string, string> }) {
  const clear = usePick((s) => s.clear)
  const createGroup = useApp((s) => s.createGroup)
  const moveSessionsToGroup = useApp((s) => s.moveSessionsToGroup)
  const move = (groupId: string | null) => {
    moveSessionsToGroup(project.id, ids, groupId)
    clear()
  }
  return (
    <div role="group" aria-label={t('{n} selected', { n: ids.length })} className="ml-5 flex min-h-7 items-center gap-1 rounded-md bg-sidebar-accent/45 pr-1 pl-2.5 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate tabular-nums">{t('{n} selected', { n: ids.length })}</span>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex h-6 items-center gap-1 rounded px-1.5 text-xs text-foreground outline-none hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-background/60">
          <FolderInput aria-hidden className="size-3" />
          {t('Move to group')}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-52">
          {groups.map((group) => (
            <DropdownMenuItem key={group.id} className="gap-2 py-[5px] text-sm" onClick={() => move(group.id)}>
              <Check className={ids.every((id) => groupOf[id] === group.id) ? undefined : 'opacity-0'} />
              {group.name}
            </DropdownMenuItem>
          ))}
          {groups.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem
            className="gap-2 py-[5px] text-sm"
            onClick={() => {
              createGroup(project.id, ids)
              clear()
            }}
          >
            <FolderPlus />
            {t('New group')}
          </DropdownMenuItem>
          {ids.some((id) => groupOf[id]) && (
            <DropdownMenuItem className="gap-2 py-[5px] text-sm" onClick={() => move(null)}>
              <FolderMinus />
              {t('Remove from group')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        aria-label={t('Clear selection')}
        onClick={clear}
        className="grid size-5 shrink-0 place-items-center rounded text-faint outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

/** Etichetta che segue il puntatore mentre si trascina. Decorativa: lo spostamento da tastiera passa dai menu. */
function DragGhost({ label, x, y }: { label: string; x: number; y: number }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 z-50 max-w-[220px] truncate rounded-md bg-popover px-2 py-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{ transform: `translate3d(${x + 12}px, ${y + 12}px, 0)` }}
    >
      {label}
    </div>
  )
}

function SessionDragGhost() {
  const drag = useSessionDrag()
  return drag.active ? <DragGhost label={drag.active.label} x={drag.x} y={drag.y} /> : null
}

function ProjectDragGhost() {
  const drag = useProjectDrag()
  return drag.active ? <DragGhost label={drag.active.label} x={drag.x} y={drag.y} /> : null
}

/** Linea sottile che dice dove cadrebbe l'elemento trascinato. Non sposta le righe. */
function DropLine({ position }: { position: 'before' | 'after' }) {
  return <span aria-hidden className={cn('pointer-events-none absolute inset-x-2.5 z-10 h-0.5 rounded-full bg-ring', position === 'before' ? '-top-1' : '-bottom-1')} />
}

type Slot = 'before' | 'after' | null

interface ProjectListsProps {
  layout: ProjectLayout
  renderProject: (project: Project, slot: Slot) => ReactNode
  attentionOf: (projects: Project[]) => ReturnType<typeof projectAttention>
  selectedId: string | null
}

/** Progetti senza sezione in alto, poi le sezioni. Senza sezioni è la lista di sempre. */
function ProjectLists({ layout, renderProject, attentionOf, selectedId }: ProjectListsProps) {
  // Selettori separati: x e y cambiano a ogni pointermove e servono solo al ghost.
  const draggingProject = useProjectDrag((s) => (s.active?.kind === 'project' ? s.active.id : null))
  const draggingSection = useProjectDrag((s) => (s.active?.kind === 'section' ? s.active.id : null))
  const dragTarget = useProjectDrag(useShallow((s) => (s.active ? s.target : null)))
  const target = draggingProject ? dragTarget : null

  /** Righe di una zona, ognuna con la linea di rilascio se è lì che cadrebbe il progetto trascinato. */
  const rows = (zone: string, list: Project[]) => {
    const others = list.filter((p) => p.id !== draggingProject)
    const here = target && target.zone === zone && !target.collapsed ? target.index : -1
    return list.map((project) => {
      const at = others.indexOf(project)
      const slot: Slot = at < 0 ? null : at === here ? 'before' : here === others.length && at === others.length - 1 ? 'after' : null
      return renderProject(project, slot)
    })
  }

  const sectionIds = layout.sections.map((s) => s.group.id).filter((id) => id !== draggingSection)
  const sectionSlot = (id: string): Slot => {
    if (!draggingSection || !dragTarget) return null
    const at = sectionIds.indexOf(id)
    if (at < 0) return null
    return at === dragTarget.index ? 'before' : dragTarget.index === sectionIds.length && at === sectionIds.length - 1 ? 'after' : null
  }

  return (
    <>
      {(layout.ungrouped.length > 0 || (layout.sections.length > 0 && draggingProject)) && (
        <div data-project-zone={NO_SECTION} className="flex flex-col gap-1.5">
          {layout.ungrouped.length > 0 ? (
            rows(NO_SECTION, layout.ungrouped)
          ) : (
            <p className={cn('rounded-md border border-dashed border-sidebar-border px-2.5 py-1.5 text-xs text-faint', target?.zone === NO_SECTION && 'bg-sidebar-accent/60 ring-1 ring-ring/50')}>{t('No section')}</p>
          )}
        </div>
      )}
      {layout.sections.map(({ group, projects }) => (
        <ProjectSection
          key={group.id}
          group={group}
          count={projects.length}
          attention={attentionOf(group.collapsed ? projects.filter((p) => p.id !== selectedId) : projects)}
          containsSelected={projects.some((p) => p.id === selectedId)}
          dropping={target?.zone === group.id && (target.collapsed || projects.length === 0)}
          dragged={draggingSection === group.id}
          slot={sectionSlot(group.id)}
        >
          {rows(
            group.id,
            projects.filter((p) => !group.collapsed || p.id === selectedId)
          )}
          {projects.length === 0 && !group.collapsed && <p className="py-1 pl-2.5 text-xs text-faint">{t('No projects. Drag one here.')}</p>}
        </ProjectSection>
      ))}
    </>
  )
}

interface ProjectSectionProps {
  group: ProjectGroup
  count: number
  attention: ReturnType<typeof projectAttention>
  containsSelected: boolean
  dropping: boolean
  dragged: boolean
  slot: Slot
  children: ReactNode
}

/** Sezione di progetti creata da te: si apre e si chiude, si rinomina e si trascina; da chiusa mostra quello che ti aspetta. */
function ProjectSection({ group, count, attention, containsSelected, dropping, dragged, slot, children }: ProjectSectionProps) {
  const toggle = useApp((s) => s.toggleProjectGroup)
  const rename = useApp((s) => s.renameProjectGroup)
  const startRename = useApp((s) => s.startRenameProjectGroup)
  const stopRename = useApp((s) => s.stopRenameProjectGroup)
  const renaming = useApp((s) => s.renamingProjectGroup === group.id)
  // La sezione è aperta o chiusa solo per `collapsed`; il progetto selezionato resta visibile anche in una chiusa.
  const open = !group.collapsed
  const showChildren = open || containsSelected
  return (
    <div
      data-section={group.id}
      data-project-zone={group.id}
      data-collapsed={group.collapsed}
      className={cn('relative mt-1 flex flex-col gap-1.5 rounded-md', dragged && 'opacity-50', dropping && 'bg-sidebar-accent/60 ring-1 ring-ring/50')}
    >
      {slot && <DropLine position={slot} />}
      <div className="group/section relative">
        <ContextMenu disabled={renaming}>
          <ContextMenuTrigger className="rounded-md">
            {renaming ? (
              <GroupNameField
                name={group.name}
                label={t('Section name')}
                onDone={(name) => {
                  if (name) rename(group.id, name)
                  stopRename()
                }}
              />
            ) : (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(group.id)}
                onDoubleClick={() => startRename(group.id)}
                onPointerDown={(event) => {
                  if (event.button !== 0 || event.metaKey || event.shiftKey || event.ctrlKey) return
                  startSectionDrag({ event, id: group.id, label: group.name })
                }}
                className="flex min-h-7 w-full items-center gap-1.5 rounded-md pr-2 pl-2.5 text-left text-xs font-medium text-muted-foreground outline-none hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <ChevronRight aria-hidden className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
                <span className="truncate">{group.name}</span>
                <span className="font-normal text-faint tabular-nums">{count}</span>
                {!open && (
                  <span className="ml-auto flex items-center group-hover/section:invisible group-has-[:focus-visible]/section:invisible group-has-[[data-popup-open]]/section:invisible">
                    <ProjectBadges attention={attention} />
                  </span>
                )}
              </button>
            )}
          </ContextMenuTrigger>
          <ProjectGroupMenuContent groupId={group.id} />
        </ContextMenu>
        {!renaming && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t('Actions for {title}', { title: group.name })}
              className={cn(
                'absolute top-0.5 right-1 grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 outline-none',
                'hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50',
                'group-hover/section:opacity-100 data-[popup-open]:bg-sidebar-accent data-[popup-open]:opacity-100'
              )}
            >
              <Ellipsis className="size-[15px]" strokeWidth={1.75} />
            </DropdownMenuTrigger>
            <ProjectGroupMenuContent variant="dropdown" groupId={group.id} />
          </DropdownMenu>
        )}
      </div>
      {showChildren && <div className="flex flex-col gap-1.5 pl-2">{children}</div>}
    </div>
  )
}

/** Nome del gruppo nella riga. Invio o clic altrove salva, Esc lascia quello di prima. */
function GroupNameField({ name, label = t('Group name'), onDone }: { name: string; label?: string; onDone: (name: string | null) => void }) {
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
      aria-label={label}
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
function SessionRow({ session, project, selected, hasDraft, nested, order, picked }: SessionRowProps) {
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
  const isPicked = picked.includes(session.id)

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
              // Con una selezione in corso la riga si comporta da interruttore.
              aria-pressed={picked.length > 0 ? isPicked : undefined}
              onClick={(event) => {
                // ⌘⌥clic: apre la sessione in una colonna accanto a quella attiva.
                if (event.metaKey && event.altKey) {
                  useApp.getState().openSplit(project.id, session.id)
                  return
                }
                if (pickClick(event, project.id, order, session.id)) return
                select({ kind: 'session', projectId: project.id, sessionId: session.id })
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || event.metaKey || event.shiftKey || event.ctrlKey) return
                // Se la riga fa parte della selezione si trascinano tutte, altrimenti solo lei.
                const ids = isPicked ? picked : [session.id]
                startSessionDrag({ event, projectId: project.id, ids, label: ids.length > 1 ? plural(ids.length, '{n} session', '{n} sessions') : session.title })
              }}
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
                // Densità compatta (prefs.sidebarDensity, data-sidebar-density su <html>): righe più basse, stesso contenuto.
                'relative grid w-full items-start gap-x-2 gap-y-1 rounded-lg py-2 pr-2.5 pl-2.5 text-left outline-none in-data-[sidebar-density=compact]:gap-y-0.5 in-data-[sidebar-density=compact]:py-1',
                hasGlyph ? 'grid-cols-[16px_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]',
                'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50',
                // Riga evidenziata mentre il suo menu (clic destro o "…") è aperto.
                'group-data-[popup-open]/row:bg-sidebar-accent/60 group-has-[[data-popup-open]]/row:bg-sidebar-accent/60',
                selected &&
                  'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent group-data-[popup-open]/row:bg-sidebar-accent group-has-[[data-popup-open]]/row:bg-sidebar-accent',
                // Scelta per la selezione multipla ma non aperta: fondo più leggero e filo interno, per non confonderla con quella aperta.
                isPicked && !selected && 'bg-sidebar-accent/60 text-sidebar-accent-foreground ring-1 ring-ring/50 ring-inset',
                // Ti aspetta: un fondo appena tinto d'ambra, oltre a icona ed etichetta.
                waiting && !selected && !isPicked && 'bg-attention/8'
              )}
            >
              {hasGlyph && (
                <span className="row-span-2 grid h-[18px] place-items-center">
                  <SessionGlyph state={state} />
                </span>
              )}
              <MarqueeText active={hovered} className={cn('text-sm', isUnreadState(state) ? 'font-semibold text-sidebar-accent-foreground' : selected && 'font-medium', session.titleGenerating && 'animate-pulse motion-reduce:animate-none')}>
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

/** Account del profilo in uso per un agente: stato dell'agente, con il collegamento come riserva (un profilo appena creato non ha ancora lo stato). */
interface AccountEntry {
  agent: AgentId
  name: string
  profile: string | null
  account: string | null
  email: string | null
}

/**
 * Profilo in uso per un agente: quello della sessione aperta (se è di quell'agente), altrimenti quello scelto dal progetto.
 * Il profilo di una sessione non cambia dopo la creazione.
 */
function useAccountEntries(): AccountEntry[] {
  const agents = useApp((s) => s.agents)
  const profileAgents = useApp((s) => s.profileAgents)
  const connections = useApp((s) => s.connections)
  const profileConnections = useApp((s) => s.profileConnections)
  const profiles = useApp((s) => s.profiles)
  const selection = useApp((s) => s.selection)
  const sessions = useApp((s) => s.sessions)
  const projects = useApp((s) => s.projects)
  return useMemo(() => {
    const session = selection.kind === 'session' ? sessions[selection.sessionId] : undefined
    const project = projects.find((p) => p.id === selection.projectId)
    const entries: AccountEntry[] = []
    for (const a of agents) {
      if (a.kind !== 'native') continue
      let status: AgentStatus | null = a
      let connection: ConnectionStatus | undefined = isProfileAgent(a.agent) ? connections[a.agent] : undefined
      let profileName: string | null = null
      if (isProfileAgent(a.agent)) {
        const own = profilesOf(profiles, a.agent)
        // Il profilo della sessione vale solo se è di questo agente: una sessione terminale `codex` ha agente `claude-code` ma un profilo Codex.
        const sessionProfile = session?.profileId ? (own.some((p) => p.id === session.profileId) ? session.profileId : null) : session?.agent === a.agent ? normalizeProfileId(a.agent, null) : null
        const id = sessionProfile ?? projectProfileId(project, a.agent, own)
        if (!isDefaultProfileId(id)) {
          status = profileAgents[id] ?? null
          connection = profileConnections[id]
        }
        // Il nome del profilo serve solo a chi ne ha più d'uno.
        if (own.length > 1) profileName = own.find((p) => p.id === id)?.name ?? null
      }
      const account = status?.account ?? (connection?.plan ? `${a.name} ${connection.plan}` : null)
      const email = status?.email ?? connection?.email ?? null
      if (account || email) entries.push({ agent: a.agent, name: a.name, profile: profileName, account, email })
    }
    // L'agente della sessione aperta va per primo: la sua email è quella che si vede.
    const first = session?.agent
    return first ? [...entries.filter((e) => e.agent === first), ...entries.filter((e) => e.agent !== first)] : entries
  }, [agents, profileAgents, connections, profileConnections, profiles, selection, sessions, projects])
}

/** In basso a sinistra: gli abbonamenti collegati agli agenti, dei profili in uso. Iniziale ed email; piani e account per agente nel tooltip. Apre Impostazioni → Abbonamenti. */
export function AccountButton() {
  const linked = useAccountEntries()
  const emails = [...new Set(linked.flatMap((a) => (a.email ? [a.email] : [])))]
  const email = emails[0] ?? null
  const name = email ?? t('Linked subscriptions')
  const more = emails.length - 1
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" />}
        aria-label={[name, ...linked.map((a) => [a.name, a.profile, a.email, a.account].filter(Boolean).join(', '))].join('. ')}
        onClick={() => useSettings.getState().openSection('subscriptions')}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground/10 text-xs font-semibold text-foreground">
          {email ? email.slice(0, 1).toUpperCase() : <UserRound className="size-3.5" />}
        </span>
        <span className="block min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        {more > 0 && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">+{more}</span>}
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        {linked.length === 0 ? (
          t('No subscriptions linked')
        ) : (
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{t('Linked subscriptions')}</span>
            {linked.map((a) => (
              <span key={a.agent}>
                {a.name}
                <span className="opacity-70">{[a.profile, a.account, a.email].filter(Boolean).map((v) => ` · ${v}`).join('')}</span>
              </span>
            ))}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/** Seconda riga: chi lavora (segno del provider e modello) e cosa sta facendo, o dove lavora. */
function SessionMeta({ session, hasGlyph }: { session: SessionSummary; hasGlyph: boolean }) {
  const { name, model } = useAgentLine(session.agent, session.model)
  const profile = useSessionProfileName(session)
  const agents = runningSubagents(session)
  const browsing = useApp((s) => Boolean(s.agentBrowser[session.id]?.action))
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
      {profile && session.mode !== 'terminal' && (
        <>
          <span aria-hidden className="text-faint">·</span>
          <span className="max-w-24 shrink-0 truncate" title={t('Account: {name}', { name: profile })}>{profile}</span>
        </>
      )}
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
      {browsing && <Globe role="img" aria-label={t('The agent is using the browser')} className="size-3 shrink-0 text-running" strokeWidth={2} />}
      {session.worktree && <GitFork aria-label={`Worktree ${session.worktree.branch}`} className="size-3 shrink-0 text-faint" />}
      {session.pr && <GitPullRequest aria-label={`PR #${session.pr.number}`} className="size-3 shrink-0 text-faint" />}
      {session.titleGenerating && <Sparkles aria-label={t('Generating title…')} className="size-3 shrink-0 animate-pulse text-faint motion-reduce:animate-none" />}
    </span>
  )
}

/** Titolo modificabile nella riga. Invio salva, Esc annulla, uscire dal campo salva. */
function RenameField({ session, onDone }: { session: SessionSummary; onDone: (viaKeyboard: boolean) => void }) {
  const [value, setValue] = useState(session.title)
  // Il titolo con cui si è aperto il campo: se nel frattempo ne arriva uno generato, non lo si sovrascrive con quello vecchio.
  const initial = useRef(session.title)
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
    if (save && title && title !== initial.current) {
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
