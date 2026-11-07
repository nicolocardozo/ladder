import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ExternalLink,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitFork,
  HardDrive,
  MessageSquare,
  PanelRight,
  Play,
  RotateCcw,
  SquareTerminal,
  TriangleAlert,
  X
} from 'lucide-react'
import type { Attachment, ChatItem, Effort, IssueItem, PermissionLevel, Project, ProjectSettings, RequestResponse, SessionSummary, TerminalInfo } from '@shared/protocol'
import { SOURCE_ICON, SOURCE_LABEL } from '@/components/new-from'
import { addProjectFromDialog, ShowSidebarButton } from '@/components/app-sidebar'
import { ChatView } from '@/components/chat/chat-view'
import { LadderLockup } from '@/components/brand/logo'
import { Composer } from '@/components/composer'
import { Inspector } from '@/components/inspector/inspector'
import { EDITOR_NAME, openInEditor } from '@/components/inspector/open-file'
import { TabBar } from '@/components/tab-bar'
import { TerminalPanel } from '@/components/terminal/terminal-panel'
import { focusNextTerminal } from '@/lib/terminal-registry'
import { TerminalView } from '@/components/terminal/terminal-view'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { request, send } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

const EMPTY_ITEMS: ChatItem[] = []

// ── Configurazione del progetto ─────────────────────────────────────────────

const settingsCache = new Map<string, ProjectSettings>()

