// ⌘K: cerca sessioni (in tutti i progetti), progetti e azioni. Il filtro è nostro, così l'ordine resta quello voluto:
// prima le sessioni che aspettano l'utente, poi le più recenti.
import { useMemo, useState } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { CircleAlert, Folder, FolderPlus, Palette, PanelLeft, Search, SquarePen } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { addProjectFromDialog } from '@/components/app-sidebar'
import { SessionGlyph } from '@/components/status'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { themeById } from '@shared/themes.generated'
import { useSettings } from '@/hooks/use-theme'
import { relativeAge, sessionState } from '@/lib/session-state'
import { isLiveSession, useApp } from '@/store/app-store'

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen)
  const setPaletteOpen = useApp((s) => s.setPaletteOpen)

  return (
    <Dialog open={open} onOpenChange={(next) => setPaletteOpen(next)}>
      <DialogContent showCloseButton={false} className="top-[13vh] translate-y-0 gap-0 overflow-hidden p-0 shadow-2xl sm:max-w-[600px]">
        <DialogTitle className="sr-only">Cerca in Ladder</DialogTitle>
        <DialogDescription className="sr-only">Sessioni di tutti i progetti, progetti e azioni.</DialogDescription>
        {/* Il contenuto si monta a ogni apertura: la ricerca riparte vuota. */}
        <PaletteBody onClose={() => setPaletteOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

const matches = (tokens: string[], haystack: string) => tokens.every((token) => haystack.includes(token))

const shortPath = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

const itemClass = 'gap-2.5 px-2.5 py-[7px] text-[13px] data-selected:bg-accent'
const sideClass = 'flex max-w-[45%] min-w-0 shrink-0 items-center gap-1.5 text-[11.5px] tracking-normal text-muted-foreground'

interface Action {
  id: string
  label: string
  icon: LucideIcon
  keywords: string
  shortcut?: string
  hint?: string
  perform: () => void
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const themeId = useSettings((s) => s.theme)
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const tokens = useMemo(() => normalize(query).split(/\s+/).filter(Boolean), [query])
  const searching = tokens.length > 0

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])

  const live = useMemo(() => {
    const list = Object.values(sessions).filter((s) => isLiveSession({ projects }, s))
    // Prima chi aspetta l'utente, poi per attività recente.
    return list.sort((a, b) => Number(b.run === 'waiting') - Number(a.run === 'waiting') || b.updatedAt - a.updatedAt)
  }, [sessions, projects])

  const waitingCount = live.filter((s) => s.run === 'waiting').length

  const sessionResults = useMemo(() => {
    if (!searching) return live.slice(0, 8)
    return live.filter((s) => matches(tokens, normalize(`${s.title} ${projectNames.get(s.projectId) ?? ''}`))).slice(0, 50)
  }, [live, tokens, searching, projectNames])

  const projectResults = useMemo(
    () => (searching ? projects.filter((p) => matches(tokens, normalize(`${p.name} ${p.path}`))) : projects),
    [projects, tokens, searching]
  )

  const run = (perform: () => void) => {
    onClose()
    perform()
  }

  const actions: Action[] = [
    {
      id: 'new-chat',
      label: 'Nuova chat',
      icon: SquarePen,
      keywords: 'nuova chat sessione crea',
      shortcut: '⌘N',
      perform: () =>
        run(() => {
          const { selection, select } = useApp.getState()
          select({ kind: 'new', projectId: selection.projectId ?? projects[0]?.id ?? null })
        })
    },
    {
      id: 'next-waiting',
      label: 'Vai alla prossima sessione che ti aspetta',
      icon: CircleAlert,
      keywords: 'prossima sessione attesa aspetta richiede approvazione domanda',
      hint: waitingCount === 0 ? 'nessuna' : waitingCount === 1 ? '1 in attesa' : `${waitingCount} in attesa`,
      perform: () => {
        if (useApp.getState().goToNextWaiting()) onClose()
        else setNotice('Nessuna sessione ti aspetta in questo momento.')
      }
    },
    {
      id: 'add-project',
      label: 'Aggiungi progetto…',
      icon: FolderPlus,
      keywords: 'aggiungi progetto cartella repository',
      perform: () => run(() => void addProjectFromDialog())
    },
    {
      id: 'theme',
      label: 'Cambia tema…',
      icon: Palette,
      keywords: 'cambia tema chiaro scuro aspetto impostazioni colori circuit',
      hint: themeById(themeId).name,
      perform: () => run(() => useSettings.getState().setSettingsOpen(true))
    },
    {
      id: 'sidebar',
      label: sidebarOpen ? 'Nascondi sidebar' : 'Mostra sidebar',
      icon: PanelLeft,
      keywords: 'nascondi mostra sidebar barra laterale',
      shortcut: '⌘B',
      perform: () => run(() => useApp.getState().toggleSidebar())
    }
  ]
  const actionResults = searching ? actions.filter((a) => matches(tokens, normalize(`${a.label} ${a.keywords}`))) : actions

  return (
    <Command shouldFilter={false} loop label="Cerca in Ladder" className="rounded-none! bg-popover p-0">
      <div className="flex h-12 items-center gap-2.5 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <CommandPrimitive.Input
          value={query}
          onValueChange={(value) => {
            setQuery(value)
            setNotice(null)
          }}
          placeholder="Cerca sessioni, progetti e azioni…"
          className="h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
        />
      </div>

      <CommandList className="max-h-[min(440px,58vh)] px-1.5 py-1.5">
        <CommandEmpty className="py-8 text-[13px] text-muted-foreground">Nessun risultato per “{query.trim()}”.</CommandEmpty>

        {sessionResults.length > 0 && (
          <CommandGroup heading={searching ? 'Sessioni' : 'Sessioni recenti'}>
            {sessionResults.map((session) => {
              const state = sessionState(session)
              return (
                <CommandItem
                  key={session.id}
                  value={`session:${session.id}`}
                  className={itemClass}
                  onSelect={() => run(() => useApp.getState().select({ kind: 'session', projectId: session.projectId, sessionId: session.id }))}
                >
                  <span className="grid w-3.5 shrink-0 place-items-center">
                    <SessionGlyph state={state} />
                  </span>
                  <span className={state === 'unread' ? 'min-w-0 flex-1 truncate font-semibold' : 'min-w-0 flex-1 truncate'}>{session.title}</span>
                  <CommandShortcut className={sideClass}>
                    {state === 'waiting' ? (
                      <span className="shrink-0 font-semibold text-attention">{session.waitingLabel ?? 'Richiede te'}</span>
                    ) : state === 'error' ? (
                      <span className="shrink-0 font-semibold text-destructive">Errore</span>
                    ) : (
                      <span className="shrink-0 text-faint">{relativeAge(session.updatedAt)}</span>
                    )}
                    <span className="truncate">{projectNames.get(session.projectId)}</span>
                  </CommandShortcut>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}

        {actionResults.length > 0 && (
          <CommandGroup heading="Azioni">
            {actionResults.map((action) => (
              <CommandItem key={action.id} value={`action:${action.id}`} className={itemClass} onSelect={action.perform}>
                <action.icon className="size-[15px] text-muted-foreground" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                {(action.shortcut || action.hint) && (
                  <CommandShortcut className={sideClass}>
                    {action.hint && <span className="text-faint">{action.hint}</span>}
                    {action.shortcut && <kbd className="font-mono text-[11px]">{action.shortcut}</kbd>}
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {projectResults.length > 0 && (
          <CommandGroup heading="Progetti">
            {projectResults.map((project, index) => (
              <CommandItem
                key={project.id}
                value={`project:${project.id}`}
                className={itemClass}
                onSelect={() =>
                  run(() => {
                    const state = useApp.getState()
                    if (!state.expanded.includes(project.id)) state.toggleProject(project.id)
                    state.selectProject(project.id)
                  })
                }
              >
                <Folder className="size-[15px] text-muted-foreground" strokeWidth={1.6} />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <CommandShortcut className={sideClass}>
                  <span className="truncate text-faint">{shortPath(project.path)}</span>
                  {index < 9 && <kbd className="shrink-0 font-mono text-[11px]">⌘{index + 1}</kbd>}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>

      <div className="flex h-9 items-center gap-3 border-t border-border px-4 text-[11.5px] text-faint">
        {/* Regione sempre presente, così il lettore di schermo annuncia il messaggio quando compare. */}
        <span role="status" className={notice ? 'font-medium text-foreground' : 'sr-only'}>
          {notice}
        </span>
        {!notice && (
          <>
            <span>
              <kbd className="font-mono">↑↓</kbd> per scegliere
            </span>
            <span>
              <kbd className="font-mono">↵</kbd> per aprire
            </span>
          </>
        )}
        <span className="ml-auto">
          <kbd className="font-mono">esc</kbd> per chiudere
        </span>
      </div>
    </Command>
  )
}
