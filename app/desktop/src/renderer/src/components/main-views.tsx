import { DevServerNotice } from '@/components/browser/dev-server-notice'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShortcutsRevision } from '@/lib/use-shortcuts'
import { shortcutLabel } from '@shared/shortcuts'
import {
  Bookmark,
  Check,
  ChevronDown,
  FolderOpen,
  FolderTree,
  FolderPlus,
  GitBranch,
  GitFork,
  HardDrive,
  Info,
  Play,
  RotateCcw,
  SquareTerminal,
  TriangleAlert,
  X
} from 'lucide-react'
import type { AgentId, AgentStatus, Attachment, ChatItem, Effort, IssueItem, PermissionLevel, Project, ProjectSettings, RequestResponse, SessionSummary, TerminalInfo } from '@shared/protocol'
import { allowedLevels, FALLBACK_AGENT, supportsEffort } from '@/lib/agents'
import { agentsRunning } from '@/lib/session-state'
import { SOURCE_ICON } from '@/components/new-from'
import { SignInNotice, useSignInNeeded } from '@/components/connections/sign-in-notice'
import { CONNECTION_NAME, connectionOfAgent, needsSignIn } from '@/lib/connections'
import { agentStatusFor, hostProfileId, isDefaultProfileId, isProfileAgent, profilesOf, projectProfileId, useProfiles } from '@/lib/profiles'
import { AgentMark } from '@/components/agent-mark'
import { runningForegroundSubagents } from '@/components/agent-map'
import { SubagentDialog } from '@/components/subagent-dialog'
import { openInEditor } from '@/components/inspector/open-file'
import { addProjectFromDialog, ShowSidebarButton } from '@/components/app-sidebar'
import { ChatView } from '@/components/chat/chat-view'
import { LadderEngraved } from '@/components/brand/logo'
import { Composer } from '@/components/composer'
import { GitChangesPill, GitStatusChip, useFirstChangeFlash, useGitStatus } from '@/components/git-status-chip'
import { Inspector } from '@/components/inspector/inspector'
import { ColumnHeader, SplitColumns, SplitDropHint } from '@/components/split-view'
import { TabBar } from '@/components/tab-bar'
import { TerminalPanel } from '@/components/terminal/terminal-panel'
import { focusNextTerminal } from '@/lib/terminal-registry'
import { TerminalView } from '@/components/terminal/terminal-view'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
import { liveColumns, useApp } from '@/store/app-store'
import { COMPACT_WIDTH, useElementWidth } from '@/lib/use-element-width'
import { plural, t } from '@shared/i18n'
import { cleanBranchPrefix, DEFAULT_BRANCH_PREFIX } from '@shared/worktree-prefs'
import { Kbd } from '@/components/ui/kbd'
import { isSendKey, sendKeyCombos, useSendKey } from '@/lib/send-key'
import { capPermission, isValidEffort, isValidModel, launchModel, resolveSessionDefaults } from '@/lib/session-defaults'
import { defaultsToken, useAgentDefaultsMap } from '@/lib/effective-defaults'
import { applyPreset, presetIssuesNote, type PresetIssue, presetSummary, setProjectDefaultPreset } from '@/lib/session-presets'
import { usePermissionChange, type PermissionChangeResult } from '@/lib/use-permission-change'

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

/** Chip del branch e pillola delle modifiche: aprono il pannello di destra su Merge e su Modifiche. */
function SessionGit({ project, session, root }: { project: Project; session: SessionSummary; root: string | null }) {
  const status = useGitStatus(session.id)
  const flash = useFirstChangeFlash(status)
  const toggleInspector = useApp((s) => s.toggleInspector)
  const openTab = useApp((s) => (s.ui[project.id]?.inspector?.open ? s.ui[project.id]?.inspector?.tab : null))
  const mergeOpen = openTab === 'merge'
  const changesOpen = openTab === 'changes'
  return (
    <div className="mr-1 flex min-w-0 shrink items-center gap-0.5">
      <GitStatusChip status={status} fallbackBranch={session.branch ?? project.branch ?? null} title={root ?? project.path} active={mergeOpen} onClick={() => toggleInspector(project.id, 'merge')} />
      {status && <GitChangesPill status={status} active={changesOpen} flash={flash} onClick={() => toggleInspector(project.id, 'changes')} />}
    </div>
  )
}