/** .ladder/settings.toml del progetto: si rilegge quando cambia la cartella o torni sulla finestra. */
export function useProjectSettings(project: Project | null): ProjectSettings | null {
  const [settings, setSettings] = useState<ProjectSettings | null>(() => (project ? (settingsCache.get(project.id) ?? null) : null))
  const version = useApp((s) => (project ? (s.fsVersion[project.path] ?? 0) : 0))
  const [focusTick, setFocusTick] = useState(0)
  useEffect(() => {
    const onFocus = () => setFocusTick((n) => n + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  useEffect(() => {
    if (!project) return
    setSettings(settingsCache.get(project.id) ?? null)
    let cancelled = false
    request<ProjectSettings>({ type: 'project.settings', projectId: project.id })
      .then((data) => {
        settingsCache.set(project.id, data)
        if (!cancelled) setSettings(data)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [project, version, focusTick])
  return settings
}

// ── Barra in alto ───────────────────────────────────────────────────────────

const barButton =
  'no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent'

function BarIcon({ label, shortcut, active, onClick, children }: { label: string; shortcut: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn('no-drag grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50', active && 'bg-accent text-foreground')}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label} <span className="ml-1 font-mono text-[11px] opacity-70">{shortcut}</span>
      </TooltipContent>
    </Tooltip>
  )
}

/** Pulsanti delle azioni [[run]]: avviano il comando nel terminale della sessione, con LADDER_PORT. */
function RunButtons({ project, session }: { project: Project; session: SessionSummary | null }) {
  const settings = useProjectSettings(project)
  const setPanel = useApp((s) => s.setTerminalPanel)
  const [error, setError] = useState<string | null>(null)
  if (!settings) return null
  const actions = [...settings.run].sort((a, b) => Number(b.default) - Number(a.default))
  const start = async (name: string) => {
    setError(null)
    try {
      const terminal = await request<TerminalInfo>({ type: 'run.start', projectId: project.id, sessionId: session?.id ?? null, name })
      setPanel(project.id, { open: true, active: terminal.id })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const problems = [...settings.errors, ...(error ? [error] : [])]
  return (
    <>
      {problems.length > 0 && (
        <Tooltip>
          <TooltipTrigger aria-label="Problemi in .ladder/settings.toml" className="no-drag grid size-7 place-items-center rounded-md text-attention outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <TriangleAlert className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-sm">
            {problems.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </TooltipContent>
        </Tooltip>
      )}
      {actions.slice(0, 4).map((action) => (
        <button key={action.name} type="button" onClick={() => void start(action.name)} title={`${action.command}\nNel terminale della sessione`} className={barButton}>
          <Play className="size-3" />
          {action.name}
        </button>
      ))}
    </>
  )
}

function EditorButton({ project, root }: { project: Project; root: string }) {
  const editor = useApp((s) => s.ui[project.id]?.editor ?? 'cursor')
  const setUi = useApp((s) => s.setUi)
  const [installed, setInstalled] = useState<{ cursor: boolean; vscode: boolean } | null>(null)
  const choose = (next: 'cursor' | 'vscode') => {
    const current = useApp.getState().ui[project.id] ?? { tabs: [], activeTab: null, scroll: {} }
    const state = { ...current, editor: next }
    setUi(project.id, state)
    send({ type: 'ui.set', projectId: project.id, state })
  }
  return (
    <div className="no-drag flex items-center">
      <button type="button" onClick={() => openInEditor(project.id, root)} className={cn(barButton, 'rounded-r-none pr-1.5')}>
        Apri in {EDITOR_NAME[editor]}
        <ExternalLink className="size-3.5" />
      </button>
      <DropdownMenu onOpenChange={(open) => open && !installed && void window.ladder?.editors().then(setInstalled)}>
        <DropdownMenuTrigger aria-label="Scegli l’editor" className={cn(barButton, 'rounded-l-none px-1')}>
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Editor per {project.name}</DropdownMenuLabel>
            {(['cursor', 'vscode'] as const).map((id) => (
              <DropdownMenuItem key={id} onClick={() => choose(id)}>
                <Check className={cn('size-3.5', editor === id ? '' : 'opacity-0')} />
                {EDITOR_NAME[id]}
                {installed && !installed[id] && <span className="ml-auto text-[11px] text-faint">non trovato</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <p className="px-2 py-1 text-[11.5px] text-muted-foreground">⌥clic su un file nella chat lo apre qui, alla riga giusta.</p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function TopBar({ children, project, session, root }: { children?: ReactNode; project: Project | null; session: SessionSummary | null; root: string | null }) {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const inspectorOpen = useApp((s) => (project ? Boolean(s.ui[project.id]?.inspector?.open) : false))
  const terminalOpen = useApp((s) => (project ? Boolean(s.ui[project.id]?.terminal?.open) : false))
  const toggleInspector = useApp((s) => s.toggleInspector)
  const setPanel = useApp((s) => s.setTerminalPanel)
  return (
    // Con la sidebar nascosta i semafori di macOS stanno sopra questa barra: 82px di margine, come nella sidebar.
    <div className={`drag flex h-11 shrink-0 items-center gap-1 pr-2 ${sidebarOpen ? 'pl-3' : 'pl-[82px]'}`}>
      {!sidebarOpen && <ShowSidebarButton />}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {project && (
        <>
          <RunButtons project={project} session={session} />
          <BarIcon label={terminalOpen ? 'Nascondi il terminale' : 'Terminale'} shortcut="⌃`" active={terminalOpen} onClick={() => {
              if (!terminalOpen) focusNextTerminal()
              setPanel(project.id, { open: !terminalOpen })
            }}>
            <SquareTerminal className="size-4" strokeWidth={1.75} />
          </BarIcon>
          <BarIcon label={inspectorOpen ? 'Chiudi l’ispettore' : 'Modifiche, file e cronologia'} shortcut="⌘⌥1–4" active={inspectorOpen} onClick={() => toggleInspector(project.id)}>
            <PanelRight className="size-4" strokeWidth={1.75} />
          </BarIcon>
          {root && <EditorButton project={project} root={root} />}
        </>
      )}
    </div>
  )
}

/** Colonna centrale con il pannello terminale in basso e l'ispettore a destra. */
function Workspace({ project, session, root, composerKey, children }: { project: Project; session: SessionSummary | null; root: string; composerKey: string | null; children: ReactNode }) {
  const inspectorOpen = useApp((s) => Boolean(s.ui[project.id]?.inspector?.open))
  const terminalOpen = useApp((s) => Boolean(s.ui[project.id]?.terminal?.open))
  return (
    <main className="flex min-w-0 flex-1 bg-background">
      <div className="flex min-w-0 flex-1 flex-col">
        {children}
        {terminalOpen && <TerminalPanel projectId={project.id} sessionId={session?.id ?? null} cwd={root} composerKey={composerKey} />}
      </div>
      {inspectorOpen && <Inspector projectId={project.id} root={root} isGit={project.isGit} session={session} composerKey={composerKey} />}
    </main>
  )
}

const contextButton =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent disabled:opacity-50'

function useClaudeStatus() {
  const agents = useApp((s) => s.agents)
  return agents.find((a) => a.agent === 'claude-code') ?? null
}

// ── Nuova chat ──────────────────────────────────────────────────────────────

type Launch = { mode: 'chat' } | { mode: 'terminal'; command: string }

/** Branch del worktree per una sessione nata da issue, PR o branch. */
function branchFor(item: IssueItem): { name: string; existing: boolean; pr?: number } {
  const number = Number(item.ref.replace(/^#/, ''))
  if (item.source === 'github-pr') return { name: item.branch ?? `ladder/pr-${number}`, existing: true, pr: number }
  if (item.source === 'branch') return { name: item.branch ?? item.ref, existing: true }
  if (item.source === 'linear') return { name: item.branch ?? `ladder/${item.ref.toLowerCase()}`, existing: false }
  const words = item.title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-')
  return { name: `ladder/${number}-${words || 'issue'}`, existing: false }
}

const TERMINAL_PRESETS = [
  { command: 'claude', label: 'Claude Code nel terminale', hint: 'La TUI originale; lo stato arriva dagli hook' },
  { command: 'codex', label: 'Codex nel terminale', hint: 'Lo stato arriva dalle notifiche della TUI' }
]

/** Nuova chat: composer al centro con progetto, branch, cartella e modalità sopra, come nella finestra agenti di Cursor. */
export function NewChat({ projectId }: { projectId: string | null }) {
  const projects = useApp((s) => s.projects)
  const select = useApp((s) => s.select)
  const claude = useClaudeStatus()
  const project = projects.find((p) => p.id === projectId) ?? projects[0] ?? null
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<Effort | null>(null)
  const [permission, setPermission] = useState<PermissionLevel>('edit')
  const [launch, setLaunch] = useState<Launch>({ mode: 'chat' })
  const [worktree, setWorktree] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settings = useProjectSettings(project)
  // Issue, PR o branch scelti con ⌘⇧N: il prompt diventa la bozza e il worktree si prepara sul branch giusto.
  const source = useApp((s) => (project && s.newSource?.projectId === project.id ? s.newSource.item : null))
  const [composerRev, setComposerRev] = useState(0)
  const sourceKey = source ? `${source.source}:${source.ref}` : null
  useEffect(() => {
    if (!project || !source) return
    setWorktree(project.isGit && !(source.source === 'branch' && source.branch === project.branch))
    if (source.source === 'branch') return
    let cancelled = false
    const vars = { ref: source.ref, title: source.title, url: source.url ?? '', body: source.body ?? '' }
    request<string>({ type: 'prompt.render', projectId: project.id, name: source.source === 'github-pr' ? 'pull_request' : 'issue', vars })
      .then((text) => {
        if (cancelled) return
        const key = `new:${project.id}`
        useApp.getState().setDraft(key, text)
        send({ type: 'draft.set', key, text })
        setComposerRev((n) => n + 1)
      })
      .catch((e: Error) => setError(e.message))
    return () => {
      cancelled = true
    }
    // Solo quando cambia la scelta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, project?.id])

  if (!project) {
    return (
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <TopBar project={null} session={null} root={null} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-[14vh] text-center">
          <p className="text-[15px] font-semibold">Aggiungi il primo progetto</p>
          <p className="max-w-sm text-[13px] text-muted-foreground">Scegli la cartella di un repository. Ladder apre le sessioni degli agenti lì dentro.</p>
          <button
            type="button"
            onClick={() => void addProjectFromDialog()}
            className="mt-2 inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <FolderPlus className="size-4" />
            Aggiungi progetto
          </button>
        </div>
      </main>
    )
  }

  const create = async (text: string, attachments: Attachment[]) => {
    setError(null)
    setPending(true)
    try {
      const session = await request<SessionSummary>({
        type: 'session.create',
        projectId: project.id,
        agent: 'claude-code',
        text,
        model,
        effort,
        permission,
        attachments: attachments.length > 0 ? attachments : undefined,
        mode: launch.mode,
        command: launch.mode === 'terminal' ? launch.command : undefined,
        worktree,
        branch: source && worktree ? branchFor(source) : null,
        source: source ? { kind: source.source, ref: source.ref, title: source.title, url: source.url } : null,
        title: source ? (source.source === 'branch' ? source.ref : source.title) : undefined
      })
      send({ type: 'draft.set', key: `new:${project.id}`, text: '' })
      useApp.getState().setDraft(`new:${project.id}`, '')
      useApp.getState().setNewSource(null)
      select({ kind: 'session', projectId: project.id, sessionId: session.id })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  const launchLabel = launch.mode === 'chat' ? 'Chat · Claude Code' : `Terminale · ${launch.command.split(' ')[0] || 'comando'}`

  return (
    <Workspace project={project} session={null} root={project.path} composerKey={`new:${project.id}`}>
      <TopBar project={project} session={null} root={project.path}>
        <TabBar projectId={project.id} activeSessionId={null} />
      </TopBar>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-8 pb-[12vh]">
        <div className="w-full max-w-[680px]">
          <LadderLockup className="mb-6 ml-1 h-5 w-auto" title="Ladder" />
          <div className="mb-2 flex flex-wrap items-center gap-0.5 pl-1">
            <DropdownMenu>
              <DropdownMenuTrigger className={contextButton}>
                <FolderGit2 className="size-3.5" />
                {project.name}
                <ChevronDown className="size-3 text-faint" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Progetto</DropdownMenuLabel>
                  {projects.map((p) => (
                    <DropdownMenuItem key={p.id} onClick={() => select({ kind: 'new', projectId: p.id })}>
                      <Check className={p.id === project.id ? 'size-3.5' : 'size-3.5 opacity-0'} />
                      {p.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onClick={() => void addProjectFromDialog()}>
                    <FolderPlus className="size-3.5" />
                    Aggiungi progetto…
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {project.branch && (
              <span className={contextButton}>
                <GitBranch className="size-3.5" />
                {project.branch}
              </span>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger className={contextButton} disabled={!project.isGit}>
                {worktree ? <GitFork className="size-3.5" /> : <HardDrive className="size-3.5" />}
                {worktree ? 'Nuovo worktree' : 'Checkout principale'}
                <ChevronDown className="size-3 text-faint" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-80">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Dove lavora la sessione</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => setWorktree(false)} className="items-start">
                    <Check className={cn('mt-0.5 size-3.5', worktree && 'opacity-0')} />
                    <span className="flex flex-col">
                      Checkout principale
                      <span className="text-[11.5px] text-muted-foreground">Il dev server che hai già aperto vede le modifiche</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setWorktree(true)} className="items-start">
                    <Check className={cn('mt-0.5 size-3.5', !worktree && 'opacity-0')} />
                    <span className="flex flex-col">
                      Nuovo worktree
                      <span className="text-[11.5px] text-muted-foreground">
                        {source ? `Branch ${branchFor(source).name}${branchFor(source).existing ? ' (esistente)' : ''}` : `Branch ladder/… da ${project.branch ?? 'HEAD'}`}
                        {settings?.worktree.setup ? `, poi “${settings.worktree.setup}”` : ''}
                        {settings?.worktree.copy.length ? `, copia ${settings.worktree.copy.join(', ')}` : ''}
                      </span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger className={contextButton}>
                {launch.mode === 'chat' ? <MessageSquare className="size-3.5" /> : <SquareTerminal className="size-3.5" />}
                {launchLabel}
                <ChevronDown className="size-3 text-faint" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-80">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Agente per questa sessione</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => setLaunch({ mode: 'chat' })} className="items-start">
                    <Check className={cn('mt-0.5 size-3.5', launch.mode !== 'chat' && 'opacity-0')} />
                    <span className="flex flex-col">
                      Claude Code in chat
                      <span className="text-[11.5px] text-muted-foreground">{claude?.account ?? 'Abbonamento'} · approvazioni nella chat</span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Nel terminale, con la CLI originale</DropdownMenuLabel>
                  {TERMINAL_PRESETS.map((p) => (
                    <DropdownMenuItem key={p.command} onClick={() => setLaunch({ mode: 'terminal', command: p.command })} className="items-start">
                      <Check className={cn('mt-0.5 size-3.5', !(launch.mode === 'terminal' && launch.command === p.command) && 'opacity-0')} />
                      <span className="flex flex-col">
                        {p.label}
                        <span className="text-[11.5px] text-muted-foreground">{p.hint}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem
                    onClick={() => setLaunch({ mode: 'terminal', command: launch.mode === 'terminal' && !TERMINAL_PRESETS.some((p) => p.command === launch.command) ? launch.command : '' })}
                    className="items-start"
                  >
                    <Check className={cn('mt-0.5 size-3.5', !(launch.mode === 'terminal' && !TERMINAL_PRESETS.some((p) => p.command === launch.command)) && 'opacity-0')} />
                    <span className="flex flex-col">
                      Altro comando…
                      <span className="text-[11.5px] text-muted-foreground">Qualunque CLI; lo stato è stimato da output e campanello</span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {source && <SourceChip item={source} onClear={() => useApp.getState().setNewSource(null)} />}
          {launch.mode === 'chat' ? (
            <Composer
              key={`new:${project.id}:${composerRev}`}
              draftKey={`new:${project.id}`}
              projectId={project.id}
              agentName="Claude Code"
              models={claude?.models ?? []}
              model={model}
              onModelChange={setModel}
              effort={effort}
              onEffortChange={setEffort}
              permission={permission}
              onPermissionChange={setPermission}
              onSubmit={(text, attachments) => void create(text, attachments)}
              disabledReason={pending ? 'Preparo la sessione…' : claude && !claude.available ? claude.error : null}
              autoFocus
            />
          ) : (
            <TerminalLauncher command={launch.command} onCommandChange={(command) => setLaunch({ mode: 'terminal', command })} pending={pending} onLaunch={(prompt) => void create(prompt, [])} />
          )}
          {error && <p className="mt-2 pl-1 text-[12.5px] text-destructive">{error}</p>}
          <p className="mt-3 pl-1 text-[11.5px] text-faint">
            <kbd className="font-mono">⌘N</kbd> nuova chat · <kbd className="font-mono">⌘P</kbd> apri file · <kbd className="font-mono">⌃`</kbd> terminale ·{' '}
            <kbd className="font-mono">⌘⇧N</kbd> da issue o PR · <kbd className="font-mono">⌘⌥2</kbd> file
            {claude?.account && <> · Claude Code con {claude.account}</>}
            {claude?.version && <> · CLI {claude.version}</>}
          </p>
        </div>
      </div>
    </Workspace>
  )
}

/** Da dove nasce la sessione: issue, PR o branch, con il link. */
function SourceChip({ item, onClear }: { item: IssueItem; onClear: () => void }) {
  const Icon = SOURCE_ICON[item.source]
  return (
    <div className="mb-2 flex min-w-0 items-center gap-2 rounded-lg border border-input bg-card px-2.5 py-1.5 text-[12.5px]">
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">Da {SOURCE_LABEL[item.source]}</span>
      {item.source !== 'branch' && <span className="shrink-0 font-mono text-[12px]">{item.ref}</span>}
      <span className="min-w-0 flex-1 truncate">{item.source === 'branch' ? item.ref : item.title}</span>
      {item.url && (
        <button type="button" onClick={() => void window.ladder?.openExternal(item.url!)} className="shrink-0 text-[11.5px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline">
          Apri
        </button>
      )}
      <button type="button" aria-label="Togli" onClick={onClear} className="grid size-5 shrink-0 place-items-center rounded text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
        <X className="size-3" />
      </button>
    </div>
  )
}

function TerminalLauncher({ command, onCommandChange, pending, onLaunch }: { command: string; onCommandChange: (command: string) => void; pending: boolean; onLaunch: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState('')
  const program = command.trim().split(/\s+/)[0]?.split('/').pop() ?? ''
  const agentCli = program === 'claude' || program === 'codex'
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!command) input.current?.focus()
  }, [command])
  const go = () => command.trim() && !pending && onLaunch(agentCli ? prompt.trim() : '')
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-input bg-composer p-3">
      <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
        Comando
        <input
          ref={input}
          value={command}
          onChange={(e) => onCommandChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          placeholder="per esempio: aider, gemini, pnpm test --watch"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[12.5px] text-foreground outline-none focus-visible:border-ring"
        />
      </label>
      {agentCli && (
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault()
              go()
            }
          }}
          rows={2}
          aria-label="Primo messaggio"
          placeholder="Primo messaggio (facoltativo): parte con la CLI"
          className="w-full resize-none rounded-md bg-transparent px-1 py-1 text-[14px] outline-none [field-sizing:content] placeholder:text-faint"
        />
      )}
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[11.5px] text-muted-foreground">
          Gira nella cartella della sessione, con <span className="font-mono">LADDER_PORT</span>.{' '}
          {program === 'claude' ? 'Ladder sa quando chiede un permesso.' : program === 'codex' ? 'Ladder sa quando chiede un’approvazione.' : 'Lo stato è stimato.'}
        </p>
        <button
          type="button"
          onClick={go}
          disabled={!command.trim() || pending}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <SquareTerminal className="size-4" />
          {pending ? 'Avvio…' : 'Avvia nel terminale'}
        </button>
      </div>
    </div>
  )
}

// ── Sessione ────────────────────────────────────────────────────────────────

/** Sessione esistente: conversazione e composer, oppure la CLI nel suo terminale. */
export function SessionView({ sessionId }: { sessionId: string }) {
  const session = useApp((s) => s.sessions[sessionId])
  const project = useApp((s) => s.projects.find((p) => p.id === s.sessions[sessionId]?.projectId) ?? null)
  const items = useApp((s) => s.items[sessionId] ?? EMPTY_ITEMS)
  const loaded = useApp((s) => sessionId in s.items)
  const firstUnread = useApp((s) => s.firstUnread[sessionId] ?? null)
  const ui = useApp((s) => (project ? s.ui[project.id] : undefined))
  const setUi = useApp((s) => s.setUi)
  const openInspector = useApp((s) => s.openInspector)
  const focusTarget = useApp((s) => (s.focusTarget?.sessionId === sessionId ? s.focusTarget : null))
  const consumeFocus = useApp((s) => s.consumeFocus)
  const claude = useClaudeStatus()
  const [error, setError] = useState<string | null>(null)
  const uiTimer = useRef<number | null>(null)
  const isTerminal = session?.mode === 'terminal'

  // Nelle sessioni terminale il focus va al terminale stesso: la richiesta è nella TUI.
  useEffect(() => {
    if (isTerminal && focusTarget) consumeFocus(focusTarget.nonce)
  }, [isTerminal, focusTarget, consumeFocus])

  useEffect(() => {
    if (!loaded) send({ type: 'session.open', sessionId })
  }, [sessionId, loaded])

  // Segna come letta quando la sessione è visibile, la finestra è attiva e il turno è finito.
  useEffect(() => {
    // "Segna come da leggere" sulla sessione aperta non deve essere annullato subito.
    if (!session?.unread || useApp.getState().heldUnread === sessionId) return
    const mark = () => {
      if (document.hasFocus()) send({ type: 'session.read', sessionId })
    }
    const timer = window.setTimeout(mark, 1500)
    window.addEventListener('focus', mark)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', mark)
    }
  }, [sessionId, session?.unread, items.length])

  const onRespond = useCallback(
    (requestId: string, response: RequestResponse) => {
      request({ type: 'session.respond', sessionId, requestId, response }).catch((e: Error) => setError(e.message))
    },
    [sessionId]
  )

  const root = session?.cwd ?? project?.path ?? ''
  // Clic: viewer nell'ispettore alla riga giusta. ⌥clic: editor esterno.
  const onOpenFile = useCallback(
    (path: string, line?: number, external?: boolean) => {
      if (!project) return
      const absolute = path.startsWith('/') ? path : `${root}/${path}`
      const relative = absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : null
      if (external || !relative) openInEditor(project.id, absolute, line)
      else openInspector(project.id, 'files', { path: relative, line })
    },
    [project, root, openInspector]
  )
  const onOpenDiff = useCallback(
    (turnId: string, path?: string) => {
      if (project) openInspector(project.id, 'changes', { scope: { kind: 'turn', sessionId, turnId }, path })
    },
    [project, sessionId, openInspector]
  )

  const initialAnchor = useMemo(() => ui?.scroll[sessionId] ?? null, [sessionId]) // solo all'apertura
  const onAnchorChange = useCallback(
    (anchor: { itemId: string; offset: number }) => {
      if (!project) return
      const current = useApp.getState().ui[project.id] ?? { tabs: [], activeTab: null, scroll: {} }
      const next = { ...current, activeTab: sessionId, scroll: { ...current.scroll, [sessionId]: anchor } }
      setUi(project.id, next)
      if (uiTimer.current) window.clearTimeout(uiTimer.current)
      uiTimer.current = window.setTimeout(() => send({ type: 'ui.set', projectId: project.id, state: next }), 400)
    },
    [project, sessionId, setUi]
  )

  if (!session || !project) return <main className="flex-1 bg-background" />
  const running = session.run === 'running' || session.run === 'starting' || session.run === 'waiting' || session.run === 'queued'
  const branch = session.worktree?.branch ?? project.branch

  return (
    <Workspace project={project} session={session} root={root} composerKey={isTerminal ? null : sessionId}>
      <TopBar project={project} session={session} root={root}>
        <TabBar projectId={project.id} activeSessionId={sessionId} />
      </TopBar>
      <div className="flex min-w-0 items-baseline gap-2 border-b border-border px-5 pb-2.5">
        <span className="truncate text-[13.5px] font-semibold">{session.title}</span>
        <span className="truncate text-[12px] text-muted-foreground">
          {project.name}
          {branch ? ` · ${branch}` : ''}
          {session.worktree ? ' · worktree' : ''} · {isTerminal ? `Terminale · ${session.command ?? 'claude'}` : 'Claude Code'}
          {session.run === 'waiting' && <span className="font-semibold text-attention"> · {session.waitingLabel}</span>}
          {session.run !== 'waiting' && session.activity && isTerminal && <span> · {session.activity}</span>}
          {session.estimated && <span title="Lo stato viene da output e campanello, non da segnali dell’agente"> · stato stimato</span>}
        </span>
      </div>
      {isTerminal ? (
        <TerminalSessionBody session={session} />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col">
            <ChatView
              key={sessionId}
              sessionId={sessionId}
              items={items}
              run={session.run}
              activity={session.activity}
              firstUnreadSeq={firstUnread}
              initialAnchor={initialAnchor}
              onAnchorChange={onAnchorChange}
              onRespond={onRespond}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
              focusRequest={focusTarget ? { itemId: focusTarget.itemId, nonce: focusTarget.nonce } : null}
              onFocusDone={consumeFocus}
            />
          </div>
          <div className="flex flex-col items-center px-6 pb-4">
            {error && <p className="mb-2 w-full max-w-[680px] text-[12.5px] text-destructive">{error}</p>}
            <Composer
              key={sessionId}
              draftKey={sessionId}
              projectId={session.projectId}
              agentName="Claude Code"
              models={claude?.models ?? []}
              model={session.model}
              onModelChange={(model) => send({ type: 'session.model.set', sessionId, model })}
              effort={session.effort}
              permission={session.permission}
              onPermissionChange={(permission) => send({ type: 'session.permission.set', sessionId, permission })}
              running={running}
              onSubmit={(text, attachments) =>
                request({ type: 'session.send', sessionId, text, attachments: attachments.length > 0 ? attachments : undefined }).catch((e: Error) =>
                  setError(e.message)
                )
              }
              onStop={() => send({ type: 'session.interrupt', sessionId })}
              queue={session.queue}
              onQueueChange={(queue) => send({ type: 'session.queue.set', sessionId, queue })}
              context={session.context}
              disabledReason={claude && !claude.available ? claude.error : null}
              autoFocus={!focusTarget}
              status={session.queuedReason}
              className="max-w-[680px]"
            />
          </div>
        </>
      )}
    </Workspace>
  )
}

/** Sessione terminale: la TUI originale dell'agente a tutta altezza. Ferma dopo un'uscita o un riavvio: "Riprendi". */
function TerminalSessionBody({ session }: { session: SessionSummary }) {
  const terminal = useApp((s) => (session.terminalId ? s.terminals[session.terminalId] : undefined))
  const [error, setError] = useState<string | null>(null)
  const stopped = !terminal || terminal.state !== 'running'
  const resume = () => {
    setError(null)
    request({ type: 'session.resume', sessionId: session.id }).catch((e: Error) => setError(e.message))
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {stopped && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/60 px-5 py-2 text-[12.5px]">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {terminal?.state === 'exited'
              ? `Il processo è terminato${terminal.exitCode ? ` con codice ${terminal.exitCode}` : ''}.`
              : terminal?.state === 'stopped'
                ? 'Ladder è stato riavviato: il processo non c’è più.'
                : 'Avvio della CLI…'}
            {error && <span className="ml-2 text-destructive">{error}</span>}
          </span>
          {terminal && (
            <button
              type="button"
              onClick={resume}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <RotateCcw className="size-3.5" />
              {session.command?.startsWith('claude') ? 'Riprendi la conversazione' : 'Riavvia'}
            </button>
          )}
        </div>
      )}
      {terminal ? (
        <TerminalView key={terminal.id} id={terminal.id} composerKey={null} autoFocus className="flex-1 px-3 pt-2" />
      ) : (
        <div className="grid flex-1 place-items-center text-[12.5px] text-muted-foreground">Apro il terminale…</div>
      )}
    </div>
  )
}
