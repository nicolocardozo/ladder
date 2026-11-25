// ⌘K: cerca sessioni (in tutti i progetti), progetti e azioni. Il filtro è nostro, così l'ordine resta quello voluto:
// prima le sessioni che aspettano l'utente, poi le più recenti.
import { useEffect, useMemo, useState } from 'react'
import { useShortcutsRevision } from '@/lib/use-shortcuts'
import { Command as CommandPrimitive } from 'cmdk'
import { BellOff, Bookmark, ChevronLeft, ChevronRight, CircleAlert, Columns2, FileDiff, FileSearch, Folder, FolderPlus, FolderSearch, FolderTree, Globe, Keyboard, GitMerge, GitPullRequestCreate, History, Inbox, MessageSquareText, Palette, PanelLeft, PanelRight, PanelRightClose, RotateCw, Search, Sparkles, SquarePen, SquareTerminal, Undo2 } from 'lucide-react'
import type { SearchHit } from '@shared/protocol'
import { localeTag, plural, t } from '@shared/i18n'
import { openInbox } from '@/components/app-sidebar'
import { request } from '@/lib/host-client'
import type { LucideIcon } from 'lucide-react'
import { addProjectFromDialog } from '@/components/app-sidebar'
import { SessionGlyph } from '@/components/status'
import { AgentMark } from '@/components/agent-mark'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { themeById } from '@shared/themes.generated'
import { useSettings } from '@/hooks/use-theme'
import { relativeAge, sessionState } from '@/lib/session-state'
import { newShell } from '@/components/terminal/terminal-panel'
import { focusNextTerminal } from '@/lib/terminal-registry'
import { isListedSession, useApp } from '@/store/app-store'
import { openSavePreset, presetSummary } from '@/lib/session-presets'
import { Kbd } from '@/components/ui/kbd'
import { shortcutLabel, type CommandId } from '@shared/shortcuts'

