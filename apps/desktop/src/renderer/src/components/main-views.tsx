import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  FolderTree,
  FolderPlus,
  GitBranch,
  GitFork,
  HardDrive,
  Play,
  RotateCcw,
  SquareTerminal,
  TriangleAlert,
  X
} from 'lucide-react'
import type { AgentId, AgentStatus, Attachment, ChatItem, Effort, IssueItem, PermissionLevel, Project, ProjectSettings, RequestResponse, SessionSummary, TerminalInfo } from '@shared/protocol'
import { allowedLevels, FALLBACK_AGENT, supportsEffort } from '@/lib/agents'
import { SOURCE_ICON } from '@/components/new-from'
import { AgentMark, modelLabel } from '@/components/agent-mark'
import { AgentMapChip } from '@/components/agent-map'
import { addProjectFromDialog, ShowSidebarButton } from '@/components/app-sidebar'
import { ChatView } from '@/components/chat/chat-view'
import { LadderEngraved } from '@/components/brand/logo'
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
import { useSettings } from '@/hooks/use-theme'
import { useApp } from '@/store/app-store'
import { t } from '@shared/i18n'
import { Kbd } from '@/components/ui/kbd'

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
  'no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent'

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
        {label} <Kbd className="ml-1">{shortcut}</Kbd>
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
          <TooltipTrigger aria-label={t('Problems in .ladder/settings.toml')} className="no-drag grid size-7 place-items-center rounded-md text-attention outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
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
        <button key={action.name} type="button" onClick={() => void start(action.name)} title={`${action.command}\n${t('In the session terminal')}`} className={barButton}>
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
      {/* Compatto: il nome dell'editor sta nel suggerimento, la barra resta alle tab. */}
      <Tooltip>
        <TooltipTrigger render={<button type="button" />} onClick={() => openInEditor(project.id, root)} aria-label={t('Open in {editor}', { editor: EDITOR_NAME[editor] })} className={cn(barButton, 'rounded-r-none pr-1')}>
          <ExternalLink className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('Open in {editor}', { editor: EDITOR_NAME[editor] })}</TooltipContent>
      </Tooltip>
      <DropdownMenu onOpenChange={(open) => open && !installed && void window.ladder?.editors().then(setInstalled)}>
        <DropdownMenuTrigger aria-label={t('Choose editor')} className={cn(barButton, 'rounded-l-none px-1')}>
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('Editor for {project}', { project: project.name })}</DropdownMenuLabel>
            {(['cursor', 'vscode'] as const).map((id) => (
              <DropdownMenuItem key={id} onClick={() => choose(id)}>
                <Check className={cn('size-3.5', editor === id ? '' : 'opacity-0')} />
                {EDITOR_NAME[id]}
                {installed && !installed[id] && <span className="ml-auto text-xs text-faint">{t('not found')}</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <p className="px-2 py-1 text-xs text-muted-foreground">{t('⌥-click a file in the chat to open it here, at the right line.')}</p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function TopBar({ children, project, session, root }: { children?: ReactNode; project: Project | null; session: SessionSummary | null; root: string | null }) {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const filesOpen = useApp((s) => (project ? Boolean(s.ui[project.id]?.inspector?.open) && s.ui[project.id]?.inspector?.tab === 'files' : false))
  const terminalOpen = useApp((s) => (project ? Boolean(s.ui[project.id]?.terminal?.open) : false))
  const toggleInspector = useApp((s) => s.toggleInspector)
  const setPanel = useApp((s) => s.setTerminalPanel)
  return (
    // Con la sidebar nascosta i semafori di macOS stanno sopra questa barra: 82px di margine, come nella sidebar.
    <div className={`drag flex h-11 shrink-0 items-center gap-1 pr-2 ${sidebarOpen ? 'pl-3' : 'pl-[82px]'}`}>
      {!sidebarOpen && <ShowSidebarButton />}
      {project && (
        // Dove sei: anche a sidebar chiusa si legge il progetto a cui appartengono le tab.
        <div className="mr-1 flex max-w-[220px] min-w-0 shrink-0 items-center gap-1.5 text-sm" title={root ?? project.path}>
          <FolderOpen aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="truncate font-medium">{project.name}</span>
          {(session?.branch ?? project.branch) && (
            <>
              <span aria-hidden className="text-faint">/</span>
              <span className="truncate text-muted-foreground">{session?.branch ?? project.branch}</span>
            </>
          )}
        </div>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {project && (
        <>
          <RunButtons project={project} session={session} />
          <BarIcon label={terminalOpen ? t('Hide terminal') : t('Terminal')} shortcut="⌃`" active={terminalOpen} onClick={() => {
              if (!terminalOpen) focusNextTerminal()
              setPanel(project.id, { open: !terminalOpen })
            }}>
            <SquareTerminal className="size-4" strokeWidth={1.75} />
          </BarIcon>
          <Tooltip>
            <TooltipTrigger
              aria-pressed={filesOpen}
              onClick={() => toggleInspector(project.id, 'files')}
              className={cn(
                'no-drag flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                filesOpen && 'bg-accent text-foreground'
              )}
            >
              <FolderTree aria-hidden className="size-4" strokeWidth={1.75} />
              {t('Files')}
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('Files of this project')} <Kbd className="ml-1">⌘⌥2</Kbd>
            </TooltipContent>
          </Tooltip>
          {root && <EditorButton project={project} root={root} />}
        </>
      )}
    </div>
  )
}

/** Colonna centrale con il pannello terminale in basso e l'ispettore a destra. */
export function Workspace({ project, session, root, composerKey, children }: { project: Project; session: SessionSummary | null; root: string; composerKey: string | null; children: ReactNode }) {
  const inspectorOpen = useApp((s) => Boolean(s.ui[project.id]?.inspector?.open))
  const terminalOpen = useApp((s) => Boolean(s.ui[project.id]?.terminal?.open))
  const terminalRight = useApp((s) => s.ui[project.id]?.terminal?.side === 'right')
  const terminal = terminalOpen ? <TerminalPanel projectId={project.id} sessionId={session?.id ?? null} cwd={root} composerKey={composerKey} /> : null
  return (
    <main className="flex min-w-0 flex-1 bg-background">
      <div className="flex min-w-0 flex-1 flex-col">
        {children}
        {!terminalRight && terminal}
      </div>
      {terminalRight && terminal}
      {inspectorOpen && <Inspector projectId={project.id} root={root} isGit={project.isGit} session={session} composerKey={composerKey} />}
    </main>
  )
}

const contextButton =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent disabled:opacity-50'

function useAgentStatus(agent: AgentId | undefined): AgentStatus | null {
  const agents = useApp((s) => s.agents)
  return agents.find((a) => a.agent === agent) ?? null
}

/** Sottotitolo di un agente nei menu: account e versione, oppure il motivo per cui non c'è. */
function agentDetail(status: AgentStatus, allowed: boolean): string {
  if (!allowed) return t('Not allowed by the project (.ladder/settings.toml)')
  if (!status.available) return status.error ?? t('Not available')
  return [status.kind === 'acp' ? 'ACP' : null, status.account, status.version ? `v${status.version}` : null].filter(Boolean).join(' · ') || t('Ready')
}

// ── Nuova chat ──────────────────────────────────────────────────────────────

type Launch = { mode: 'chat'; agent: AgentId } | { mode: 'terminal'; command: string }

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
  { command: 'claude', label: 'Claude Code in the terminal', hint: 'The original TUI; status comes from hooks' },
  { command: 'codex', label: 'Codex in the terminal', hint: 'Status comes from TUI notifications' }
]

/** Nuova chat: composer al centro con progetto, branch, cartella e modalità sopra, come nella finestra agenti di Cursor. */
export function NewChat({ projectId }: { projectId: string | null }) {
  const projects = useApp((s) => s.projects)
  const select = useApp((s) => s.select)
  const agents = useApp((s) => s.agents)
  const project = projects.find((p) => p.id === projectId) ?? projects[0] ?? null
  const lastAgent = useApp((s) => (project ? s.ui[project.id]?.lastAgent : undefined))
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<Effort | null>(null)
  const [permission, setPermission] = useState<PermissionLevel>('edit')
  const [launch, setLaunch] = useState<Launch>({ mode: 'chat', agent: lastAgent ?? 'claude-code' })
  const [worktree, setWorktree] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settings = useProjectSettings(project)
  const allowedAgents = settings?.agents.allowed ?? []
  const isAllowed = (agent: AgentId) => allowedAgents.length === 0 || allowedAgents.includes(agent)
  const chatAgent = launch.mode === 'chat' ? launch.agent : 'claude-code'
  const agentStatus = agents.find((a) => a.agent === chatAgent) ?? FALLBACK_AGENT
  const maxPermission = settings?.agents.permissionsMax ?? null
  // Agente proposto: quello di default del progetto se ammesso, poi l'ultimo usato, poi Claude Code. Si cambia dal menu.
  const chose = useRef(false)
  useEffect(() => {
    chose.current = false
  }, [project?.id])
  useEffect(() => {
    if (!settings || chose.current) return
    const candidates = [settings.agents.default, lastAgent, 'claude-code', ...agents.map((a) => a.agent)] as (AgentId | null | undefined)[]
    const pick = candidates.find((a): a is AgentId => Boolean(a && isAllowed(a) && agents.some((s) => s.agent === a && s.available)))
    if (pick && launch.mode === 'chat' && pick !== launch.agent) setLaunch({ mode: 'chat', agent: pick })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, lastAgent, agents.length])
  // Il livello di permesso non supera quello ammesso dal progetto.
  useEffect(() => {
    const levels = allowedLevels(maxPermission)
    if (!levels.includes(permission)) setPermission(levels[levels.length - 1])
  }, [maxPermission, permission])
  const chooseAgent = (agent: AgentId) => {
    chose.current = true
    setLaunch({ mode: 'chat', agent })
    setModel(null)
    setEffort(null)
  }
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
          <p className="text-base font-semibold">{t('Add your first project')}</p>
          <p className="max-w-sm text-sm text-muted-foreground">{t('Choose a repository folder. Ladder opens agent sessions inside it.')}</p>
          <button
            type="button"
            onClick={() => void addProjectFromDialog()}
            className="mt-2 inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <FolderPlus className="size-4" />
            {t('Add project')}
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
        agent: chatAgent,
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
      if (launch.mode === 'chat') {
        const current = useApp.getState().ui[project.id] ?? { tabs: [], activeTab: null, scroll: {} }
        const state = { ...current, lastAgent: chatAgent }
        useApp.getState().setUi(project.id, state)
        send({ type: 'ui.set', projectId: project.id, state })
      }
      select({ kind: 'session', projectId: project.id, sessionId: session.id })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  const launchLabel =
    launch.mode === 'chat' ? t('Chat · {agent}', { agent: agentStatus.name }) : t('Terminal · {command}', { command: launch.command.split(' ')[0] || t('command') })

  return (
    <Workspace project={project} session={null} root={project.path} composerKey={`new:${project.id}`}>
      <TopBar project={project} session={null} root={project.path}>
        <TabBar projectId={project.id} activeSessionId={null} />
      </TopBar>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-8 pb-[12vh]">
        <div className="w-full max-w-[680px]">
          <LadderEngraved className="mx-auto mb-12 h-28 w-auto" />
          <div className="mb-2 flex flex-wrap items-center gap-0.5 pl-1">
            {project.branch && (
              <span className={contextButton}>
                <GitBranch className="size-3.5" />
                {project.branch}
              </span>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger className={contextButton} disabled={!project.isGit}>
                {worktree ? <GitFork className="size-3.5" /> : <HardDrive className="size-3.5" />}
                {worktree ? t('New worktree') : t('Main checkout')}
                <ChevronDown className="size-3 text-faint" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-80">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('Where the session works')}</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => setWorktree(false)} className="items-start">
                    <Check className={cn('mt-0.5 size-3.5', worktree && 'opacity-0')} />
                    <span className="flex flex-col">
                      {t('Main checkout')}
                      <span className="text-xs text-muted-foreground">{t('The dev server you already have open sees the changes')}</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setWorktree(true)} className="items-start">
                    <Check className={cn('mt-0.5 size-3.5', !worktree && 'opacity-0')} />
                    <span className="flex flex-col">
                      {t('New worktree')}
                      <span className="text-xs text-muted-foreground">
                        {source
                          ? t(branchFor(source).existing ? 'Branch {branch} (existing)' : 'Branch {branch}', { branch: branchFor(source).name })
                          : t('Branch ladder/… from {base}', { base: project.branch ?? 'HEAD' })}
                        {settings?.worktree.setup ? t(', then “{setup}”', { setup: settings.worktree.setup }) : ''}
                        {settings?.worktree.copy.length ? t(', copies {files}', { files: settings.worktree.copy.join(', ') }) : ''}
                      </span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger className={contextButton}>
                {launch.mode === 'chat' ? <AgentMark agent={chatAgent} size={14} /> : <SquareTerminal className="size-3.5" />}
                {launchLabel}
                <ChevronDown className="size-3 text-faint" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-80">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('In chat, with Ladder approvals')}</DropdownMenuLabel>
                  {agents.map((status) => {
                    const allowed = isAllowed(status.agent)
                    return (
                      <DropdownMenuItem key={status.agent} disabled={!allowed || !status.available} onClick={() => chooseAgent(status.agent)} className="items-start">
                        <Check className={cn('mt-0.5 size-3.5', !(launch.mode === 'chat' && launch.agent === status.agent) && 'opacity-0')} />
                        <AgentMark agent={status.agent} size={14} className="mt-0.5" />
                        <span className="flex min-w-0 flex-col">
                          {status.name}
                          <span className="truncate text-xs text-muted-foreground">{agentDetail(status, allowed)}</span>
                        </span>
                      </DropdownMenuItem>
                    )
                  })}
                  <DropdownMenuItem onClick={() => useSettings.getState().openSection('agents')}>
                    <span className="pl-[22px] text-xs text-muted-foreground">{t('Add an ACP agent…')}</span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('In the terminal, with the original CLI')}</DropdownMenuLabel>
                  {TERMINAL_PRESETS.map((p) => (
                    <DropdownMenuItem key={p.command} onClick={() => setLaunch({ mode: 'terminal', command: p.command })} className="items-start">
                      <Check className={cn('mt-0.5 size-3.5', !(launch.mode === 'terminal' && launch.command === p.command) && 'opacity-0')} />
                      <span className="flex flex-col">
                        {t(p.label)}
                        <span className="text-xs text-muted-foreground">{t(p.hint)}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem
                    onClick={() => setLaunch({ mode: 'terminal', command: launch.mode === 'terminal' && !TERMINAL_PRESETS.some((p) => p.command === launch.command) ? launch.command : '' })}
                    className="items-start"
                  >
                    <Check className={cn('mt-0.5 size-3.5', !(launch.mode === 'terminal' && !TERMINAL_PRESETS.some((p) => p.command === launch.command)) && 'opacity-0')} />
                    <span className="flex flex-col">
                      {t('Other command…')}
                      <span className="text-xs text-muted-foreground">{t('Any CLI; status is estimated from output and the bell')}</span>
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
              agentName={agentStatus.name}
              agent={chatAgent}
              models={agentStatus.models}
              model={model}
              onModelChange={setModel}
              effort={effort}
              onEffortChange={setEffort}
              showEffort={supportsEffort(chatAgent)}
              permission={permission}
              onPermissionChange={setPermission}
              maxPermission={maxPermission}
              onSubmit={(text, attachments) => void create(text, attachments)}
              disabledReason={pending ? t('Preparing the session…') : !agentStatus.available ? (agentStatus.error ?? t('{agent} is not available.', { agent: agentStatus.name })) : null}
              autoFocus
            />
          ) : (
            <TerminalLauncher command={launch.command} onCommandChange={(command) => setLaunch({ mode: 'terminal', command })} pending={pending} onLaunch={(prompt) => void create(prompt, [])} />
          )}
          {error && <p className="mt-2 pl-1 text-sm text-destructive">{error}</p>}
          <p className="mt-3 pl-1 text-xs text-faint">
            <Kbd>⌘N</Kbd> {t('new chat')} · <Kbd>⌘P</Kbd> {t('open file')} · <Kbd>⌘K</Kbd> {t('search')}
          </p>
        </div>
      </div>
    </Workspace>
  )
}

const FROM_LABEL: Record<IssueItem['source'], string> = { 'github-issue': 'From issue', 'github-pr': 'From PR', linear: 'From Linear', branch: 'From branch' }

/** Da dove nasce la sessione: issue, PR o branch, con il link. */
function SourceChip({ item, onClear }: { item: IssueItem; onClear: () => void }) {
  const Icon = SOURCE_ICON[item.source]
  return (
    <div className="mb-2 flex min-w-0 items-center gap-2 rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm">
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">{t(FROM_LABEL[item.source])}</span>
      {item.source !== 'branch' && <span className="shrink-0 font-mono text-xs">{item.ref}</span>}
      <span className="min-w-0 flex-1 truncate">{item.source === 'branch' ? item.ref : item.title}</span>
      {item.url && (
        <button type="button" onClick={() => void window.ladder?.openExternal(item.url!)} className="shrink-0 text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline">
          {t('Open')}
        </button>
      )}
      <button type="button" aria-label={t('Remove')} onClick={onClear} className="grid size-5 shrink-0 place-items-center rounded text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
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
  const [portBefore, portAfter] = t('Runs in the session folder, with {port}.').split('{port}')
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-input bg-composer p-3">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        {t('Command')}
        <input
          ref={input}
          value={command}
          onChange={(e) => onCommandChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          placeholder={t('e.g. aider, gemini, pnpm test --watch')}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground outline-none focus-visible:border-ring"
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
          aria-label={t('First message')}
          placeholder={t('First message (optional): sent when the CLI starts')}
          className="w-full resize-none rounded-md bg-transparent px-1 py-1 text-base outline-none [field-sizing:content] placeholder:text-faint"
        />
      )}
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {portBefore}
          <span className="font-mono">LADDER_PORT</span>
          {portAfter}{' '}
          {program === 'claude' ? t('Ladder knows when it asks for permission.') : program === 'codex' ? t('Ladder knows when it asks for approval.') : t('Status is estimated.')}
        </p>
        <button
          type="button"
          onClick={go}
          disabled={!command.trim() || pending}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <SquareTerminal className="size-4" />
          {pending ? t('Starting…') : t('Start in terminal')}
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
  const agentStatus = useAgentStatus(session?.agent) ?? FALLBACK_AGENT
  const sessionSettings = useProjectSettings(project)
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

  const sessionModel = modelLabel(agentStatus, session?.model ?? null)
  if (!session || !project) return <main className="flex-1 bg-background" />
  const running = session.run === 'running' || session.run === 'starting' || session.run === 'waiting' || session.run === 'queued'
  const headerNotes = [session.worktree ? 'worktree' : null, session.run !== 'waiting' && isTerminal ? session.activity : null, session.estimated ? t('estimated status') : null].filter(Boolean).join(' · ')

  return (
    <Workspace project={project} session={session} root={root} composerKey={isTerminal ? null : sessionId}>
      <TopBar project={project} session={session} root={root}>
        <TabBar projectId={project.id} activeSessionId={sessionId} />
      </TopBar>
      {/* Chi lavora e dove: il titolo è già nella tab. Allineato alla colonna della conversazione, senza linee. */}
      <div className={cn('flex w-full min-w-0 items-center gap-1.5 pb-1 text-xs text-muted-foreground', isTerminal ? 'px-5' : 'mx-auto max-w-[728px] px-6')}>
        {isTerminal ? <SquareTerminal aria-hidden className="size-3.5 shrink-0" /> : <AgentMark agent={session.agent} size={14} />}
        <span className="shrink-0 font-medium text-foreground">{isTerminal ? t('{command} in the terminal', { command: session.command ?? 'claude' }) : agentStatus.name}</span>
        {!isTerminal && sessionModel && <span className="shrink-0">{sessionModel}</span>}
        {headerNotes && (
          <>
            <span aria-hidden className="text-faint">·</span>
            <span className="min-w-0 truncate">{headerNotes}</span>
          </>
        )}
        {session.run === 'waiting' && <span className="ml-auto shrink-0 font-semibold text-attention">{session.waitingLabel}</span>}
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
            {error && <p className="mb-2 w-full max-w-[680px] text-sm text-destructive">{error}</p>}
            {session.subagents?.length ? (
              <div className="mb-1.5 flex w-full max-w-[680px] justify-end">
                <AgentMapChip session={session} />
              </div>
            ) : null}
            <Composer
              key={sessionId}
              draftKey={sessionId}
              projectId={session.projectId}
              agentName={agentStatus.name}
              agent={session.agent}
              showEffort={supportsEffort(session.agent)}
              maxPermission={sessionSettings?.agents.permissionsMax ?? null}
              models={agentStatus.models}
              model={session.model}
              onModelChange={(model) => send({ type: 'session.model.set', sessionId, model })}
              effort={session.effort}
              onEffortChange={(effort) => send({ type: 'session.effort.set', sessionId, effort })}
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
              disabledReason={!agentStatus.available ? (agentStatus.error ?? t('{agent} is not available.', { agent: agentStatus.name })) : null}
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
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/60 px-5 py-2 text-sm">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {terminal?.state === 'exited'
              ? terminal.exitCode
                ? t('The process exited with code {code}.', { code: terminal.exitCode })
                : t('The process exited.')
              : terminal?.state === 'stopped'
                ? t('Ladder was restarted: the process is gone.')
                : t('Starting the CLI…')}
            {error && <span className="ml-2 text-destructive">{error}</span>}
          </span>
          {terminal && (
            <button
              type="button"
              onClick={resume}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <RotateCcw className="size-3.5" />
              {session.command?.startsWith('claude') ? t('Resume conversation') : t('Restart')}
            </button>
          )}
        </div>
      )}
      {terminal ? (
        <TerminalView key={terminal.id} id={terminal.id} composerKey={null} autoFocus className="flex-1 px-3 pt-2" />
      ) : (
        <div className="grid flex-1 place-items-center text-sm text-muted-foreground">{t('Opening the terminal…')}</div>
      )}
    </div>
  )
}
