import { BrowserColumn } from '@/components/browser/browser-column'
import { DevServerNotice } from '@/components/browser/dev-server-notice'
import { BrowserToggle, PhoneIndicator, SplitMenu } from '@/components/top-bar-actions'
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
  PanelRight,
  Play,
  RotateCcw,
  SquareTerminal,
  TriangleAlert,
  X
} from 'lucide-react'
import type { AgentId, AgentStatus, Attachment, ChatItem, Effort, IssueItem, PermissionLevel, Project, ProjectSettings, RequestResponse, SessionSummary, TerminalInfo } from '@shared/protocol'
import { allowedLevels, FALLBACK_AGENT, supportsEffort } from '@/lib/agents'
import { agentsRunning, needsYou } from '@/lib/session-state'
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
import { BranchSwitcherPanel } from '@/components/branch-switcher'
import { branchNameProblem, WorktreeStart } from '@/components/worktree-start'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useProjectBranches } from '@/lib/use-project-branches'
import { GitBlock, useFirstChangeFlash, useGitStatus } from '@/components/git-status-chip'
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
import { runHandoffCommand } from '@/lib/handoff'
import { runPlanCommand } from '@/lib/plan-command'
import { runAdviceCommand } from '@/lib/advice'
import { AdviceParentNote } from '@/components/advice-bits'
import { HandoffFromNote } from '@/components/handoff-bits'
import { hasPeerNotes, PeerNotes } from '@/components/peer-notes'
import { cn } from '@/lib/utils'
import { useSettings } from '@/hooks/use-theme'
import { isBrowserColumnOpen, liveColumns, useApp } from '@/store/app-store'
import { MIN_CONTENT_WIDTH } from '@/lib/panel-size'
import { COMPACT_WIDTH, useElementWidth } from '@/lib/use-element-width'
import { plural, t } from '@shared/i18n'
import { cleanBranchPrefix, DEFAULT_BRANCH_PREFIX } from '@shared/worktree-prefs'
import { Kbd } from '@/components/ui/kbd'
import { isSendKey, sendKeyCombos, useSendKey } from '@/lib/send-key'
import { capPermission, isValidEffort, isValidModel, launchModel, resolveSessionDefaults } from '@/lib/session-defaults'
import { defaultsToken, useAgentDefaultsMap } from '@/lib/effective-defaults'
import { applyPreset, presetIssuesNote, type PresetIssue, presetSummary, setProjectDefaultPreset } from '@/lib/session-presets'
import { usePermissionChange, type PermissionChangeResult } from '@/lib/use-permission-change'
import { PlanTaskBanner } from '@/components/plan-task-banner'
import { OriginBanner } from '@/components/session-origin'

const EMPTY_ITEMS: ChatItem[] = []

// ── Project configuration ─────────────────────────────────────────────

const settingsCache = new Map<string, ProjectSettings>()

/** The project's .ladder/settings.toml: re-read when the folder changes or you return to the window. */
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

// ── Top bar ───────────────────────────────────────────────────────────

const barButton =
  'no-drag inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent'