function inspectorActions(run: (perform: () => void) => void): Action[] {
  const open = (tab: 'changes' | 'files' | 'history' | 'merge') => () =>
    run(() => {
      const { selection, openInspector } = useApp.getState()
      if (selection.projectId) openInspector(selection.projectId, tab)
    })
  return [
    { id: 'changes', label: t('Show changes'), icon: FileDiff, keywords: 'changes diff turn session restore comments modifiche turno sessione ripristina commenti', command: 'inspector.changes', perform: open('changes') },
    { id: 'files', label: t('Show files'), icon: FolderTree, keywords: 'files explorer tree folder viewer file albero cartella', command: 'inspector.files', perform: open('files') },
    { id: 'history', label: t('History and checkpoints'), icon: History, keywords: 'history checkpoint commit restore cronologia ripristina', command: 'inspector.history', perform: open('history') },
    { id: 'merge', label: t('Branches'), icon: GitMerge, keywords: 'branches branch worktree map rami merge pr pull request ci review comments conflicts create pr commenti conflitti crea', command: 'inspector.merge', perform: open('merge') },
    {
      id: 'panel',
      label: t('Show or hide the right panel'),
      icon: PanelRight,
      keywords: 'right panel inspector toggle hide show pannello destro ispettore mostra nascondi',
      command: 'inspector.toggle',
      perform: () =>
        run(() => {
          const { selection, toggleInspector } = useApp.getState()
          if (selection.projectId) toggleInspector(selection.projectId)
        })
    }
  ]
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen)
  const setPaletteOpen = useApp((s) => s.setPaletteOpen)

  return (
    <Dialog open={open} onOpenChange={(next) => setPaletteOpen(next)}>
      <DialogContent showCloseButton={false} className="top-[13vh] translate-y-0 gap-0 overflow-hidden p-0 shadow-2xl sm:max-w-[600px]">
        <DialogTitle className="sr-only">{t('Search Ladder')}</DialogTitle>
        <DialogDescription className="sr-only">{t('Sessions from all projects, projects and actions.')}</DialogDescription>
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

const itemClass = 'gap-2.5 px-2.5 py-[7px] text-sm data-selected:bg-accent'
const sideClass = 'flex max-w-[45%] min-w-0 shrink-0 items-center gap-1.5 text-xs tracking-normal text-muted-foreground'

interface Action {
  id: string
  label: string
  icon: LucideIcon
  keywords: string
  /** Comando del registro: la scorciatoia mostrata viene da lì. */
  command?: CommandId
  hint?: string
  disabled?: boolean
  perform: () => void
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  useShortcutsRevision()
  const themeId = useSettings((s) => s.theme)
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const prefs = useApp((s) => s.prefs)
  // La sessione aperta, se è una chat di Claude Code o Codex: "Rigenera titolo" agisce su di lei (gli agenti ACP rispondono sempre con un errore).
  const activeChat = useApp((s) => {
    const sel = s.selection
    const session = sel.kind === 'session' ? s.sessions[sel.sessionId] : undefined
    return session?.mode === 'chat' && (session.agent === 'claude-code' || session.agent === 'codex') ? session : null
  })
  // La sessione aperta se è una chat (non un terminale): "Salva come profilo" parte dai suoi valori.
  const activeChatId = useApp((s) => {
    const sel = s.selection
    const session = sel.kind === 'session' ? s.sessions[sel.sessionId] : undefined
    return session?.mode === 'chat' ? session.id : null
  })
  // Sessione aperta con il browser dell'agente fermato (stop esplicito o tab chiusa): si può riattivare da qui.
  const stoppedAgentBrowserId = useApp((s) => {
    const sel = s.selection
    const state = sel.kind === 'session' ? s.agentBrowser[sel.sessionId] : undefined
    return state && state.enabled && !state.closed && state.stopped ? state.sessionId : null
  })
  const agents = useApp((s) => s.agents)
  const dndOn = Boolean(prefs?.dndUntil && prefs.dndUntil > Date.now())
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const tokens = useMemo(() => normalize(query).split(/\s+/).filter(Boolean), [query])
  const searching = tokens.length > 0

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])

  const live = useMemo(() => {
    const list = Object.values(sessions).filter((s) => isListedSession({ projects }, s))
    // Prima chi aspetta l'utente, poi per attività recente.
    return list.sort((a, b) => Number(b.run === 'waiting') - Number(a.run === 'waiting') || b.updatedAt - a.updatedAt)
  }, [sessions, projects])

  const waitingCount = live.filter((s) => s.run === 'waiting').length

  const sessionResults = useMemo(() => {
    if (!searching) return live.slice(0, 8)
    return live.filter((s) => matches(tokens, normalize(`${s.title} ${projectNames.get(s.projectId) ?? ''}`))).slice(0, 50)
  }, [live, tokens, searching, projectNames])

  // Testo delle conversazioni e file toccati, in tutti i progetti: lo cerca l'host.
  const [hits, setHits] = useState<SearchHit[]>([])
  useEffect(() => {
    if (query.trim().length < 2) {
      setHits([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      request<SearchHit[]>({ type: 'search', query })
        .then((result) => !cancelled && setHits(result))
        .catch(() => undefined)
    }, 140)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query])
  const titleMatches = new Set(sessionResults.map((s) => s.id))
  const contentHits = hits.filter((hit) => sessions[hit.sessionId] && !titleMatches.has(hit.sessionId)).slice(0, 12)

  const projectResults = useMemo(
    () => (searching ? projects.filter((p) => matches(tokens, normalize(`${p.name} ${p.path}`))) : projects),
    [projects, tokens, searching]
  )

  const run = (perform: () => void) => {
    onClose()
    perform()
  }

  /** Azione sul progetto selezionato; senza progetto non fa nulla. */
  const inProject = (act: (state: ReturnType<typeof useApp.getState>, projectId: string) => unknown) => () =>
    run(() => {
      const state = useApp.getState()
      if (state.selection.projectId) act(state, state.selection.projectId)
    })

  const presetActions: Action[] = (prefs?.presets ?? [])
    .map((preset) => ({
      id: `preset:${preset.id}`,
      label: t('New chat with {profile}', { profile: preset.name }),
      icon: Bookmark,
      keywords: `new chat session profile preset nuova sessione profilo ${preset.name} ${preset.note ?? ''}`,
      hint: presetSummary(preset, agents),
      perform: () =>
        run(() => {
          const { selection, select, setNewPreset } = useApp.getState()
          const projectId = selection.projectId ?? projects[0]?.id ?? null
          if (projectId) setNewPreset({ projectId, presetId: preset.id })
          select({ kind: 'new', projectId })
        })
    }))
    // Senza ricerca non invadono l'elenco: i primi cinque; cercando si trovano tutti.
    .filter((action, index) => searching || index < 5)

  const actions: Action[] = [
    {
      id: 'new-chat',
      label: t('New chat'),
      icon: SquarePen,
      keywords: 'new chat session create nuova sessione crea',
      command: 'chat.new',
      perform: () =>
        run(() => {
          const { selection, select } = useApp.getState()
          select({ kind: 'new', projectId: selection.projectId ?? projects[0]?.id ?? null })
        })
    },
    // Profili di sessione: "Nuova chat con <profilo>" apre la nuova chat del progetto selezionato con il profilo già applicato.
    ...presetActions,
    ...(activeChatId
      ? [
          {
            id: 'save-preset',
            label: t('Save session as profile…'),
            icon: Bookmark,
            keywords: 'save session profile preset agent model effort permissions salva sessione profilo agente modello permessi',
            perform: () => run(() => openSavePreset(activeChatId))
          }
        ]
      : []),
    {
      id: 'split',
      label: t('New chat beside this one'),
      icon: Columns2,
      keywords: 'split side by side column columns tile affianca colonna colonne',
      command: 'chat.split',
      perform: () => run(() => useApp.getState().splitActive())
    },
    {
      id: 'close-column',
      label: t('Close this column'),
      icon: PanelRightClose,
      keywords: 'close column split side by side chiudi colonna affianca',
      perform: () =>
        run(() => {
          const { selection, closeColumn } = useApp.getState()
          if (selection.kind === 'session') closeColumn(selection.projectId, selection.sessionId)
        })
    },
    {
      id: 'next-tab',
      label: t('Next tab'),
      icon: ChevronRight,
      keywords: 'next tab switch cycle chat file prossima scheda tab cambia',
      command: 'tab.next',
      perform: inProject((state, projectId) => state.cycleTab(projectId, 1))
    },
    {
      id: 'previous-tab',
      label: t('Previous tab'),
      icon: ChevronLeft,
      keywords: 'previous tab switch cycle chat file precedente scheda tab cambia',
      command: 'tab.previous',
      perform: inProject((state, projectId) => state.cycleTab(projectId, -1))
    },
    {
      id: 'reopen-tab',
      label: t('Reopen closed tab'),
      icon: Undo2,
      keywords: 'reopen closed tab restore undo close riapri chiusa scheda tab ripristina annulla',
      command: 'tab.reopenClosed',
      perform: inProject((state, projectId) => state.reopenClosedTab(projectId))
    },
    ...(window.ladder?.browser
      ? [
          {
            id: 'open-browser',
            label: t('Open browser'),
            icon: Globe,
            keywords: 'browser web page preview localhost dev server tab open apri pagina anteprima server sviluppo scheda',
            perform: inProject((state, projectId) => state.openBrowser(projectId))
          }
        ]
      : []),
    {
      id: 'search-project',
      label: t('Search in project'),
      icon: FolderSearch,
      keywords: 'search find project files filter folder cerca trova progetto file filtro cartella',
      command: 'search.project',
      perform: inProject((state, projectId) => state.searchInProject(projectId))
    },
    ...(activeChat
      ? [
          {
            id: 'regenerate-title',
            label: activeChat.titleGenerating ? t('Generating title…') : t('Regenerate title'),
            icon: Sparkles,
            keywords: 'regenerate title rename generate name session rigenera titolo rinomina genera nome sessione',
            disabled: activeChat.titleGenerating,
            perform: () => run(() => useApp.getState().regenerateTitle(activeChat.id))
          },
          {
            id: 'restart-agent',
            label: t('Restart agent'),
            icon: RotateCw,
            keywords: 'restart agent reload mcp server settings process riavvia agente ricarica server mcp impostazioni processo',
            perform: () => run(() => void request({ type: 'session.restartAgent', sessionId: activeChat.id }).catch(() => undefined))
          }
        ]
      : []),
    ...(stoppedAgentBrowserId
      ? [
          {
            id: 'resume-agent-browser',
            label: t('Resume the agent’s browser'),
            icon: Globe,
            keywords: 'resume agent browser reactivate restart riattiva browser agente riprendi',
            perform: () => run(() => void useApp.getState().resumeAgentBrowser(stoppedAgentBrowserId).catch(() => undefined))
          }
        ]
      : []),
    {
      id: 'next-waiting',
      label: t('Go to next session waiting for you'),
      icon: CircleAlert,
      keywords: 'next session waiting needs you approval question prossima sessione attesa aspetta richiede approvazione domanda',
      command: 'session.nextWaiting',
      hint: waitingCount === 0 ? t('none') : t('{n} waiting', { n: waitingCount }),
      perform: () => {
        if (useApp.getState().goToNextWaiting()) onClose()
        else setNotice(t('No sessions are waiting for you right now.'))
      }
    },
    {
      id: 'inbox',
      label: t('Open “Waiting”'),
      icon: Inbox,
      keywords: 'waiting inbox requests approvals questions unread errors in attesa richieste approvazioni domande da leggere errori',
      hint: waitingCount ? plural(waitingCount, '{n} pending request', '{n} pending requests') : undefined,
      perform: () => run(() => openInbox())
    },
    {
      id: 'new-from',
      label: t('New session from issue, PR or branch…'),
      icon: GitPullRequestCreate,
      keywords: 'new session issue pr pull request branch github linear nuova sessione',
      command: 'chat.newFrom',
      perform: () => run(() => useApp.getState().setNewFromOpen(true))
    },
    {
      id: 'dnd',
      label: dndOn ? t('Turn notifications back on') : t('Do Not Disturb for 1 hour'),
      icon: BellOff,
      keywords: 'do not disturb notifications silence pause mute non disturbare notifiche silenzio pausa',
      hint: dndOn && prefs?.dndUntil ? t('until {time}', { time: new Date(prefs.dndUntil).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }) }) : undefined,
      perform: () => run(() => void window.ladder?.prefs.set({ dndUntil: dndOn ? null : Date.now() + 60 * 60_000 }))
    },
    {
      id: 'open-file',
      label: t('Open file…'),
      icon: FileSearch,
      keywords: 'open file search name path viewer apri cerca nome percorso',
      command: 'quickOpen.toggle',
      perform: () => run(() => useApp.getState().setQuickOpen(true))
    },
    ...inspectorActions(run),
    {
      id: 'terminal',
      label: t('Show or hide terminal'),
      icon: SquareTerminal,
      keywords: 'terminal panel shell console terminale pannello',
      command: 'terminal.toggle',
      perform: () =>
        run(() => {
          const state = useApp.getState()
          const projectId = state.selection.projectId
          if (!projectId) return
          const open = Boolean(state.ui[projectId]?.terminal?.open)
          if (!open) focusNextTerminal()
          state.setTerminalPanel(projectId, { open: !open })
        })
    },
    {
      id: 'new-terminal',
      label: t('New terminal'),
      icon: SquareTerminal,
      keywords: 'new terminal shell zsh nuovo terminale',
      perform: () =>
        run(() => {
          const { selection, sessions } = useApp.getState()
          if (!selection.projectId) return
          const sessionId = selection.kind === 'session' ? selection.sessionId : null
          void newShell(selection.projectId, sessionId, sessionId ? sessions[sessionId]?.cwd : undefined)
        })
    },
    {
      id: 'add-project',
      label: t('Add project…'),
      icon: FolderPlus,
      keywords: 'add project folder repository aggiungi progetto cartella',
      perform: () => run(() => void addProjectFromDialog())
    },
    {
      id: 'shortcuts',
      label: t('Keyboard shortcuts'),
      icon: Keyboard,
      keywords: 'keyboard shortcuts keybindings keys preset vscode cursor customize tastiera scorciatoie tasti personalizza',
      perform: () => run(() => useSettings.getState().openSection('shortcuts'))
    },
    {
      id: 'theme',
      label: t('Change theme…'),
      icon: Palette,
      keywords: 'change theme light dark appearance settings colors circuit cambia tema chiaro scuro aspetto impostazioni colori',
      hint: themeById(themeId).name,
      perform: () => run(() => useSettings.getState().setSettingsOpen(true))
    },
    {
      id: 'sidebar',
      label: sidebarOpen ? t('Hide sidebar') : t('Show sidebar'),
      icon: PanelLeft,
      keywords: 'hide show sidebar side bar nascondi mostra barra laterale',
      command: 'sidebar.toggle',
      perform: () => run(() => useApp.getState().toggleSidebar())
    }
  ]
  const actionResults = searching ? actions.filter((a) => matches(tokens, normalize(`${a.label} ${a.keywords}`))) : actions

  return (
    <Command shouldFilter={false} loop label={t('Search Ladder')} className="rounded-none! bg-popover p-0">
      <div className="flex h-12 items-center gap-2.5 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <CommandPrimitive.Input
          value={query}
          onValueChange={(value) => {
            setQuery(value)
            setNotice(null)
          }}
          placeholder={t('Search sessions, conversations, touched files, projects and actions…')}
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-faint"
        />
      </div>

      <CommandList className="max-h-[min(440px,58vh)] px-1.5 py-1.5">
        <CommandEmpty className="py-8 text-sm text-muted-foreground">{t('No results for “{query}”.', { query: query.trim() })}</CommandEmpty>

        {sessionResults.length > 0 && (
          <CommandGroup heading={searching ? t('Sessions') : t('Recent sessions')}>
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
                    <AgentMark agent={session.agent} size={12} />
                    {state === 'waiting' ? (
                      <span className="shrink-0 font-semibold text-attention">{session.waitingLabel ?? t('Needs you')}</span>
                    ) : state === 'error' ? (
                      <span className="shrink-0 font-semibold text-destructive">{t('Error')}</span>
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

        {contentHits.length > 0 && (
          <CommandGroup heading={t('In conversations')}>
            {contentHits.map((hit) => {
              const session = sessions[hit.sessionId]
              return (
                <CommandItem key={`hit:${hit.sessionId}`} value={`hit:${hit.sessionId}`} className={itemClass} onSelect={() => run(() => useApp.getState().openSessionAt(hit.sessionId, hit.itemId))}>
                  <MessageSquareText className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.6} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{session.title}</span>
                    <span className={hit.kind === 'file' || hit.kind === 'command' ? 'truncate font-mono text-xs text-muted-foreground' : 'truncate text-xs text-muted-foreground'}>{hit.snippet}</span>
                  </span>
                  <CommandShortcut className={sideClass}>
                    <span className="truncate">{projectNames.get(session.projectId)}</span>
                  </CommandShortcut>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}

        {actionResults.length > 0 && (
          <CommandGroup heading={t('Actions')}>
            {actionResults.map((action) => (
              <CommandItem key={action.id} value={`action:${action.id}`} className={itemClass} disabled={action.disabled} onSelect={action.perform}>
                <action.icon className="size-[15px] text-muted-foreground" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                {(action.command || action.hint) && (
                  <CommandShortcut className={sideClass}>
                    {action.hint && <span className="text-faint">{action.hint}</span>}
                    {action.command && shortcutLabel(action.command) && <Kbd>{shortcutLabel(action.command)}</Kbd>}
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {projectResults.length > 0 && (
          <CommandGroup heading={t('Projects')}>
            {projectResults.map((project, index) => (
              <CommandItem
                key={project.id}
                value={`project:${project.id}`}
                className={itemClass}
                onSelect={() =>
                  run(() => {
                    useApp.getState().selectProject(project.id)
                  })
                }
              >
                <Folder className="size-[15px] text-muted-foreground" strokeWidth={1.6} />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <CommandShortcut className={sideClass}>
                  <span className="truncate text-faint">{shortPath(project.path)}</span>
                  {index < 9 && <Kbd>{shortcutLabel(`project.select${index + 1}` as CommandId)}</Kbd>}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>

      <div className="flex h-9 items-center gap-3 border-t border-border px-4 text-xs text-faint">
        {/* Regione sempre presente, così il lettore di schermo annuncia il messaggio quando compare. */}
        <span role="status" className={notice ? 'font-medium text-foreground' : 'sr-only'}>
          {notice}
        </span>
        {!notice && (
          <>
            <span>
              <Kbd>↑↓</Kbd> {t('to select')}
            </span>
            <span>
              <Kbd>↵</Kbd> {t('to open')}
            </span>
          </>
        )}
        <span className="ml-auto">
          <Kbd>esc</Kbd> {t('to close')}
        </span>
      </div>
    </Command>
  )
}
