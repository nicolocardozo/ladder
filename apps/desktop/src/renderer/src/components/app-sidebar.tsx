import {
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  ListFilter,
  Monitor,
  Moon,
  PanelLeft,
  Search,
  SquarePen,
  SquareTerminal,
  Sun,
  type LucideIcon
} from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton } from '@/components/icon-button'
import { ProjectBadges, RunningRing, SessionGlyph } from '@/components/status'
import { ScrollArea } from '@/components/ui/scroll-area'
import { projectAttention, type ProjectSummary } from '@/data/sample'
import type { ThemeMode } from '@/hooks/use-theme'
import { cn } from '@/lib/utils'

export type Selection = { kind: 'new'; projectId: string } | { kind: 'session'; projectId: string; sessionId: string }

interface AppSidebarProps {
  projects: ProjectSummary[]
  expanded: Set<string>
  selection: Selection
  themeMode: ThemeMode
  onToggleProject: (id: string) => void
  onSelect: (selection: Selection) => void
  onCycleTheme: () => void
}

const themeIcon: Record<ThemeMode, LucideIcon> = { system: Monitor, light: Sun, dark: Moon }
const themeLabel: Record<ThemeMode, string> = { system: 'Tema: sistema', light: 'Tema: chiaro', dark: 'Tema: scuro' }

export function AppSidebar({ projects, expanded, selection, themeMode, onToggleProject, onSelect, onCycleTheme }: AppSidebarProps) {
  const waitingTotal = projects.reduce((n, p) => n + projectAttention(p).waiting, 0)

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
          onClick={() => onSelect({ kind: 'new', projectId: selection.projectId })}
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
        <span className="flex gap-0.5">
          <IconButton icon={ListFilter} label="Filtra progetti" className="size-6" />
          <IconButton icon={FolderPlus} label="Aggiungi progetto" className="size-6" />
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-px px-2 pb-3">
          {projects.map((project) => {
            const open = expanded.has(project.id)
            const attention = projectAttention(project)
            const FolderIcon = open ? FolderOpen : Folder
            return (
              <div key={project.id} className="flex flex-col gap-px">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => onToggleProject(project.id)}
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
                  project.sessions.map((session) => {
                    const selected = selection.kind === 'session' && selection.sessionId === session.id
                    const waiting = session.state === 'waiting'
                    return (
                      <button
                        key={session.id}
                        type="button"
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => onSelect({ kind: 'session', projectId: project.id, sessionId: session.id })}
                        className={cn(
                          'relative ml-5 grid min-h-7 grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md py-1 pr-2 pl-2.5 text-left text-[12.5px] outline-none',
                          'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50',
                          selected && 'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent',
                          waiting && 'before:absolute before:top-[7px] before:bottom-[7px] before:left-[2px] before:w-[2.5px] before:bg-attention'
                        )}
                      >
                        <span className="grid place-items-center">
                          <SessionGlyph state={session.state} />
                        </span>
                        <span className={cn('truncate', session.state === 'unread' && 'font-semibold text-sidebar-accent-foreground')}>
                          {session.title}
                        </span>
                        <span className={cn('text-[11px] whitespace-nowrap text-faint', waiting && 'font-semibold text-attention')}>
                          {waiting ? session.waitingLabel : session.note === 'bozza' ? <i>bozza</i> : session.note}
                        </span>
                      </button>
                    )
                  })}

                {open && project.sessions.length === 0 && (
                  <p className="ml-5 py-1 pl-2.5 text-[12px] text-faint">Nessuna sessione. ⌘N per iniziare.</p>
                )}
              </div>
            )
          })}
        </div>
      </ScrollArea>

      <footer className="flex items-center gap-2.5 border-t border-sidebar-border px-3 py-2.5 text-[12.5px]">
        <span className="grid size-6 place-items-center rounded-full bg-sidebar-accent text-[10px] font-semibold text-sidebar-accent-foreground">
          NC
        </span>
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
