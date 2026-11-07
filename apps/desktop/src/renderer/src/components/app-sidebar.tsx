import {
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  Monitor,
  Moon,
  PanelLeft,
  Search,
  SquarePen,
  Sun,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Project, SessionSummary } from '@shared/protocol'
import { IconButton } from '@/components/icon-button'
import { ProjectMenuContent, RemoveProjectDialog, SessionMenuContent } from '@/components/session-menu'
import { ProjectBadges, RunningRing, SessionGlyph } from '@/components/status'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ThemeMode } from '@/hooks/use-theme'
import { request, send } from '@/lib/host-client'
import { projectAttention, sessionNote, sessionState } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { canNavigate, useApp } from '@/store/app-store'

interface AppSidebarProps {
  themeMode: ThemeMode
  onCycleTheme: () => void
}

export const themeIcon: Record<ThemeMode, LucideIcon> = { system: Monitor, light: Sun, dark: Moon }
export const themeLabel: Record<ThemeMode, string> = { system: 'Tema: sistema', light: 'Tema: chiaro', dark: 'Tema: scuro' }

export async function addProjectFromDialog(): Promise<void> {
  const path = await window.ladder?.pickFolder()
  if (!path) return
  const project = await request<{ id: string }>({ type: 'project.add', path })
  const { select, expanded } = useApp.getState()
  useApp.setState({ expanded: expanded.includes(project.id) ? expanded : [...expanded, project.id] })
  select({ kind: 'new', projectId: project.id })
}

/** Pulsante per riaprire la sidebar, nella barra in alto quando è nascosta. */
export function ShowSidebarButton() {
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  return <IconButton icon={PanelLeft} label="Mostra sidebar" shortcut="⌘B" onClick={toggleSidebar} className="hover:bg-accent" />
}

export function AppSidebar({ themeMode, onCycleTheme }: AppSidebarProps) {
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const drafts = useApp((s) => s.drafts)
  const expanded = useApp((s) => s.expanded)
  const selection = useApp((s) => s.selection)
  const select = useApp((s) => s.select)
  const toggleProject = useApp((s) => s.toggleProject)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const setPaletteOpen = useApp((s) => s.setPaletteOpen)
  const navigate = useApp((s) => s.navigate)
  const canBack = useApp((s) => canNavigate(s, -1))
  const canForward = useApp((s) => canNavigate(s, 1))
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
  for (const list of byProject.values()) waitingTotal += list.filter((s) => s.run === 'waiting').length

  return (
    <aside className="flex h-full w-[262px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground select-none">
      {/* Barra del titolo: lo spazio a sinistra lascia posto ai semafori di macOS. */}
      <div className="drag flex h-11 shrink-0 items-center gap-0.5 pr-2 pl-[82px]">
        <IconButton icon={PanelLeft} label="Nascondi sidebar" shortcut="⌘B" onClick={toggleSidebar} />
        <IconButton icon={Search} label="Cerca" shortcut="⌘K" onClick={() => setPaletteOpen(true)} />
        <span className="flex-1" />
        <HistoryButton icon={ChevronLeft} label="Indietro" shortcut="⌘[" disabled={!canBack} onClick={() => navigate(-1)} />
        <HistoryButton icon={ChevronRight} label="Avanti" shortcut="⌘]" disabled={!canForward} onClick={() => navigate(1)} />
      </div>

      <nav className="flex flex-col gap-px px-2 pt-1" aria-label="Azioni">
        <SidebarAction
          icon={SquarePen}
          label="Nuova chat"
          trailing={<kbd className="font-mono text-[10.5px] text-faint">⌘N</kbd>}
          active={selection.kind === 'new'}
          onClick={() => select({ kind: 'new', projectId: selection.projectId ?? projects[0]?.id ?? null })}
        />
        <SidebarAction
          icon={Inbox}
          label="In attesa"
          onClick={() => useApp.getState().goToNextWaiting()}
          trailing={
            waitingTotal > 0 ? (
              <span className="h-[17px] min-w-[17px] rounded-[4px] bg-attention px-1 text-center text-[10px] leading-[17px] font-semibold text-attention-foreground">
                {waitingTotal}
              </span>
            ) : null
          }
        />
      </nav>

      <div className="flex items-center justify-between pt-5 pr-3 pb-1 pl-4 text-xs text-muted-foreground">
        <span>Progetti</span>
        <IconButton icon={FolderPlus} label="Aggiungi progetto" className="size-6" onClick={() => void addProjectFromDialog()} />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-px px-2 pb-3">
          {projects.length === 0 && (
            <button
              type="button"
              onClick={() => void addProjectFromDialog()}
              className="mx-1 mt-1 rounded-md border border-dashed border-sidebar-border px-3 py-3 text-left text-[12.5px] text-muted-foreground outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Aggiungi la cartella di un progetto per iniziare.
            </button>
          )}
          {projects.map((project) => {
            const open = expanded.includes(project.id)
            const list = byProject.get(project.id) ?? []
            const attention = projectAttention(list)
            const FolderIcon = open ? FolderOpen : Folder
            return (
              <div key={project.id} className="flex flex-col gap-px">
                <ContextMenu>
                  <ContextMenuTrigger
                    render={<button type="button" />}
                    aria-expanded={open}
                    onClick={() => toggleProject(project.id)}
                    title={project.path}
                    className={cn(
                      'flex min-h-[30px] items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] outline-none',
                      'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-sidebar-accent/60',
                      open && 'text-sidebar-accent-foreground'
                    )}
                  >
                    <FolderIcon className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
                    <span className="truncate">{project.name}</span>
                    {open ? (
                      attention.running && (
                        <span className="ml-auto">
                          <RunningRing />
                        </span>
                      )
                    ) : (
                      <ProjectBadges attention={attention} />
                    )}
                  </ContextMenuTrigger>
                  <ProjectMenuContent project={project} onRemove={() => setRemoving(project)} />
                </ContextMenu>

                {open &&
                  list.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      project={project}
                      selected={selection.kind === 'session' && selection.sessionId === session.id}
                      hasDraft={Boolean(drafts[session.id]?.trim())}
                    />
                  ))}

                {open && list.length === 0 && <p className="ml-5 py-1 pl-2.5 text-[12px] text-faint">Nessuna sessione. ⌘N per iniziare.</p>}
              </div>
            )
          })}
        </div>
      </ScrollArea>

      <footer className="flex items-center gap-2.5 border-t border-sidebar-border px-3 py-2.5 text-[12.5px]">
        <span className="grid size-6 place-items-center rounded-full bg-sidebar-accent text-[10px] font-semibold text-sidebar-accent-foreground">NC</span>
        <span className="truncate">Nicolò</span>
        <IconButton icon={themeIcon[themeMode]} label={themeLabel[themeMode]} onClick={onCycleTheme} className="ml-auto" />
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
}