function BarIcon({ label, shortcut, active, onClick, children }: { label: string; shortcut: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn('no-drag grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50', active && 'bg-accent text-foreground')}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label} <Kbd className="ml-1">{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

/** Buttons for the [[run]] actions: they start the command in the session's terminal, with LADDER_PORT. */
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

/** Git block (branch and changes): opens the right panel on Merge and on Changes. */
function SessionGit({ project, session, root }: { project: Project; session: SessionSummary; root: string | null }) {
  const status = useGitStatus(session.id)
  const flash = useFirstChangeFlash(status)
  const toggleInspector = useApp((s) => s.toggleInspector)
  const openTab = useApp((s) => (s.ui[project.id]?.inspector?.open ? s.ui[project.id]?.inspector?.tab : null))
  const mergeOpen = openTab === 'merge'
  const changesOpen = openTab === 'changes'
  return (
    <GitBlock
      status={status}
      fallbackBranch={session.branch ?? project.branch ?? null}
      title={root ?? project.path}
      mergeActive={mergeOpen}
      changesActive={changesOpen}
      flash={flash}
      // The branch can only be changed in the main checkout: a worktree's stays informational and opens Merge.
      switcherProjectId={!session.worktree && project.isGit ? project.id : null}
      // From the branch menu Merge just opens; on a worktree's branch the click is a toggle.
      onOpenMerge={() => (!session.worktree && project.isGit ? useApp.getState().openInspector(project.id, 'merge') : toggleInspector(project.id, 'merge'))}
      // The numbers are the folder's uncommitted changes: Changes opens on the same view, so the counts match.
      onOpenChanges={() => (changesOpen ? toggleInspector(project.id, 'changes') : useApp.getState().openInspector(project.id, 'changes', { scope: { kind: 'uncommitted' } }))}
    />
  )
}

export function TopBar({ children, project, session, root }: { children?: ReactNode; project: Project | null; session: SessionSummary | null; root: string | null }) {
  useShortcutsRevision()
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const panelOpen = useApp((s) => (project ? Boolean(s.ui[project.id]?.inspector?.open) : false))
  const filesOpen = useApp((s) => (project ? Boolean(s.ui[project.id]?.inspector?.open) && s.ui[project.id]?.inspector?.tab === 'files' : false))
  const terminalOpen = useApp((s) => (project ? Boolean(s.ui[project.id]?.terminal?.open) : false))
  const toggleInspector = useApp((s) => s.toggleInspector)
  const setPanel = useApp((s) => s.setTerminalPanel)
  const quickOpen = useApp((s) => s.quickOpen)
  const toggleQuickOpen = useApp((s) => s.toggleQuickOpen)
  return (
    // With the sidebar hidden the macOS traffic lights sit above this bar: same margin as the sidebar, which drops to normal in full screen.
    <div className={`drag flex h-11 shrink-0 items-center gap-1 pr-2 ${sidebarOpen ? 'pl-3' : 'pl-traffic'}`}>
      {!sidebarOpen && <ShowSidebarButton />}
      {project && (
        // Where you are: even with the sidebar closed you can read the project the tabs belong to.
        <div className="mr-1 flex max-w-[220px] min-w-0 shrink-0 items-center gap-1 text-sm">
          {/* A click on the name opens the file search, like ⌘P; a second click (or Esc) closes it. */}
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
      <PhoneIndicator />
      {project && (
        <>
          <RunButtons project={project} session={session} />
          {session && <SplitMenu projectId={project.id} />}
          <BrowserToggle projectId={project.id} />
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
                'no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
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
          <BarIcon label={panelOpen ? t('Hide panel') : t('Show panel')} shortcut={shortcutLabel('inspector.toggle')} active={panelOpen} onClick={() => toggleInspector(project.id)}>
            <PanelRight className="size-4" strokeWidth={1.75} />
          </BarIcon>
        </>
      )}
    </div>
  )
}

/** Central column with the terminal panel at the bottom, the browser column and the inspector on the right. */
export function Workspace({ project, session, root, composerKey, children }: { project: Project; session: SessionSummary | null; root: string; composerKey: string | null; children: ReactNode }) {
  const inspectorOpen = useApp((s) => Boolean(s.ui[project.id]?.inspector?.open))
  const terminalOpen = useApp((s) => Boolean(s.ui[project.id]?.terminal?.open))
  const terminalRight = useApp((s) => s.ui[project.id]?.terminal?.side === 'right')
  // With the browser column open the chats keep their minimum width: the browser is what shrinks.
  const browserOpen = useApp((s) => isBrowserColumnOpen(s, project.id))
  const terminal = terminalOpen ? <TerminalPanel projectId={project.id} sessionId={session?.id ?? null} cwd={root} composerKey={composerKey} /> : null
  return (
    <main className="flex min-w-0 flex-1 bg-background">
      {/* data-split-area: the view a tab is dragged onto to split it (right or bottom edge). */}
      <div data-split-area className="relative flex min-w-0 flex-1 flex-col" style={browserOpen ? { minWidth: MIN_CONTENT_WIDTH } : undefined}>
        {children}
        {!terminalRight && terminal}
        <SplitDropHint />
        <DevServerNotice projectId={project.id} />
      </div>
      {/* A single browser column per project: between the content and the rest of the right panel. */}
      <BrowserColumn projectId={project.id} />
      {terminalRight && terminal}
      {inspectorOpen && <Inspector projectId={project.id} root={root} isGit={project.isGit} session={session} composerKey={composerKey} />}
    </main>
  )
}

const contextButton =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent disabled:opacity-50'

/** Agent state, from the given profile if it has its own (account, models and limits are per profile), otherwise the default one. */
function useAgentStatus(agent: AgentId | undefined, profileId?: string | null): AgentStatus | null {
  const agents = useApp((s) => s.agents)
  const own = useApp((s) => (agent ? agentStatusFor(s, agent, profileId) : null))
  return own ?? agents.find((a) => a.agent === agent) ?? null
}

/** Subtitle of an agent in menus: account and version, or the reason there isn't one. */
function agentDetail(status: AgentStatus, allowed: boolean, signIn = false): string {
  if (!allowed) return t('Not allowed by the project (.ladder/settings.toml)')
  if (signIn) return t('Not signed in. Click to sign in.')
  if (!status.available) return status.error ?? t('Not available')
  return [status.kind === 'acp' ? 'ACP' : null, status.account, status.version ? `v${status.version}` : null].filter(Boolean).join(' · ') || t('Ready')
}

// ── New chat ──────────────────────────────────────────────────────────

type Launch = { mode: 'chat' } | { mode: 'terminal'; command: string }

/** Worktree branch for a session born from an issue, PR or branch. */
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

/** New chat: composer in the center with project, branch, folder and mode above, like Cursor's agents window. */
export function NewChat({ projectId }: { projectId: string | null }) {
  useShortcutsRevision()
  const projects = useApp((s) => s.projects)
  const select = useApp((s) => s.select)
  const agents = useApp((s) => s.agents)
  const project = projects.find((p) => p.id === projectId) ?? projects[0] ?? null
  const lastAgent = useApp((s) => (project ? s.ui[project.id]?.lastAgent : undefined))
  const projectDefaults = useApp((s) => (project ? s.ui[project.id]?.defaults : undefined))
  const globalDefaults = useApp((s) => s.prefs?.defaults)
  // The user's explicit choices in the composer: they win over the defaults. undefined = no choice.
  const [chosenAgent, setChosenAgent] = useState<AgentId | null>(null)
  // Model and effort chosen apply only to the agent they were chosen for: if the resolved agent changes by itself, they are ignored.
  const [modelChoice, setModelChoice] = useState<{ agent: AgentId; value: string } | null>(null)
  const [effortChoice, setEffortChoice] = useState<{ agent: AgentId; value: Effort } | null>(null)
  const [permissionChoice, setPermissionChoice] = useState<PermissionLevel | undefined>(undefined)
  // Profile chosen for this session (the default is `default:<agent>`, never null: the host reads null as "no choice"); it applies only to the agent it was chosen for. Without a choice the project decides.
  const [profileChoice, setProfileChoice] = useState<{ agent: AgentId; id: string } | null>(null)
  // Session profile: undefined = no choice (the project's default applies, if any), null = "no profile" chosen by you.
  const [presetChoice, setPresetChoice] = useState<string | null | undefined>(undefined)
  // The profile has a draft but you already had one: yours stays and the user is told.
  const [draftKept, setDraftKept] = useState(false)
  // Last text put in the draft by a profile: if the draft is still the same it belongs to the profile and can be replaced, otherwise it is yours.
  const presetPrompt = useRef<string | null>(null)
  // You changed the worktree by hand after choosing the profile: the fallback note no longer concerns it.
  const [worktreeEdited, setWorktreeEdited] = useState(false)
  const [launch, setLaunch] = useState<Launch>({ mode: 'chat' })
  // Last choice made in this project (where the session works and, with a worktree, which branch it starts from): it restarts from there.
  const remembered = useApp((s) => (project ? s.ui[project.id]?.newChat : undefined))
  const rememberedWorktree = Boolean(remembered?.worktree && project?.isGit)
  const [worktree, setWorktree] = useState(rememberedWorktree)
  // Chosen starting branch (null = the main checkout's current one) and new branch name (empty = generated by the host).
  const [baseChoice, setBaseChoice] = useState<string | null>(remembered?.baseBranch ?? null)
  const [branchName, setBranchName] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const branchesState = useProjectBranches(project?.isGit ? project.id : null, true, project?.branch)
  const branchList = branchesState.data
  // With the setup script: null = as the project says (setupWait), otherwise this session's choice (true = starts right away).
  const [startNow, setStartNow] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settings = useProjectSettings(project)
  const branchPrefix = useApp((s) => s.prefs?.branchPrefix)
  const prefix = branchPrefix === undefined ? DEFAULT_BRANCH_PREFIX : cleanBranchPrefix(branchPrefix)
  const allowedAgents = settings?.agents.allowed ?? []
  const isAllowed = (agent: AgentId) => allowedAgents.length === 0 || allowedAgents.includes(agent)
  const maxPermission = settings?.agents.permissionsMax ?? null
  // The agent's defaults for this project (host): used to validate the effort against the model that actually starts.
  const allProfiles = useApp((s) => s.profiles)
  const profileAgents = useApp((s) => s.profileAgents)
  const defaultsTargets = useMemo(
    () => agents.filter((a) => a.available).map((a) => ({ agent: a.agent, profileId: isProfileAgent(a.agent) ? hostProfileId(projectProfileId(project, a.agent, profilesOf(allProfiles, a.agent))) : undefined, token: defaultsToken(a) })),
    [agents, allProfiles, project]
  )
  const agentDefaultsMap = useAgentDefaultsMap(project?.id, defaultsTargets)
  const agentModels = useMemo(() => Object.fromEntries(Object.entries(agentDefaultsMap).map(([agent, d]) => [agent, d?.known ? d.model : null])), [agentDefaultsMap])
  // Saved session profiles and the one in use: the explicit choice, otherwise the project's default; an id that no longer exists is ignored.
  const presets = useApp((s) => s.prefs?.presets)
  const projectDefaultPreset = useApp((s) => (project ? s.ui[project.id]?.defaultPreset : undefined))
  const activePreset = presets?.find((p) => p.id === (presetChoice === undefined ? projectDefaultPreset : presetChoice)) ?? null
  // The profile is re-read on every render against the current state (account, models, project limits): whatever is not valid falls back to the defaults.
  const applied = useMemo(
    () => (activePreset ? applyPreset(activePreset, { agents, profileAgents, profiles: allProfiles, project, allowed: allowedAgents as AgentId[], maxPermission, agentModels }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activePreset, agents, profileAgents, allProfiles, project, settings, agentModels]
  )
  // Defaults: project, then TOML (agent only), then global, then last agent (lib/session-defaults.ts).
  const resolved = useMemo(
    () => resolveSessionDefaults({ agents, project: projectDefaults, global: globalDefaults, tomlAgent: settings?.agents.default as AgentId | null | undefined, lastAgent, allowed: allowedAgents as AgentId[], maxPermission, forceAgent: chosenAgent ?? applied?.agent ?? null, agentModels }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, projectDefaults, globalDefaults, settings, lastAgent, chosenAgent, applied, agentModels]
  )
  const chatAgent: AgentId = launch.mode === 'chat' ? (resolved.agent ?? 'claude-code') : 'claude-code'
  const connections = useApp((s) => s.connections)
  const profileConnections = useApp((s) => s.profileConnections)
  const agentProfiles = useProfiles(chatAgent)
  // With a single profile per agent there is nothing to choose or show.
  const multiProfile = launch.mode === 'chat' && agentProfiles.length > 1
  // The choice applies only if the profile still exists (it may have been removed): one check for the interface and for `session.create`.
  // The session profile proposes the account; a choice of yours in the menu wins.
  const profileOwn = profileChoice ?? (applied?.agent && applied.profileId ? { agent: applied.agent, id: applied.profileId } : null)
  const chosenProfile = isProfileAgent(chatAgent) && profileOwn?.agent === chatAgent && agentProfiles.some((p) => p.id === profileOwn.id) ? profileOwn.id : null
  const profileId = isProfileAgent(chatAgent) ? (chosenProfile ?? projectProfileId(project, chatAgent, agentProfiles)) : null
  const profile = agentProfiles.find((p) => p.id === profileId) ?? null
  const agentStatus = (isProfileAgent(chatAgent) && !isDefaultProfileId(profileId) ? profileAgents[profileId!] : null) ?? agents.find((a) => a.agent === chatAgent) ?? FALLBACK_AGENT
  const signInNeeded = useSignInNeeded(chatAgent, profileId)
  // Explicit choices = yours, then those of the session profile: both apply only to their agent.
  // The profile's model applies only to the account that actually starts: if you pick another account from the menu it is checked again against its list.
  const presetModel = applied?.agent && applied.model && (agentStatus.models.length === 0 || isValidModel(agentStatus, applied.model)) ? { agent: applied.agent, value: applied.model } : null
  const modelOwn = modelChoice ?? presetModel
  const effortOwn = effortChoice ?? (applied?.agent && applied.effort ? { agent: applied.agent, value: applied.effort } : null)
  const model = modelOwn?.agent === chatAgent ? modelOwn.value : resolved.model
  const rawEffort = effortOwn?.agent === chatAgent ? effortOwn.value : resolved.effort
  // The final effort must be valid for the final model, otherwise none.
  const effort = isValidEffort(agentStatus, model ?? launchModel(agentStatus, agentModels), rawEffort) ? rawEffort : null
  const permission = capPermission(permissionChoice ?? applied?.permission ?? resolved.permission, maxPermission)
  // The composer receives only the explicit choices: it resolves the defaults itself (and marks them with the Default badge).
  const explicitModel = modelOwn?.agent === chatAgent ? modelOwn.value : null
  const explicitEffort = effortOwn?.agent === chatAgent && isValidEffort(agentStatus, model ?? launchModel(agentStatus, agentModels), effortOwn.value) ? effortOwn.value : null
  // When the project changes the explicit choices lapse: the new chat restarts from that project's defaults.
  // Only when the project really changes: on mount (and in StrictMode's second run) the choices are already empty,
  // and clearing them again would erase the profile just chosen from ⌘K.
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
    // The new project restarts from its last choice (a session profile, if any, rewrites it right after).
    const next = project ? useApp.getState().ui[project.id]?.newChat : undefined
    setWorktree(Boolean(next?.worktree && project?.isGit))
    setBaseChoice(next?.baseBranch ?? null)
    setBranchName('')
  }, [project?.id])
  // Picks a profile: your choices in the composer lapse and the profile supplies the values; the initial draft, if any, does not start by itself.
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
    // The draft belongs to the previous profile (or is empty): it is replaced or cleared. If you edited it, it stays yours.
    if (!current.trim() || (presetPrompt.current !== null && current === presetPrompt.current)) {
      if (current !== next) {
        // The replacement goes through replaceComposerDraft: the composer does not follow every store change (a snapshot after the host restarts would overwrite the text), nor does it remount, so attachments and cursor stay.
        useApp.getState().setDraft(key, next)
        send({ type: 'draft.set', key, text: next })
        useApp.getState().replaceComposerDraft(key, next)
      }
      presetPrompt.current = next || null
    } else if (next) {
      setDraftKept(true)
    }
  }
  // "New chat with <profile>" from ⌘K: read once and cleared. It comes after the project restore, so it does not override it.
  const newPreset = useApp((s) => s.newPreset)
  const consumedPreset = useRef<typeof newPreset>(null)
  useEffect(() => {
    if (!newPreset || !project || newPreset.projectId !== project.id) return
    // Consumed only once: the same object is not applied twice (StrictMode re-runs effects with the same closure).
    if (consumedPreset.current === newPreset) return
    consumedPreset.current = newPreset
    useApp.getState().setNewPreset(null)
    choosePreset(newPreset.presetId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newPreset, project?.id])
  // The profile also decides the worktree (only in a git project); without a profile it stays as you set it.
  const hadPreset = useRef(false)
  const presetWorktree = useRef<boolean | null>(null)
  useEffect(() => {
    if (activePreset) {
      presetWorktree.current = Boolean(activePreset.worktree && project?.isGit)
      setWorktree(presetWorktree.current)
    } else if (hadPreset.current) {
      // Without a profile it goes back to the default, but only if the value is still the one set by the profile (not yours, not an issue's).
      if (!worktreeEdited && !source && worktree === presetWorktree.current) setWorktree(rememberedWorktree)
      setWorktreeEdited(false)
    }
    hadPreset.current = Boolean(activePreset)
    // Only when the profile in use changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePreset?.id, project?.id])
  // Changing agent reloads that agent's default model and effort; the chosen permission stays.
  const chooseAgent = (agent: AgentId) => {
    setChosenAgent(agent)
    setLaunch({ mode: 'chat' })
    setModelChoice(null)
    setEffortChoice(null)
  }
  // Issue, PR or branch chosen with ⌘⇧N: the prompt becomes the draft and the worktree is prepared on the right branch.
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
    // Only when the choice changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, project?.id])

  // Branch the worktree starts from: the choice if it still exists among the local branches, otherwise the main checkout's current one.
  const currentBranch = branchList?.current ?? project?.branch ?? null
  // The remembered choice starts anyway, even if the list has not arrived yet (or failed): the host validates it. With the list, one that no longer exists is discarded.
  const explicitBase = baseChoice && (!branchList || branchList.branches.some((b) => b.name === baseChoice)) ? baseChoice : null
  const startBranch = explicitBase ?? currentBranch
  // Saves the choice in the project's state (like `lastAgent`): `ui.set` keeps it as it is.
  const remember = (patch: { worktree?: boolean; baseBranch?: string | null }) => {
    if (!project) return
    const current = useApp.getState().ui[project.id] ?? { tabs: [], activeTab: null, scroll: {} }
    const state = { ...current, newChat: { worktree: false, ...current.newChat, ...patch } }
    useApp.getState().setUi(project.id, state)
    send({ type: 'ui.set', projectId: project.id, state })
  }
  const nameProblem = branchNameProblem(branchName, branchList?.branches ?? [])

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
    if (worktree && !source && nameProblem) {
      setError(nameProblem)
      return
    }
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
        // Only if you chose it: otherwise the host uses the project's profile.
        ...(launch.mode === 'chat' && chosenProfile ? { profileId: chosenProfile } : {}),
        attachments: attachments.length > 0 ? attachments : undefined,
        mode: launch.mode,
        command: launch.mode === 'terminal' ? launch.command : undefined,
        worktree,
        ...(worktree && settings?.worktree.setup && startNow !== null ? { setupWait: !startNow } : {}),
        branch: source && worktree ? branchFor(source, prefix) : null,
        ...(worktree && !source && explicitBase ? { baseBranch: explicitBase } : {}),
        ...(worktree && !source && branchName.trim() ? { newBranch: branchName.trim() } : {}),
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

  // What you already fixed by hand is no longer flagged.
  // Choosing another agent also makes the account, model and effort problems moot: they were the old agent's.
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
              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger className={cn(contextButton, 'max-w-[240px]')} aria-label={t('Branch {branch}', { branch: project.branch })}>
                  <GitBranch aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">{project.branch}</span>
                  <ChevronDown aria-hidden className="size-3 shrink-0 text-faint" />
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80 gap-0 p-0">
                  <BranchSwitcherPanel projectId={project.id} onDone={() => setMenuOpen(false)} />
                </PopoverContent>
              </Popover>
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
                  <DropdownMenuItem onClick={() => { setWorktree(false); setWorktreeEdited(true); remember({ worktree: false }) }} className="items-start">
                    <Check className={cn('mt-0.5 size-3.5', worktree && 'opacity-0')} />
                    <span className="flex flex-col">
                      {t('Main checkout')}
                      <span className="text-xs text-muted-foreground">{t('Works in your project folder on {branch}. The dev server you already have open sees the changes.', { branch: currentBranch ?? 'HEAD' })}</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setWorktree(true); setWorktreeEdited(true); remember({ worktree: true }) }} className="items-start">
                    <Check className={cn('mt-0.5 size-3.5', !worktree && 'opacity-0')} />
                    <span className="flex min-w-0 flex-col">
                      {t('New worktree')}
                      <span className="text-xs text-muted-foreground" title={settings?.worktree.setup || undefined}>
                        {source
                          ? branchFor(source, prefix).existing
                            ? t('Checks out {branch} in a separate folder. Local only until you push.', { branch: branchFor(source, prefix).name })
                            : t('New branch {branch} in a separate folder. Local only until you push.', { branch: branchFor(source, prefix).name })
                          : t('New branch {branch} from {base}, in a separate folder. Local only until you push.', { branch: branchName.trim() || `${prefix}…`, base: startBranch ?? 'HEAD' })}
                        {settings?.worktree.setup ? ` ${t('Then runs the project’s setup script.')}` : ''}
                        {settings?.worktree.copy.length ? ` ${t('Copies {files}.', { files: settings.worktree.copy.join(', ') })}` : ''}
                      </span>
                      {branchList?.worktreesFolder && (
                        <span title={t('Worktrees of this project live in {path}', { path: branchList.worktreesFolder })} className="truncate font-mono text-[0.6875rem] text-faint">
                          {branchList.worktreesFolder}
                        </span>
                      )}
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
            {worktree && !source && project.isGit && branchList && (
              <WorktreeStart
                branches={branchList.branches}
                base={startBranch}
                onBase={(b) => {
                  setBaseChoice(b.name === branchList.current ? null : b.name)
                  remember({ baseBranch: b.name === branchList.current ? null : b.name })
                }}
                name={branchName}
                onName={setBranchName}
                prefix={prefix}
                className={contextButton}
              />
            )}
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
                    // An agent without a login can be chosen: the click leads to its row in Settings → Subscriptions.
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
                            {/* Second line: the note, if any, otherwise the summary. */}
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
              effort={explicitEffort}
              onEffortChange={(value) => setEffortChoice({ agent: chatAgent, value })}
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
          {/* Discreet note: whatever of the profile no longer applies here and fell back to the defaults. No error. */}
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

/** Where the session comes from: issue, PR or branch, with the link. */
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

// ── Session ───────────────────────────────────────────────────────────

/**
 * Open session: bar with the tabs and one column, or, if the project has split sessions, all the columns.
 * Inspector and terminal are single and follow the active session (the selected one).
 */
export function SessionView({ sessionId }: { sessionId: string }) {
  const session = useApp((s) => s.sessions[sessionId])
  const project = useApp((s) => s.projects.find((p) => p.id === s.sessions[sessionId]?.projectId) ?? null)
  // A string: the store returns the same value until the columns change, even if the sessions update.
  const columnsKey = useApp((s) => (session ? liveColumns(s, session.projectId).join('\n') : ''))
  const columns = useMemo(() => (columnsKey ? columnsKey.split('\n') : []), [columnsKey])
  if (!session || !project) return <main className="flex-1 bg-background" />
  const root = session.cwd ?? project.path
  return (
    <Workspace project={project} session={session} root={root} composerKey={session.mode === 'terminal' ? null : sessionId}>
      <TopBar project={project} session={session} root={root}>
        <TabBar projectId={project.id} activeSessionId={sessionId} />
      </TopBar>
      {/* Always the same tree, even with a single column: splitting or closing a column does not remount the composer, pasted images and open cards. */}
      <SplitColumns
        projectId={project.id}
        columns={columns.includes(sessionId) ? columns : [sessionId]}
        activeId={sessionId}
        renderColumn={(id, column) => <SessionBody key={id} sessionId={id} column={column} />}
      />
    </Workspace>
  )
}

/** Conversation and composer of a session, or the CLI in its terminal. In a column it also has the header with the status. */
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
  const allAgents = useApp((s) => s.agents)
  const [error, setError] = useState<string | null>(null)
  const uiTimer = useRef<number | null>(null)
  const isTerminal = session?.mode === 'terminal'
  // The new level shows only when the host confirms; a rejection gives an error above the composer.
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
  // Only one column is active: shortcuts, initial focus and the active tab follow it. Outside columns the session is always active.
  const active = column ? column.active : true
  // Below about 420 px the column switches to the compact view (this also holds for a single column, in a narrow window).
  const [measure, width] = useElementWidth()
  const compact = width > 0 && width < COMPACT_WIDTH

  // In terminal sessions focus goes to the terminal itself: the request is in the TUI.
  useEffect(() => {
    if (isTerminal && focusTarget) consumeFocus(focusTarget.nonce)
  }, [isTerminal, focusTarget, consumeFocus])

  useEffect(() => {
    if (!loaded) send({ type: 'session.open', sessionId })
  }, [sessionId, loaded])

  // The agent's / commands: requested on open and on every reconnection; then they arrive with the event.
  const slashCommands = useApp((s) => s.commands[sessionId])
  const loadCommands = useApp((s) => s.loadCommands)
  const connected = useApp((s) => s.connected)
  useEffect(() => {
    if (!isTerminal && connected) loadCommands(sessionId)
  }, [sessionId, isTerminal, connected, loadCommands])

  // Marks as read when the session is visible, the window is active and the turn is finished.
  useEffect(() => {
    // "Mark as unread" on the open session must not be undone right away.
    // The same goes for the sub-agents notice: on the open session it is cleared with session.read.
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
  // Click: viewer in the inspector at the right line. ⌥click: external editor.
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

  const initialAnchor = useMemo(() => ui?.scroll[sessionId] ?? null, [sessionId]) // only on open
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
  const headerNotes = [session.worktree ? 'worktree' : null, !needsYou(session) && isTerminal ? session.activity : null, session.estimated ? t('estimated status') : null].filter(Boolean).join(' · ')

  return (
    <div ref={measure} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {column && !column.single && <ColumnHeader session={session} active={column.active} hidden={column.hidden} onClose={column.onClose} />}
      {session.origin && !isTerminal && <OriginBanner session={session} compact={compact} />}
      {session.plan?.role === 'task' && !isTerminal && <PlanTaskBanner session={session} compact={compact} />}
      {/* Only notes that live nowhere else: a chat's agent and model are already in the composer, the title in the tab. */}
      {(isTerminal || headerNotes || session.handoffFrom || session.parent || hasPeerNotes(session) || (needsYou(session) && !(column && !column.single))) && (
        <div
          className={cn('w-full pb-1 text-xs text-muted-foreground', isTerminal ? 'flex min-w-0 items-center gap-1.5 px-5' : 'chat-col chat-gutter')}
          data-compact={!isTerminal && compact ? '' : undefined}
        >
          {/* In the chat the notes sit on the same column as the composer (same chat-bleed). */}
          <div className={isTerminal ? 'w-full min-w-0' : 'chat-measure chat-bleed'}>
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
          {session.handoffFrom && (
            <>
              {(isTerminal || headerNotes) && <span aria-hidden className="text-faint">·</span>}
              <HandoffFromNote session={session} />
            </>
          )}
          {session.parent && (
            <>
              {(isTerminal || headerNotes || session.handoffFrom) && <span aria-hidden className="text-faint">·</span>}
              <AdviceParentNote session={session} />
            </>
          )}
          {!isTerminal && <PeerNotes session={session} lead={Boolean(headerNotes || session.handoffFrom || session.parent)} />}
          {needsYou(session) && !(column && !column.single) && <span className="ml-auto shrink-0 font-semibold text-attention">{session.waitingLabel}</span>}
            </div>
            </div>
          </div>
        </div>
      )}
      {isTerminal ? (
        <TerminalSessionBody session={session} active={active} />
      ) : (
        <>
          {/* ⇧Tab changes permissions with focus on the open request card. */}
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
          {/* The composer follows the text column (Settings, Appearance: chat width), slightly wider (chat-bleed). */}
          <div className="chat-col chat-gutter pb-4" data-compact={compact ? '' : undefined}>
            <div className="chat-measure chat-bleed">
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
                  // An already written draft is not overwritten: the text goes at the end, on a new line.
                  const current = useApp.getState().drafts[key] ?? ''
                  const next = current.trim() ? `${current.replace(/\s+$/, '')}\n${args}` : args
                  useApp.getState().setDraft(key, next)
                  send({ type: 'draft.set', key, text: next })
                }
                useApp.getState().select({ kind: 'new', projectId: session.projectId })
              }}
              permissionLocked={Boolean(session.parent) && (session.parent?.role !== 'delegate' || session.permission === 'plan')}
              noPlan={session.parent?.role === 'delegate' && session.permission !== 'plan'}
              onHandoff={session.parent ? undefined : (args) => runHandoffCommand(session, args, allAgents, sessionSettings?.agents?.allowed ?? [], setError)}
              onAdvice={session.parent ? undefined : (mode, args) => runAdviceCommand(session, mode, args, allAgents, sessionSettings?.agents?.allowed ?? [], setError)}
              onPlan={session.parent || session.mode !== 'chat' || session.archived || session.plan?.role === 'task' ? undefined : (goal) => runPlanCommand(session, goal, setError)}
              queue={session.queue}
              onQueueChange={(queue) => send({ type: 'session.queue.set', sessionId, queue })}
              canSteer={session.canSteer && session.run === 'running' && !items.some((i) => (i.kind === 'command' && i.status === 'running') || (i.kind === 'handoff' && i.direction === 'out' && i.state === 'summarizing'))}
              queueWorking={session.run === 'running' || session.run === 'starting' || session.run === 'waiting'}
              onDeliver={(id, how) =>
                request({ type: 'session.queue.deliver', sessionId, id, how }).catch((e: Error) => setError(e.message))
              }
              queueReason={runningAgents > 0 ? plural(runningAgents, '{n} agent working', '{n} agents working') : null}
              context={session.context}
              disabledReason={signInNeeded ? t('Sign in to {name} to start a session.', { name: CONNECTION_NAME[signInNeeded.id] }) : !agentStatus.available ? (agentStatus.error ?? t('{agent} is not available.', { agent: agentStatus.name })) : null}
              autoFocus={active && !focusTarget}
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

/** Terminal session: the agent's original TUI at full height. Stopped after an exit or a restart: "Resume conversation" or "Restart". */
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