export function TopBar({ children, project, session, root }: { children?: ReactNode; project: Project | null; session: SessionSummary | null; root: string | null }) {
  useShortcutsRevision()
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const filesOpen = useApp((s) => (project ? Boolean(s.ui[project.id]?.inspector?.open) && s.ui[project.id]?.inspector?.tab === 'files' : false))
  const terminalOpen = useApp((s) => (project ? Boolean(s.ui[project.id]?.terminal?.open) : false))
  const toggleInspector = useApp((s) => s.toggleInspector)
  const setPanel = useApp((s) => s.setTerminalPanel)
  const quickOpen = useApp((s) => s.quickOpen)
  const toggleQuickOpen = useApp((s) => s.toggleQuickOpen)
  return (
    // Con la sidebar nascosta i semafori di macOS stanno sopra questa barra: 82px di margine, come nella sidebar.
    <div className={`drag flex h-11 shrink-0 items-center gap-1 pr-2 ${sidebarOpen ? 'pl-3' : 'pl-[82px]'}`}>
      {!sidebarOpen && <ShowSidebarButton />}
      {project && (
        // Dove sei: anche a sidebar chiusa si legge il progetto a cui appartengono le tab.
        <div className="mr-1 flex max-w-[220px] min-w-0 shrink-0 items-center gap-1 text-sm">
          {/* Un clic sul nome apre la ricerca dei file, come ⌘P; un secondo clic (o Esc) la chiude. */}
          <Tooltip>
            <TooltipTrigger
              render={<button type="button" />}
              aria-label={t('Search files in {project}', { project: project.name })}
              aria-expanded={quickOpen}
              aria-haspopup="dialog"
              onClick={toggleQuickOpen}
              className="no-drag flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <FolderOpen aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <span className="truncate font-medium">{project.name}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('Search files')} <Kbd className="ml-1">{shortcutLabel('quickOpen.toggle')}</Kbd>
            </TooltipContent>
          </Tooltip>
          {!session && project.branch && (
            <>
              <span aria-hidden className="text-faint">/</span>
              <span className="truncate text-muted-foreground" title={root ?? project.path}>{project.branch}</span>
            </>
          )}
        </div>
      )}
      {project && session && <SessionGit key={session.id} project={project} session={session} root={root} />}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {project && (
        <>
          <RunButtons project={project} session={session} />
          <BarIcon label={terminalOpen ? t('Hide terminal') : t('Terminal')} shortcut={shortcutLabel('terminal.toggle')} active={terminalOpen} onClick={() => {
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
              {t('Files of this project')} <Kbd className="ml-1">{shortcutLabel('inspector.files')}</Kbd>
            </TooltipContent>
          </Tooltip>
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
      {/* data-split-area: la vista su cui si trascina una tab per affiancarla (bordo destro o in basso). */}
      <div data-split-area className="relative flex min-w-0 flex-1 flex-col">
        {children}
        {!terminalRight && terminal}
        <SplitDropHint />
        <DevServerNotice projectId={project.id} />
      </div>
      {terminalRight && terminal}
      {inspectorOpen && <Inspector projectId={project.id} root={root} isGit={project.isGit} session={session} composerKey={composerKey} />}
    </main>
  )
}

const contextButton =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent disabled:opacity-50'

/** Stato dell'agente, del profilo dato se ne ha uno suo (account, modelli e limiti sono per profilo), altrimenti quello predefinito. */
function useAgentStatus(agent: AgentId | undefined, profileId?: string | null): AgentStatus | null {
  const agents = useApp((s) => s.agents)
  const own = useApp((s) => (agent ? agentStatusFor(s, agent, profileId) : null))
  return own ?? agents.find((a) => a.agent === agent) ?? null
}

/** Sottotitolo di un agente nei menu: account e versione, oppure il motivo per cui non c'è. */
function agentDetail(status: AgentStatus, allowed: boolean, signIn = false): string {
  if (!allowed) return t('Not allowed by the project (.ladder/settings.toml)')
  if (signIn) return t('Not signed in. Click to sign in.')
  if (!status.available) return status.error ?? t('Not available')
  return [status.kind === 'acp' ? 'ACP' : null, status.account, status.version ? `v${status.version}` : null].filter(Boolean).join(' · ') || t('Ready')
}

// ── Nuova chat ──────────────────────────────────────────────────────────────

type Launch = { mode: 'chat' } | { mode: 'terminal'; command: string }

/** Branch del worktree per una sessione nata da issue, PR o branch. */
function branchFor(item: IssueItem, prefix: string): { name: string; existing: boolean; pr?: number } {
  const number = Number(item.ref.replace(/^#/, ''))
  if (item.source === 'github-pr') return { name: item.branch ?? `${prefix}pr-${number}`, existing: true, pr: number }
  if (item.source === 'branch') return { name: item.branch ?? item.ref, existing: true }
  if (item.source === 'linear') return { name: item.branch ?? `${prefix}${item.ref.toLowerCase()}`, existing: false }
  const words = item.title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-')
  return { name: `${prefix}${number}-${words || 'issue'}`, existing: false }
}

const TERMINAL_PRESETS = [
  { command: 'claude', label: 'Claude Code in the terminal', hint: 'The original TUI; status comes from hooks' },
  { command: 'codex', label: 'Codex in the terminal', hint: 'Status comes from TUI notifications' }
]

/** Nuova chat: composer al centro con progetto, branch, cartella e modalità sopra, come nella finestra agenti di Cursor. */
export function NewChat({ projectId }: { projectId: string | null }) {
  useShortcutsRevision()
  const projects = useApp((s) => s.projects)
  const select = useApp((s) => s.select)
  const agents = useApp((s) => s.agents)
  const project = projects.find((p) => p.id === projectId) ?? projects[0] ?? null
  const lastAgent = useApp((s) => (project ? s.ui[project.id]?.lastAgent : undefined))
  const projectDefaults = useApp((s) => (project ? s.ui[project.id]?.defaults : undefined))
  const globalDefaults = useApp((s) => s.prefs?.defaults)
  // Scelte esplicite dell'utente nel composer: vincono sui predefiniti. undefined = nessuna scelta.
  const [chosenAgent, setChosenAgent] = useState<AgentId | null>(null)
  // Modello ed effort scelti valgono solo per l'agente per cui sono stati scelti: se l'agente risolto cambia da solo, si ignorano.
  const [modelChoice, setModelChoice] = useState<{ agent: AgentId; value: string } | null>(null)
  const [effortChoice, setEffortChoice] = useState<{ agent: AgentId; value: Effort } | null>(null)
  const [permissionChoice, setPermissionChoice] = useState<PermissionLevel | undefined>(undefined)
  // Profilo scelto per questa sessione (il predefinito è `default:<agente>`, mai null: l'host legge null come "nessuna scelta"); vale solo per l'agente per cui è stato scelto. Senza scelta decide il progetto.
  const [profileChoice, setProfileChoice] = useState<{ agent: AgentId; id: string } | null>(null)
  // Profilo di sessione (LAD-60): undefined = nessuna scelta (vale quello predefinito del progetto, se c'è), null = "nessun profilo" scelto da te.
  const [presetChoice, setPresetChoice] = useState<string | null | undefined>(undefined)
  // Il profilo ha una bozza ma ce n'era già una tua: resta la tua e lo si dice.
  const [draftKept, setDraftKept] = useState(false)
  // Ultimo testo messo in bozza da un profilo: se la bozza è ancora uguale è del profilo e si può sostituire, altrimenti è tua.
  const presetPrompt = useRef<string | null>(null)
  // Hai cambiato a mano il worktree dopo aver scelto il profilo: la nota di ripiego non lo riguarda più.
  const [worktreeEdited, setWorktreeEdited] = useState(false)
  const [launch, setLaunch] = useState<Launch>({ mode: 'chat' })
  const [worktree, setWorktree] = useState(false)
  // Con lo script di setup: null = come dice il progetto (setupWait), altrimenti la scelta di questa sessione (true = parte subito).
  const [startNow, setStartNow] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settings = useProjectSettings(project)
  const branchPrefix = useApp((s) => s.prefs?.branchPrefix)
  const prefix = branchPrefix === undefined ? DEFAULT_BRANCH_PREFIX : cleanBranchPrefix(branchPrefix)
  const allowedAgents = settings?.agents.allowed ?? []
  const isAllowed = (agent: AgentId) => allowedAgents.length === 0 || allowedAgents.includes(agent)
  const maxPermission = settings?.agents.permissionsMax ?? null
  // Predefiniti dell'agente per questo progetto (host): servono a validare l'effort contro il modello che parte davvero.
  const allProfiles = useApp((s) => s.profiles)
  const profileAgents = useApp((s) => s.profileAgents)
  const defaultsTargets = useMemo(
    () => agents.filter((a) => a.available).map((a) => ({ agent: a.agent, profileId: isProfileAgent(a.agent) ? hostProfileId(projectProfileId(project, a.agent, profilesOf(allProfiles, a.agent))) : undefined, token: defaultsToken(a) })),
    [agents, allProfiles, project]
  )
  const agentDefaultsMap = useAgentDefaultsMap(project?.id, defaultsTargets)
  const agentModels = useMemo(() => Object.fromEntries(Object.entries(agentDefaultsMap).map(([agent, d]) => [agent, d?.known ? d.model : null])), [agentDefaultsMap])
  // Profili di sessione salvati e quello in uso: la scelta esplicita, altrimenti il predefinito del progetto; un id che non esiste più si ignora.
  const presets = useApp((s) => s.prefs?.presets)
  const projectDefaultPreset = useApp((s) => (project ? s.ui[project.id]?.defaultPreset : undefined))
  const activePreset = presets?.find((p) => p.id === (presetChoice === undefined ? projectDefaultPreset : presetChoice)) ?? null
  // Il profilo si rilegge a ogni render contro lo stato di adesso (account, modelli, limiti del progetto): ciò che non vale ricade sui predefiniti.
  const applied = useMemo(
    () => (activePreset ? applyPreset(activePreset, { agents, profileAgents, profiles: allProfiles, project, allowed: allowedAgents as AgentId[], maxPermission, agentModels }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activePreset, agents, profileAgents, allProfiles, project, settings, agentModels]
  )
  // Predefiniti: progetto, poi TOML (solo agente), poi globali, poi ultimo agente (lib/session-defaults.ts).
  const resolved = useMemo(
    () => resolveSessionDefaults({ agents, project: projectDefaults, global: globalDefaults, tomlAgent: settings?.agents.default as AgentId | null | undefined, lastAgent, allowed: allowedAgents as AgentId[], maxPermission, forceAgent: chosenAgent ?? applied?.agent ?? null, agentModels }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, projectDefaults, globalDefaults, settings, lastAgent, chosenAgent, applied, agentModels]
  )
  const chatAgent: AgentId = launch.mode === 'chat' ? (resolved.agent ?? 'claude-code') : 'claude-code'
  const connections = useApp((s) => s.connections)
  const profileConnections = useApp((s) => s.profileConnections)
  const agentProfiles = useProfiles(chatAgent)
  // Con un solo profilo per agente non c'è niente da scegliere né da mostrare.
  const multiProfile = launch.mode === 'chat' && agentProfiles.length > 1
  // La scelta vale solo se il profilo esiste ancora (può essere stato rimosso): una sola verifica per l'interfaccia e per `session.create`.
  // Il profilo di sessione propone l'account; una tua scelta nel menu vince.
  const profileOwn = profileChoice ?? (applied?.agent && applied.profileId ? { agent: applied.agent, id: applied.profileId } : null)
  const chosenProfile = isProfileAgent(chatAgent) && profileOwn?.agent === chatAgent && agentProfiles.some((p) => p.id === profileOwn.id) ? profileOwn.id : null
  const profileId = isProfileAgent(chatAgent) ? (chosenProfile ?? projectProfileId(project, chatAgent, agentProfiles)) : null
  const profile = agentProfiles.find((p) => p.id === profileId) ?? null
  const agentStatus = (isProfileAgent(chatAgent) && !isDefaultProfileId(profileId) ? profileAgents[profileId!] : null) ?? agents.find((a) => a.agent === chatAgent) ?? FALLBACK_AGENT
  const signInNeeded = useSignInNeeded(chatAgent, profileId)
  // Scelte esplicite = tue, poi quelle del profilo di sessione: entrambe valgono solo per il loro agente.
  // Il modello del profilo vale solo per l'account che parte davvero: se scegli un altro account dal menu si ricontrolla contro il suo elenco.
  const presetModel = applied?.agent && applied.model && (agentStatus.models.length === 0 || isValidModel(agentStatus, applied.model)) ? { agent: applied.agent, value: applied.model } : null
  const modelOwn = modelChoice ?? presetModel
  const effortOwn = effortChoice ?? (applied?.agent && applied.effort ? { agent: applied.agent, value: applied.effort } : null)
  const model = modelOwn?.agent === chatAgent ? modelOwn.value : resolved.model
  const rawEffort = effortOwn?.agent === chatAgent ? effortOwn.value : resolved.effort
  // L'effort finale deve valere per il modello finale, altrimenti niente.
  const effort = isValidEffort(agentStatus, model ?? launchModel(agentStatus, agentModels), rawEffort) ? rawEffort : null
  const permission = capPermission(permissionChoice ?? applied?.permission ?? resolved.permission, maxPermission)
  // Il composer riceve solo le scelte esplicite: i predefiniti li risolve da sé (e li marca con il badge Default).
  const explicitModel = modelOwn?.agent === chatAgent ? modelOwn.value : null
  const explicitEffort = effortOwn?.agent === chatAgent && isValidEffort(agentStatus, model ?? launchModel(agentStatus, agentModels), effortOwn.value) ? effortOwn.value : null
  // Cambiando progetto le scelte esplicite decadono: la nuova chat riparte dai predefiniti di quel progetto.
  // Solo quando il progetto cambia davvero: al montaggio (e nella seconda esecuzione di StrictMode) le scelte sono già vuote,
  // e azzerarle di nuovo cancellerebbe il profilo appena scelto da ⌘K.
  const seenProject = useRef(project?.id)
  useEffect(() => {
    if (seenProject.current === project?.id) return
    seenProject.current = project?.id
    setChosenAgent(null)
    setModelChoice(null)
    setEffortChoice(null)
    setPermissionChoice(undefined)
    setProfileChoice(null)
    setPresetChoice(undefined)
    setDraftKept(false)
    setWorktreeEdited(false)
    presetPrompt.current = null
  }, [project?.id])
  // Sceglie un profilo: le tue scelte nel composer decadono e il profilo dà i valori; la bozza iniziale, se c'è, non parte da sola.
  const choosePreset = (id: string | null) => {
    setPresetChoice(id)
    setChosenAgent(null)
    setModelChoice(null)
    setEffortChoice(null)
    setPermissionChoice(undefined)
    setProfileChoice(null)
    setLaunch({ mode: 'chat' })
    setDraftKept(false)
    if (id) setWorktreeEdited(false)
    if (!project) return
    const preset = id ? presets?.find((p) => p.id === id) : null
    const next = preset?.prompt ?? ''
    const key = `new:${project.id}`
    const current = useApp.getState().drafts[key] ?? ''
    // La bozza è del profilo precedente (o vuota): si sostituisce o si svuota. Se l'hai modificata tu resta tua.
    if (!current.trim() || (presetPrompt.current !== null && current === presetPrompt.current)) {
      if (current !== next) {
        // La sostituzione passa da replaceComposerDraft: il composer non segue ogni cambio dello store (uno snapshot dopo il riavvio dell'host sovrascriverebbe il testo), né si rimonta, quindi allegati e cursore restano.
        useApp.getState().setDraft(key, next)
        send({ type: 'draft.set', key, text: next })
        useApp.getState().replaceComposerDraft(key, next)
      }
      presetPrompt.current = next || null
    } else if (next) {
      setDraftKept(true)
    }
  }
  // "Nuova chat con <profilo>" da ⌘K: si legge una volta e si azzera. Sta dopo il ripristino del progetto, così non lo scavalca.
  const newPreset = useApp((s) => s.newPreset)
  const consumedPreset = useRef<typeof newPreset>(null)
  useEffect(() => {
    if (!newPreset || !project || newPreset.projectId !== project.id) return
    // Si consuma una volta sola: lo stesso oggetto non si applica due volte (StrictMode riesegue gli effetti con la stessa chiusura).
    if (consumedPreset.current === newPreset) return
    consumedPreset.current = newPreset
    useApp.getState().setNewPreset(null)
    choosePreset(newPreset.presetId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newPreset, project?.id])
  // Il profilo decide anche il worktree (solo in un progetto git); senza profilo resta come lo hai impostato.
  const hadPreset = useRef(false)
  const presetWorktree = useRef<boolean | null>(null)
  useEffect(() => {
    if (activePreset) {
      presetWorktree.current = Boolean(activePreset.worktree && project?.isGit)
      setWorktree(presetWorktree.current)
    } else if (hadPreset.current) {
      // Senza profilo si torna al predefinito, ma solo se il valore è ancora quello messo dal profilo (non tuo, non di un'issue).
      if (!worktreeEdited && !source && worktree === presetWorktree.current) setWorktree(false)
      setWorktreeEdited(false)
    }
    hadPreset.current = Boolean(activePreset)
    // Solo quando cambia il profilo in uso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePreset?.id, project?.id])
  // Cambiare agente ricarica modello ed effort predefiniti di quell'agente; il permesso scelto resta.
  const chooseAgent = (agent: AgentId) => {
    setChosenAgent(agent)
    setLaunch({ mode: 'chat' })
    setModelChoice(null)
    setEffortChoice(null)
  }
  // Issue, PR o branch scelti con ⌘⇧N: il prompt diventa la bozza e il worktree si prepara sul branch giusto.
  const source = useApp((s) => (project && s.newSource?.projectId === project.id ? s.newSource.item : null))
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
        useApp.getState().replaceComposerDraft(key, text)
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
        // Solo se l'hai scelto tu: senza, l'host usa il profilo del progetto.
        ...(launch.mode === 'chat' && chosenProfile ? { profileId: chosenProfile } : {}),
        attachments: attachments.length > 0 ? attachments : undefined,
        mode: launch.mode,
        command: launch.mode === 'terminal' ? launch.command : undefined,
        worktree,
        ...(worktree && settings?.worktree.setup && startNow !== null ? { setupWait: !startNow } : {}),
        branch: source && worktree ? branchFor(source, prefix) : null,
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

  // Ciò che hai già corretto a mano non si segnala più.
  // Scegliere un altro agente rende superflui anche i problemi di account, modello ed effort: erano del vecchio agente.
  const agentChanged = chosenAgent !== null && chosenAgent !== applied?.agent
  const corrected: Record<PresetIssue, boolean> = { agent: chosenAgent !== null, account: profileChoice !== null || agentChanged, model: modelChoice !== null || agentChanged, effort: effortChoice !== null || agentChanged, permission: permissionChoice !== undefined, worktree: worktreeEdited }
  const shownIssues = (applied?.issues ?? []).filter((issue) => !corrected[issue])

  const launchLabel =
    launch.mode === 'chat' ? t('Chat · {agent}', { agent: multiProfile && profile ? `${agentStatus.name} · ${profile.name}` : agentStatus.name }) : t('Terminal · {command}', { command: launch.command.split(' ')[0] || t('command') })

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
                  <DropdownMenuItem onClick={() => { setWorktree(false); setWorktreeEdited(true) }} className="items-start">
                    <Check className={cn('mt-0.5 size-3.5', worktree && 'opacity-0')} />
                    <span className="flex flex-col">
                      {t('Main checkout')}
                      <span className="text-xs text-muted-foreground">{t('The dev server you already have open sees the changes')}</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setWorktree(true); setWorktreeEdited(true) }} className="items-start">
                    <Check className={cn('mt-0.5 size-3.5', !worktree && 'opacity-0')} />
                    <span className="flex flex-col">
                      {t('New worktree')}
                      <span className="text-xs text-muted-foreground">
                        {source
                          ? t(branchFor(source, prefix).existing ? 'Branch {branch} (existing)' : 'Branch {branch}', { branch: branchFor(source, prefix).name })
                          : t('Branch {prefix}… from {base}', { prefix, base: project.branch ?? 'HEAD' })}
                        {settings?.worktree.setup ? t(', then “{setup}”', { setup: settings.worktree.setup }) : ''}
                        {settings?.worktree.copy.length ? t(', copies {files}', { files: settings.worktree.copy.join(', ') }) : ''}
                      </span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                {worktree && settings?.worktree.setup && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem checked={startNow ?? !settings.worktree.setupWait} onCheckedChange={(value) => setStartNow(value)} className="items-start">
                      <span className="flex flex-col">
                        {t('Start without waiting for the setup script')}
                        <span className="text-xs text-muted-foreground">{t('The first message goes out right away and “{setup}” runs alongside.', { setup: settings.worktree.setup })}</span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  </>
                )}
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
                    // Un agente senza login si può scegliere: il clic porta alla sua riga in Impostazioni → Abbonamenti.
                    const connection = connectionOfAgent(status.agent)
                    const signIn = connection !== null && needsSignIn(connections[connection])
                    return (
                      <DropdownMenuItem key={status.agent} disabled={!allowed || (!status.available && !signIn)} onClick={() => (signIn && connection ? useApp.getState().focusConnection(connection) : chooseAgent(status.agent))} className="items-start">
                        <Check className={cn('mt-0.5 size-3.5', !(launch.mode === 'chat' && chatAgent === status.agent) && 'opacity-0')} />
                        <AgentMark agent={status.agent} size={14} className="mt-0.5" />
                        <span className="flex min-w-0 flex-col">
                          {status.name}
                          <span className="truncate text-xs text-muted-foreground">{agentDetail(status, allowed, signIn)}</span>
                        </span>
                      </DropdownMenuItem>
                    )
                  })}
                  <DropdownMenuItem onClick={() => useSettings.getState().openSection('agents')}>
                    <span className="pl-[22px] text-xs text-muted-foreground">{t('Add an ACP agent…')}</span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                {multiProfile && isProfileAgent(chatAgent) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{t('Account for {agent}', { agent: agentStatus.name })}</DropdownMenuLabel>
                      {agentProfiles.map((p) => {
                        const connection = isDefaultProfileId(p.id) ? connections[chatAgent] : profileConnections[p.id]
                        const signIn = needsSignIn(connection)
                        const status = isDefaultProfileId(p.id) ? agents.find((a) => a.agent === chatAgent) : profileAgents[p.id]
                        const detail = signIn ? t('Not signed in. Click to sign in.') : ([status?.account ?? (connection?.plan ? `${agentStatus.name} ${connection.plan}` : null), status?.email ?? connection?.email].filter(Boolean).join(' · ') || t('Ready'))
                        return (
                          <DropdownMenuItem key={p.id} onClick={() => (signIn ? useApp.getState().focusConnection(chatAgent, p.isDefault ? null : p.id) : setProfileChoice({ agent: chatAgent, id: p.id }))} className="items-start">
                            <Check className={cn('mt-0.5 size-3.5', p.id !== profileId && 'opacity-0')} />
                            <span className="flex min-w-0 flex-col">
                              {p.name}
                              <span className="truncate text-xs text-muted-foreground">{detail}</span>
                            </span>
                          </DropdownMenuItem>
                        )
                      })}
                    </DropdownMenuGroup>
                  </>
                )}
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
            {presets && presets.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger className={contextButton}>
                  <Bookmark className="size-3.5" />
                  {activePreset ? activePreset.name : t('Profile')}
                  <ChevronDown className="size-3 text-faint" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-80">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{t('Session profiles')}</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => choosePreset(null)} className="items-start">
                      <Check className={cn('mt-0.5 size-3.5', activePreset && 'opacity-0')} />
                      <span className="flex flex-col">
                        {t('No profile')}
                        <span className="text-xs text-muted-foreground">{t('Start from your defaults')}</span>
                      </span>
                    </DropdownMenuItem>
                    {presets.map((preset) => {
                      const summary = presetSummary(preset, agents)
                      return (
                        <DropdownMenuItem key={preset.id} onClick={() => choosePreset(preset.id)} className="items-start" title={preset.note ? `${summary}\n${preset.note}` : summary}>
                          <Check className={cn('mt-0.5 size-3.5', activePreset?.id !== preset.id && 'opacity-0')} />
                          <AgentMark agent={preset.agent} size={14} className="mt-0.5" />
                          <span className="flex min-w-0 flex-col">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate">{preset.name}</span>
                              {projectDefaultPreset === preset.id && <span className="inline-flex h-4 shrink-0 items-center rounded-sm bg-foreground/10 px-1 text-xs leading-none text-muted-foreground">{t('Project default')}</span>}
                            </span>
                            {/* Seconda riga: la nota, se c'è, altrimenti il riepilogo. */}
                            <span className="truncate text-xs text-muted-foreground">{preset.note ?? summary}</span>
                          </span>
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  {activePreset && (
                    <DropdownMenuItem onClick={() => setProjectDefaultPreset(project.id, projectDefaultPreset === activePreset.id ? null : activePreset.id)}>
                      <span className="pl-[22px]">
                        {projectDefaultPreset === activePreset.id ? t('Stop using it as default for {project}', { project: project.name }) : t('Use as default for {project}', { project: project.name })}
                      </span>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => useSettings.getState().openSection('defaults')}>
                    <span className="pl-[22px] text-xs text-muted-foreground">{t('Manage profiles…')}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {source && <SourceChip item={source} onClear={() => useApp.getState().setNewSource(null)} />}
          {launch.mode === 'chat' ? (
            <>
            <SignInNotice agent={chatAgent} profileId={profileId} className="mb-2" />
            <Composer
              key={`new:${project.id}`}
              profileId={profileId}
              draftKey={`new:${project.id}`}
              projectId={project.id}
              agentName={agentStatus.name}
              agent={chatAgent}
              models={agentStatus.models}
              model={explicitModel}
              onModelChange={(value) => setModelChoice({ agent: chatAgent, value })}
              onModelReset={() => setModelChoice(null)}
              effort={explicitEffort}
              onEffortChange={(value) => setEffortChoice({ agent: chatAgent, value })}
              onEffortReset={() => setEffortChoice(null)}
              showEffort={supportsEffort(chatAgent)}
              permission={permission}
              onPermissionChange={setPermissionChoice}
              maxPermission={maxPermission}
              onSubmit={(text, attachments) => void create(text, attachments)}
              disabledReason={pending ? t('Preparing the session…') : signInNeeded ? t('Sign in to {name} to start a session.', { name: CONNECTION_NAME[signInNeeded.id] }) : !agentStatus.available ? (agentStatus.error ?? t('{agent} is not available.', { agent: agentStatus.name })) : null}
              autoFocus
            />
            </>
          ) : (
            <TerminalLauncher command={launch.command} onCommandChange={(command) => setLaunch({ mode: 'terminal', command })} pending={pending} onLaunch={(prompt) => void create(prompt, [])} />
          )}
          {/* Nota discreta: ciò che del profilo non vale più qui e ha ripiegato sui predefiniti. Nessun errore. */}
          {launch.mode === 'chat' && activePreset && shownIssues.length > 0 && (
            <p role="status" className="mt-2 flex items-start gap-1.5 pl-1 text-xs text-muted-foreground">
              <Info aria-hidden className="mt-0.5 size-3 shrink-0" />
              {presetIssuesNote(activePreset.name, shownIssues)}
            </p>
          )}
          {draftKept && activePreset && (
            <p role="status" className="mt-2 flex items-start gap-1.5 pl-1 text-xs text-muted-foreground">
              <Info aria-hidden className="mt-0.5 size-3 shrink-0" />
              {t('Your draft stays as it is; the starting prompt of “{name}” was not added.', { name: activePreset.name })}
            </p>
          )}
          {error && <p className="mt-2 pl-1 text-sm text-destructive">{error}</p>}
          <p className="mt-3 pl-1 text-xs text-faint">
            <Kbd>{shortcutLabel('chat.new')}</Kbd> {t('new chat')} · <Kbd>{shortcutLabel('quickOpen.toggle')}</Kbd> {t('open file')} · <Kbd>{shortcutLabel('palette.toggle')}</Kbd> {t('search')}
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
  const sendKey = useSendKey()
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
            if (isSendKey(e, sendKey)) {
              e.preventDefault()
              go()
            }
          }}
          rows={2}
          aria-label={t('First message')}
          placeholder={sendKey === 'mod-enter' ? t('First message (optional): sent when the CLI starts. {key} to start', { key: sendKeyCombos(sendKey).send }) : t('First message (optional): sent when the CLI starts')}
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
          {agentCli && <Kbd className="opacity-70">{sendKeyCombos(sendKey).send}</Kbd>}
        </button>
      </div>
    </div>
  )
}

// ── Sessione ────────────────────────────────────────────────────────────────

/**
 * Sessione aperta: barra con le tab e una colonna, oppure, se nel progetto ci sono sessioni affiancate, tutte le colonne.
 * Ispettore e terminale sono unici e seguono la sessione attiva (quella selezionata).
 */
export function SessionView({ sessionId }: { sessionId: string }) {
  const session = useApp((s) => s.sessions[sessionId])
  const project = useApp((s) => s.projects.find((p) => p.id === s.sessions[sessionId]?.projectId) ?? null)
  // Una stringa: lo store restituisce lo stesso valore finché le colonne non cambiano, anche se le sessioni si aggiornano.
  const columnsKey = useApp((s) => (session ? liveColumns(s, session.projectId).join('\n') : ''))
  const columns = useMemo(() => (columnsKey ? columnsKey.split('\n') : []), [columnsKey])
  if (!session || !project) return <main className="flex-1 bg-background" />
  const root = session.cwd ?? project.path
  return (
    <Workspace project={project} session={session} root={root} composerKey={session.mode === 'terminal' ? null : sessionId}>
      <TopBar project={project} session={session} root={root}>
        <TabBar projectId={project.id} activeSessionId={sessionId} />
      </TopBar>
      {/* Sempre lo stesso albero, anche con una colonna sola: affiancare o chiudere una colonna non rimonta composer, immagini incollate e card aperte. */}
      <SplitColumns
        projectId={project.id}
        columns={columns.includes(sessionId) ? columns : [sessionId]}
        activeId={sessionId}
        renderColumn={(id, column) => <SessionBody key={id} sessionId={id} column={column} />}
      />
    </Workspace>
  )
}

/** Conversazione e composer di una sessione, oppure la CLI nel suo terminale. In una colonna ha anche l'intestazione con lo stato. */
function SessionBody({ sessionId, column }: { sessionId: string; column?: { active: boolean; single: boolean; hidden: number; onClose: () => void } }) {
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
  const agentStatus = useAgentStatus(session?.agent, session?.profileId) ?? FALLBACK_AGENT
  const signInNeeded = useSignInNeeded(session?.agent ?? FALLBACK_AGENT.agent, session?.profileId)
  const sessionSettings = useProjectSettings(project)
  const [error, setError] = useState<string | null>(null)
  const uiTimer = useRef<number | null>(null)
  const isTerminal = session?.mode === 'terminal'
  // Il livello nuovo si mostra solo quando l'host conferma; un rifiuto dà errore sopra il composer.
  const permissionLevels = useMemo(() => allowedLevels(sessionSettings?.agents.permissionsMax ?? null), [sessionSettings?.agents.permissionsMax])
  const applyPermission = useCallback(
    (permission: PermissionLevel) => request<PermissionChangeResult>({ type: 'session.permission.set', sessionId, permission }),
    [sessionId]
  )
  const permissionChange = usePermissionChange({
    permission: session?.permission ?? 'ask',
    permissionNext: session?.permissionNext,
    levels: permissionLevels,
    apply: applyPermission,
    onError: setError
  })
  // Una sola colonna è attiva: scorciatoie, focus iniziale e tab attiva seguono lei. Fuori dalle colonne la sessione è sempre attiva.
  const active = column ? column.active : true
  // Sotto circa 420 px la colonna passa alla vista compatta (vale anche per una colonna sola, in una finestra stretta).
  const [measure, width] = useElementWidth()
  const compact = width > 0 && width < COMPACT_WIDTH

  // Nelle sessioni terminale il focus va al terminale stesso: la richiesta è nella TUI.
  useEffect(() => {
    if (isTerminal && focusTarget) consumeFocus(focusTarget.nonce)
  }, [isTerminal, focusTarget, consumeFocus])

  useEffect(() => {
    if (!loaded) send({ type: 'session.open', sessionId })
  }, [sessionId, loaded])

  // Comandi / dell'agente: si chiedono all'apertura e a ogni riconnessione; poi arrivano con l'evento.
  const slashCommands = useApp((s) => s.commands[sessionId])
  const loadCommands = useApp((s) => s.loadCommands)
  const connected = useApp((s) => s.connected)
  useEffect(() => {
    if (!isTerminal && connected) loadCommands(sessionId)
  }, [sessionId, isTerminal, connected, loadCommands])

  // Segna come letta quando la sessione è visibile, la finestra è attiva e il turno è finito.
  useEffect(() => {
    // "Segna come da leggere" sulla sessione aperta non deve essere annullato subito.
    // Lo stesso vale per l'avviso dei sotto-agenti: sulla sessione aperta si azzera con session.read.
    const pending = session?.unread || !!session?.agentsNotice
    if (!pending || useApp.getState().heldUnread === sessionId) return
    const mark = () => {
      if (document.hasFocus()) send({ type: 'session.read', sessionId })
    }
    const timer = window.setTimeout(mark, 1500)
    window.addEventListener('focus', mark)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', mark)
    }
  }, [sessionId, session?.unread, session?.agentsNotice?.at, items.length])

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
      const next = { ...current, activeTab: active ? sessionId : current.activeTab, scroll: { ...current.scroll, [sessionId]: anchor } }
      setUi(project.id, next)
      if (uiTimer.current) window.clearTimeout(uiTimer.current)
      uiTimer.current = window.setTimeout(() => send({ type: 'ui.set', projectId: project.id, state: useApp.getState().ui[project.id] ?? next }), 400)
    },
    [project, sessionId, setUi, active]
  )

  if (!session || !project) return <div ref={measure} className="flex-1" />
  const running = session.run === 'running' || session.run === 'starting' || session.run === 'waiting'
  const runningAgents = runningForegroundSubagents(session)
  const headerNotes = [session.worktree ? 'worktree' : null, session.run !== 'waiting' && isTerminal ? session.activity : null, session.estimated ? t('estimated status') : null].filter(Boolean).join(' · ')

  return (
    <div ref={measure} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {column && !column.single && <ColumnHeader session={session} active={column.active} hidden={column.hidden} onClose={column.onClose} />}
      {/* Solo note che non stanno altrove: agente e modello di una chat sono già nel composer, il titolo nella tab. */}
      {(isTerminal || headerNotes || (session.run === 'waiting' && !(column && !column.single))) && (
        <div
          className={cn('w-full pb-1 text-xs text-muted-foreground', isTerminal ? 'flex min-w-0 items-center gap-1.5 px-5' : 'chat-col chat-gutter')}
          data-compact={!isTerminal && compact ? '' : undefined}
        >
          {/* Nella chat le note stanno sulla stessa colonna del testo. */}
          <div className={isTerminal ? 'w-full min-w-0' : 'chat-measure'}>
            <div className={cn(!isTerminal && 'chat-reset')}>
            <div className="flex min-w-0 items-center gap-1.5 text-xs">
          {isTerminal && (
            <>
              <SquareTerminal aria-hidden className="size-3.5 shrink-0" />
              <span className="shrink-0 font-medium text-foreground">{t('{command} in the terminal', { command: session.command ?? 'claude' })}</span>
            </>
          )}
          {headerNotes && (
            <>
              {isTerminal && <span aria-hidden className="text-faint">·</span>}
              <span className="min-w-0 truncate">{headerNotes}</span>
            </>
          )}
          {session.run === 'waiting' && !(column && !column.single) && <span className="ml-auto shrink-0 font-semibold text-attention">{session.waitingLabel}</span>}
            </div>
            </div>
          </div>
        </div>
      )}
      {isTerminal ? (
        <TerminalSessionBody session={session} active={active} />
      ) : (
        <>
          {/* ⇧Tab cambia i permessi con il focus sulla card di richiesta aperta. */}
          <div className="flex min-h-0 flex-1 flex-col" onKeyDown={permissionChange.onKeyDown}>
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
              compact={compact}
              active={active}
              waitingAgents={agentsRunning(session)}
              onContinue={(itemId) => request({ type: 'session.continue', sessionId, itemId })}
              onPrefill={(text) => useApp.getState().insertIntoComposer(sessionId, text)}
            />
          </div>
          {/* Il composer segue la colonna di testo (Impostazioni, Aspetto: larghezza della chat). */}
          <div className="chat-col chat-gutter pb-4" data-compact={compact ? '' : undefined}>
            <div className="chat-measure">
            <div className="chat-reset flex flex-col items-center">
            {error && <p className="mb-2 w-full text-sm text-destructive">{error}</p>}
            <SignInNotice agent={session.agent} profileId={session.profileId} className="mb-2 w-full" />
            <Composer
              key={sessionId}
              profileId={session.profileId}
              draftKey={sessionId}
              sessionId={sessionId}
              subagentCounts={session.subagentCounts}
              projectId={session.projectId}
              agentName={agentStatus.name}
              agent={session.agent}
              showEffort={supportsEffort(session.agent)}
              maxPermission={sessionSettings?.agents.permissionsMax ?? null}
              models={agentStatus.models}
              model={session.model}
              onModelChange={(model) => send({ type: 'session.model.set', sessionId, model })}
              effort={session.effort}
              effortEffective={session.effortEffective}
              onModelReset={(model) => send({ type: 'session.model.set', sessionId, model })}
              onEffortReset={(effort) => send({ type: 'session.effort.set', sessionId, effort })}
              onEffortChange={(effort) => send({ type: 'session.effort.set', sessionId, effort })}
              permission={permissionChange.shown}
              permissionNext={permissionChange.next}
              onPermissionChange={permissionChange.change}
              running={running}
              onSubmit={(text, attachments, busy) =>
                request({ type: 'session.send', sessionId, text, attachments: attachments.length > 0 ? attachments : undefined, busy }).catch((e: Error) =>
                  setError(e.message)
                )
              }
              onStop={() => send({ type: 'session.interrupt', sessionId })}
              commands={slashCommands}
              onCommand={(name, args) => {
                setError(null)
                return request({ type: 'session.command', sessionId, name, args }).catch((e: Error) => {
                  setError(e.message)
                  throw e
                })
              }}
              onNewSession={(args) => {
                const key = `new:${session.projectId}`
                if (args) {
                  // Una bozza già scritta non si sovrascrive: il testo va in coda, su una nuova riga.
                  const current = useApp.getState().drafts[key] ?? ''
                  const next = current.trim() ? `${current.replace(/\s+$/, '')}\n${args}` : args
                  useApp.getState().setDraft(key, next)
                  send({ type: 'draft.set', key, text: next })
                }
                useApp.getState().select({ kind: 'new', projectId: session.projectId })
              }}
              queue={session.queue}
              onQueueChange={(queue) => send({ type: 'session.queue.set', sessionId, queue })}
              canSteer={session.canSteer && session.run === 'running' && !items.some((i) => i.kind === 'command' && i.status === 'running')}
              queueWorking={session.run === 'running' || session.run === 'starting' || session.run === 'waiting'}
              onDeliver={(id, how) =>
                request({ type: 'session.queue.deliver', sessionId, id, how }).catch((e: Error) => setError(e.message))
              }
              queueReason={runningAgents > 0 ? plural(runningAgents, '{n} agent working', '{n} agents working') : null}
              context={session.context}
              disabledReason={signInNeeded ? t('Sign in to {name} to start a session.', { name: CONNECTION_NAME[signInNeeded.id] }) : !agentStatus.available ? (agentStatus.error ?? t('{agent} is not available.', { agent: agentStatus.name })) : null}
              autoFocus={active && !focusTarget}
              compact={compact}
            />
            </div>
            </div>
          </div>
          <SubagentDialog sessionId={sessionId} />
        </>
      )}
    </div>
  )
}

/** Sessione terminale: la TUI originale dell'agente a tutta altezza. Ferma dopo un'uscita o un riavvio: "Riprendi". */
function TerminalSessionBody({ session, active }: { session: SessionSummary; active: boolean }) {
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
        <TerminalView key={terminal.id} id={terminal.id} composerKey={null} autoFocus={active} className="flex-1 px-3 pt-2" />
      ) : (
        <div className="grid flex-1 place-items-center text-sm text-muted-foreground">{t('Opening the terminal…')}</div>
      )}
    </div>
  )
}