/** Riga di una sessione: clic per aprirla, clic destro o "…" per le azioni, doppio clic per rinominarla. */
function SessionRow({ session, project, selected, hasDraft }: SessionRowProps) {
  const select = useApp((s) => s.select)
  const renaming = useApp((s) => s.renaming === session.id)
  const startRename = useApp((s) => s.startRename)
  const stopRename = useApp((s) => s.stopRename)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const state = sessionState(session)
  const waiting = state === 'waiting'
  const note = sessionNote(session, hasDraft)

  return (
    <ContextMenu disabled={renaming}>
      <ContextMenuTrigger className="group/row relative ml-5 rounded-md">
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
              title={session.activity ?? session.title}
              className={cn(
                'relative grid min-h-7 w-full grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md py-1 pr-2 pl-2.5 text-left text-[12.5px] outline-none',
                'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50',
                // Riga evidenziata mentre il suo menu (clic destro o "…") è aperto.
                'group-data-[popup-open]/row:bg-sidebar-accent/60 group-has-[[data-popup-open]]/row:bg-sidebar-accent/60',
                selected &&
                  'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent group-data-[popup-open]/row:bg-sidebar-accent group-has-[[data-popup-open]]/row:bg-sidebar-accent',
                waiting && 'before:absolute before:top-[7px] before:bottom-[7px] before:left-[2px] before:w-[2.5px] before:bg-attention'
              )}
            >
              <span className="grid place-items-center">
                <SessionGlyph state={state} />
              </span>
              <span className={cn('truncate', state === 'unread' && 'font-semibold text-sidebar-accent-foreground')}>{session.title}</span>
              {/* Lascia il posto al pulsante "…" quando la riga è sotto il puntatore o ha il focus. */}
              <span
                className={cn(
                  'text-[11px] whitespace-nowrap text-faint',
                  'group-hover/row:invisible group-has-[:focus-visible]/row:invisible group-has-[[data-popup-open]]/row:invisible',
                  waiting && 'font-semibold text-attention',
                  state === 'error' && 'font-semibold text-destructive'
                )}
              >
                {note === 'bozza' ? <i>bozza</i> : note}
              </span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Azioni per ${session.title}`}
                className={cn(
                  'absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-[5px] text-muted-foreground opacity-0 outline-none',
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
      aria-label="Titolo della sessione"
      spellCheck={false}
      maxLength={200}
      className="h-6 w-full min-w-0 rounded-[5px] bg-background px-1.5 text-[12.5px] text-foreground ring-1 ring-ring/60 outline-none select-text"
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
        <span className="ml-1.5 font-mono text-[11px] opacity-70">{shortcut}</span>
      </TooltipContent>
    </Tooltip>
  )
}

interface SidebarActionProps {
  icon: LucideIcon
  label: string
  trailing?: ReactNode
  active?: boolean
  onClick?: () => void
}

function SidebarAction({ icon: Icon, label, trailing, active, onClick }: SidebarActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-[30px] items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] outline-none',
        'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50',
        active && 'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent'
      )}
    >
      <Icon className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
}
