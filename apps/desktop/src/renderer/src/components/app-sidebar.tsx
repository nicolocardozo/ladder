import {
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  Monitor,
  Moon,
  PanelLeft,
  Search,
  SquarePen,
  SquareTerminal,
  Sun,
  type LucideIcon
} from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import type { SessionSummary } from '@shared/protocol'
import { IconButton } from '@/components/icon-button'
import { ProjectBadges, RunningRing, SessionGlyph } from '@/components/status'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ThemeMode } from '@/hooks/use-theme'
import { request } from '@/lib/host-client'
import { projectAttention, sessionNote, sessionState } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

interface AppSidebarProps {
  themeMode: ThemeMode
  onCycleTheme: () => void
}

const themeIcon: Record<ThemeMode, LucideIcon> = { system: Monitor, light: Sun, dark: Moon }
const themeLabel: Record<ThemeMode, string> = { system: 'Tema: sistema', light: 'Tema: chiaro', dark: 'Tema: scuro' }

export async function addProjectFromDialog(): Promise<void> {
  const path = await window.ladder?.pickFolder()
  if (!path) return
  const project = await request<{ id: string }>({ type: 'project.add', path })
  const { select, expanded } = useApp.getState()
  useApp.setState({ expanded: expanded.includes(project.id) ? expanded : [...expanded, project.id] })
  select({ kind: 'new', projectId: project.id })
}

export function AppSidebar({ themeMode, onCycleTheme }: AppSidebarProps) {
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const drafts = useApp((s) => s.drafts)
  const expanded = useApp((s) => s.expanded)
  const selection = useApp((s) => s.selection)
  const select = useApp((s) => s.select)
  const toggleProject = useApp((s) => s.toggleProject)

  const byProject = useMemo(() => {
    const map = new Map<string, SessionSummary[]>()
    for (const session of Object.values(sessions)) {
      if (session.archived) continue
      const list = map.get(session.projectId) ?? []
      list.push(session)
      map.set(session.projectId, list)
    }
    // Ordine stabile: per data di creazione, la più recente in alto. Lo stato non sposta le righe.
    for (const list of map.values()) list.sort((a, b) => b.createdAt - a.createdAt)
    return map
  }, [sessions])

  const waitingTotal = Object.values(sessions).filter((s) => !s.archived && s.run === 'waiting').length

  return (
    <aside className="flex h-full w-[262px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground select-none">
      {/* Barra del titolo: lo spazio a sinistra lascia posto ai semafori di macOS. */}
      <div className="drag flex h-11 shrink-0 items-center gap-0.5 pr-2 pl-[82px]">
        <IconButton icon={PanelLeft} label="Nascondi sidebar" shortcut="⌘B" />
        <IconButton icon={Search} label="Cerca" shortcut="⌘K" />
        <span className="flex-1" />
        <IconButton icon={ChevronLeft} label="Indietro" shortcut="⌘[" />
        <IconButton icon={ChevronRight} label="Avanti" shortcut="⌘]" />
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
          trailing={
            waitingTotal > 0 ? (
              <span className="h-[17px] min-w-[17px] rounded-[4px] bg-attention px-1 text-center text-[10px] leading-[17px] font-semibold text-attention-foreground">
                {waitingTotal}
              </span>
            ) : null
          }
        />
        <SidebarAction icon={SquareTerminal} label="Terminali" trailing={<span className="text-[11px] text-faint">0</span>} />
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
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleProject(project.id)}
                  title={project.path}
                  className={cn(
                    'flex min-h-[30px] items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] outline-none',
                    'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50',
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
                </button>

                {open &&
                  list.map((session) => {
                    const selected = selection.kind === 'session' && selection.sessionId === session.id
                    const state = sessionState(session)
                    const waiting = state === 'waiting'
                    const note = sessionNote(session, Boolean(drafts[session.id]?.trim()))
                    return (
                      <button
                        key={session.id}
                        type="button"
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => select({ kind: 'session', projectId: project.id, sessionId: session.id })}
                        title={session.activity ?? session.title}
                        className={cn(
                          'relative ml-5 grid min-h-7 grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md py-1 pr-2 pl-2.5 text-left text-[12.5px] outline-none',
                          'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50',
                          selected && 'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent',
                          waiting && 'before:absolute before:top-[7px] before:bottom-[7px] before:left-[2px] before:w-[2.5px] before:bg-attention'
                        )}
                      >
                        <span className="grid place-items-center">
                          <SessionGlyph state={state} />
                        </span>
                        <span className={cn('truncate', state === 'unread' && 'font-semibold text-sidebar-accent-foreground')}>{session.title}</span>
                        <span
                          className={cn(
                            'text-[11px] whitespace-nowrap text-faint',
                            waiting && 'font-semibold text-attention',
                            state === 'error' && 'font-semibold text-destructive'
                          )}
                        >
                          {note === 'bozza' ? <i>bozza</i> : note}
                        </span>
                      </button>
                    )
                  })}

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
    </aside>
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
