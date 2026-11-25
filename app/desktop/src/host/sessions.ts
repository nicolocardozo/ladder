// Core of the host: projects, sessions, chat items and the link to adapters, terminals and git.
import { randomUUID } from 'node:crypto'
import { constants as fsConstants, existsSync, statSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type {
  AcpAgentSpec,
  AgentLogin,
  AgentSignature,
  AdviceItem,
  AgentId,
  AgentResult,
  AgentStatus,
  DiffScope,
  ReviewState,
  AttentionEvent,
  ChatItem,
  SubagentDetail,
  HostPrefs,
  HostToMain,
  IssueList,
  GitArchiveResult,
  BranchMap,
  BranchSwitchResult,
  MergeInfo,
  PrStatus,
  RemotePage,
  RemoteProjectDefaults,
  RemoteSessionCreate,
  RequestItemData,
  SessionSource,
  DraftKey,
  Effort,
  HostCommand,
  HostEvent,
  PermissionLevel,
  Profile,
  ProfileAgent,
  Project,
  ProjectSettings,
  GeneratedCommit,
  GeneratedPr,
  ProjectBranches,
  ProjectUiState,
  QueuedMessage,
  Attachment,
  RequestResponse,
  RunState,
  SessionSummary,
  SessionWaitResult,
  TranscriptMark,
  SubagentInfo,
  UsageWindow,
  SlashCommand,
  TerminalInfo,
  WorktreeInfo,
  BrowserAgentResult
} from '@shared/protocol'
import { tx, type Db, type ProjectRow, type SessionRow } from './db'
import { plural, setLocale, t, translations } from '@shared/i18n'
import { pageItems as pageItemsOf } from './remote/paging'
import { isValidEffort, isValidModel, resolveRemoteDefaults } from './remote/defaults'
import { ClaudeSession, type AdapterEvents, type ToolUpdate, type TurnResult, type UserRequest } from './claude/adapter'
import { acpAuthenticate, AcpSession } from './acp/adapter'
import { BrowserAgent } from './browser-agent'
import { LadderMcpServer, parseReport, toolsForRole, type DelegateArgs, type HandoffArgs, type LadderCall, type LadderToolName, type ReportArgs, type ToolOutcome } from './ladder-mcp'
import { isReadOnlyBash } from './claude/read-only'
import { Plans } from './plans'
import { AgentSessions, type StartSpec } from './agent-sessions'
import { decideWait } from './session-wait'
import { markOf } from '../cli/follow-mark.ts'
import type { CliInstall } from './cli-install'
import type { TaskSessionSpec } from './plan-runner'
import type { PlanState, PlanTask } from '@shared/plan'
import { agentCatalog, resolveAgentSpec, UNKNOWN_LOGIN } from './acp/catalog'
import { OtherAgents } from './acp/others'
import { agentDir, AgentInstaller, recoverInstalls } from './acp/install'
import { hasUnsafeArgs, iconData, registryEntry, registrySpec } from './acp/registry'
import { rm } from 'node:fs/promises'
import { delegatesHint, whichInShell, type AgentSession, type SessionOptions } from './agents/common'
import { CodexSession, codexFixedCommands } from './codex/adapter'
import { codexVersion, findCodexCli, probeCodex } from './codex/environment'
import { patchText, reviewPrompt, ReviewRun } from './review'
import { claudeListId, claudeModelNames, claudeProjectDefaults, claudeVersion, findClaudeCli, probeClaude, readClaudeDefaults } from './claude/environment'
import { claudeText, claudeTitle } from './claude/title'
import { COMMIT_BODY_MAX, PR_BODY_MAX, isTextBlocked, stripControl } from './text-safety'
import { codexDefaults } from './codex/environment'
import { codexText, codexTitle, smallCodexModel } from './codex/title'
import { clipTitle, inTitleQueue, issueRef, teamPrefixes, titlePrompt, withIssue } from './titles'
import { insideRoot, listTree, mediaInfo, readText, RootWatcher, writeText } from './files'
import { BranchMapService, type BranchMapRow, type BranchMapSource } from './branch-map'
import { createBranch, listLocalBranches, switchBranch } from './branches'
import { FileRoots } from './file-roots'
import { aheadBehind, changedFiles, commitChanges, createCheckpoint, dirtyCount, ensureExcluded, fetchRef, git, gitRead, gitStatus, listBranches, listFiles, mergeConflicts, repoInfo, resolveCommit } from './git'
import { GitStatusTracker } from './git-status'
import { pushBranch, pushPreview, validBranchName } from './git-push'
import { withRepoLock } from './repo-lock'
import { mergePullRequest } from './pr-merge'
import { mergeBlocks, nextAction } from './merge-flow'
import { Connections } from './connections'
import { customProfileId, isDefaultProfileId, isProfileAgent, Profiles } from './profiles'
import { defaultBranch, ghState, listGithubIssues, listGithubPrs, prForBranch, type PrDetails } from './github'
import { PrFiles } from './pr-files'
import { renderAdviceForward, renderAdvisorPrompt, renderDelegatePrompt, renderDelegateResume, renderDelegateResumed, renderHandoffPrompt, renderHandoffReceive, renderImplementPrompt, renderPrPrompt, renderPrompt, renderReviewCrossPrompt } from './prompts'
import { searchItems } from './search'
import { SubagentBoard } from './subagents'
import { agentKey, clampPermission, LEVELS, loadProjectSettings, PERSONAL_PATTERNS, saveAgentsSettings, saveWorktreeSettings } from './project-settings'
import { TerminalManager, type AgentKind, type AgentSignal, type SpawnOptions } from './terminals'
import { diffFile, diffFiles, historyList, recordCheckpoint, restore } from './workspace'
import { ProjectGroups } from './project-groups'
import { Shortcuts } from './keybindings'
import { cleanBranchPrefix, DEFAULT_BRANCH_PREFIX } from '@shared/worktree-prefs'
import { backupDatabase, dataInfo } from './data'
import { createWorktree, freePort, portIsFree, Ports, removeWorktree, runCleanupScript, worktreeIncludeFiles, worktreesRoot, type CleanupResult, type WorktreeBranch } from './worktrees'
import { BRANCH_SYSTEM, BRANCH_TIMEOUT_MS, COMMIT_LABEL, COMMIT_SYSTEM, COMMIT_TIMEOUT_MS, PR_LABEL, PR_SYSTEM, branchPrompt, branchSubjects, cleanBranch, commitPrompt, conversationExcerpt, diffExcerpt, prPrompt, projectRules, recentSubjects, splitText, textErrors, type TextModel } from './writing'


type Broadcast = (event: HostEvent) => void
/** Event for a single connection (port). */
type SendTo = (origin: object, event: HostEvent) => void
type Notify = (message: HostToMain) => void

/** How often the PR state of branches with open sessions is re-read. */
const PR_POLL_MS = Number(process.env.LADDER_PR_POLL_MS) || 90_000
/** How often to look for sessions to archive (AppPrefs.autoArchiveDays). */
const AUTO_ARCHIVE_EVERY_MS = 60 * 60_000
type ItemInput = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'seq'> : never) : never

interface PendingRequest {
  itemId: string
  resolve: (response: RequestResponse) => void
}

/** Agents that resume the same conversation after the process closes (Claude with resume, Codex with thread/resume). */
const RESTARTABLE_AGENTS = new Set(['claude-code', 'codex'])

/** Handoff in progress in the origin session, from the summary turn to the delivery. Saved in `sessions.handoff`. */
interface HandoffRun {
  /** HandoffItem 'out' row of the origin session. */
  itemId: string
  turnId: string
  agent: AgentId
  model: string | null
  effort: Effort | null
  note: string | null
  /** 'implement' = "Implement with…" to another agent, without a summary turn (not saved in `sessions.handoff`). */
  reason?: 'implement' | 'agent' | 'limit'
  /** 'implement' only: already composed prompt to deliver and permission level of the destination session. */
  prompt?: string
  permission?: PermissionLevel
  /** 'agent' only: summary written by the agent with the handoff tool (no summary turn). */
  summary?: string
  /** 'limit' only: LimitItem row that asked for the handoff (back to 'proposed' if the handoff fails or stops). */
  limitItemId?: string
  /** 'limit' only: the request left half done, delivered separately in the prompt (not inside the summary). */
  request?: string
}

type LimitRow = Extract<ChatItem, { kind: 'limit' }>
type ResumeRow = Extract<ChatItem, { kind: 'resume' }>

/** After a plan-limit handoff, the previous agent's window is watched until it resets. */
interface LimitWatch {
  limitItemId: string
  fromId: string
  toId: string
  agent: AgentId
  window: string
  resetsAt: number | null
  at: number
  /** Last limits re-read we asked for (only if the reset is unknown). */
  checked: number
}

/** Only the phrasings Claude and Codex use to announce the plan limit; a transient 429 does not count. */
const LIMIT_ERROR = /usage[ _-]?limit|hit your (?:\w+ )?limit|(?:5[- ]hour|weekly|session) limit reached|limit will reset|insufficient[_ ]quota/i
/** Pause before an automatic plan-limit handoff: time to stop it (session.handoff.stop) from the chat row. */
const LIMIT_SWITCH_GRACE_MS = 4_000
const LIMIT_WATCH_EVERY_MS = 30_000

/** Readable name of a usage window: "5-hour limit", "Weekly limit", with the model if reserved to one. */
function windowName(w: UsageWindow): string {
  const base = w.label ?? (w.minutes >= 10_080 ? t('Weekly limit') : w.minutes === 300 ? t('5-hour limit') : w.minutes >= 60 ? t('{hours}-hour limit', { hours: Math.round(w.minutes / 60) }) : t('Usage limit'))
  return w.model ? `${base} · ${w.model}` : base
}

/** Window at its limit and still valid (extra usage does not block work; a reset already past is stale data). */
const windowLimited = (w: UsageWindow): boolean => w.state === 'limited' && w.key !== 'extra_usage' && !(w.resetsAt !== null && w.resetsAt * 1000 <= Date.now())

/** Verdict from the first line of the advice ("VERDICT: ok|minor|serious"); null if missing. */
function parseVerdict(text: string): 'ok' | 'minor' | 'serious' | null {
  const first = text.split('\n').find((line) => line.trim()) ?? ''
  const match = /^\W*VERDICT\W*(ok|minor|serious)\b/i.exec(first)
  return match ? (match[1].toLowerCase() as 'ok' | 'minor' | 'serious') : null
}

/** A delegation in progress (delegate tool): the parent's MCP call waits for `done`. */
interface Delegation {
  motherId: string
  /** Parent's 'tool' row (or, if not found, the MCP request id). */
  itemId: string
  agent: AgentId
  task: string
  ended: boolean
  /** Outcome given by the child with report_result. */
  report: AgentResult | null
  resolve: (outcome: ToolOutcome) => void
  done: Promise<ToolOutcome>
  /** Delegation resumed by the user (ResumeItem card): at the end of the turn the result goes to the parent as a message, no MCP call waits. */
  resume?: { itemId: string }
  /** Branch of the child's worktree (delegate with worktree: true), stated in the result. */
  branch?: string | null
}

const MAX_DELEGATION_DEPTH = 2
const MAX_DELEGATIONS_PER_TURN = 4

interface Runtime {
  adapter: AgentSession
  turnId: string | null
  turnStart: string | null
  turnCounts: { commands: number; edits: number; reads: number; searches: number }
  activity: string | null
  pending: Map<string, PendingRequest>
  /** 'command' row of a turn started by a / command: closes at the end of the turn. */
  command: { id: string; at: number; name: string; args: string } | null
  /** Handoff ("Switch to…") whose summary the current turn is writing; it closes at the end of the turn. */
  handoff?: HandoffRun | null
  /** The user asked to interrupt the current turn. */
  interrupting: boolean
  /** The agent opened the current turn on its own (reply to a background subagent, inserted message). */
  implicit?: boolean
  /** Subagents started and open requests in the current turn: needed by turn-end.stalled. */
  turnAgents?: number
  turnRequests?: number
  /** Turn endings in progress or queued: onTurnEnd runs one at a time per session. */
  closing: number
  /** The agent has exited: no new turns on this runtime, the queue restarts with a new one. */
  exited?: boolean
  /** Codex: switched to Full access mid-turn, every new request in this turn approves itself. */
  approveAll?: boolean
  /** Name of the / command run by the current turn or the last turn (null if it was a message). */
  lastCommand?: string | null
  startedAt: number
  ending: Promise<void>
}

/** State of a terminal session that is not in the database: wait label, activity and current turn. */
interface TerminalStatus {
  label: string | null
  activity: string | null
  turn: { id: string; start: Promise<string | null>; at: number } | null
  waitingSince: number | null
}

const FLUSH_MS = 33
/** After the last background task finishes: if the coordinator does not restart within this time, the chat offers "Continue". */
const AGENTS_WAIT_MS = 8_000
/** After the turn closes, a "running" subagent with no updates for a long time (and unknown to the adapter) is marked stopped. */
const STALE_AGENT_MS = 10 * 60_000

/** Error from a text generation: a tool attempt arrives to the user as is, any other error is "did not answer". */
const keepBlocked = (error: unknown): null => {
  if (isTextBlocked(error)) throw error
  return null
}

export class Host {
  private projects = new Map<string, Project>()
  private projectGroups: ProjectGroups
  private shortcuts: Shortcuts
  private rows = new Map<string, SessionRow>()
  private runtimes = new Map<string, Runtime>()
  /** Sessions with a "Switch to…" just requested, before the summary turn is open. */
  private handoffStarting = new Set<string>()
  /** Handoffs (id of the 'out' row) the user stopped while the delivery was already in progress. */
  private readonly handoffStops = new Set<string>()
  /** Session -> 'reset' LimitItem that asked for the return (becomes 'returned' once delivered). */
  private readonly returnLinks = new Map<string, string>()
  /** Limit windows already reported, per session and agent (key) -> until when (ms): one row per window. */
  private readonly limitSeen = new Map<string, number>()
  private readonly limitWatches = new Map<string, LimitWatch>()
  private limitTimer: NodeJS.Timeout | null = null
  /** Dev only: LADDER_SIMULATE_LIMIT=claude-code[,codex] makes that agent's next end of turn count as a reached limit (LADDER_SIMULATE_LIMIT_SECONDS: reset after N seconds, default 90). */
  private readonly simulatedLimit = new Set((process.env.LADDER_SIMULATE_LIMIT ?? '').split(',').map((a) => a.trim()).filter(Boolean).map(agentKey))
  /** Text forwarded by the cross-review (session -> text) and turns born from it: they are not reviewed. */
  private readonly reviewForwards = new Map<string, string>()
  private readonly reviewTurns = new Set<string>()
  /** Only one automatic forward per user message: session + id of the last 'user' row. */
  private readonly reviewForwarded = new Set<string>()
  /** One pending review (the latest) per session, if another is still running. */
  private readonly reviewQueued = new Map<string, Extract<ChatItem, { kind: 'handoff' }>['files']>()
  /** Project delegates for the system prompt, read before the session runtime is created. */
  private readonly delegateHints = new Map<string, string | null>()
  /** When the last context event arrived per session: the fallback of an older turnEnd does not overwrite it. */
  private contextAt = new Map<string, number>()
  /** Level requested mid-turn that the agent applies only from the next turn (Codex). */
  /** Level changes in progress per session: they run one at a time. */
  private permissionLocks = new Map<string, Promise<unknown>>()
  /** Last list of / commands per session, sent by the agent. */
  private commandLists = new Map<string, SlashCommand[]>()
  /** Last known list per (agent, working folder): used by a session that has no process yet. */
  private lastCommands = new Map<string, SlashCommand[]>()
  /** In-memory items of active sessions, to update streaming without re-reading the database. */
  private liveItems = new Map<string, Map<string, ChatItem>>()
  private dirty = new Map<string, Map<string, ChatItem>>()
  private flushTimer: NodeJS.Timeout | null = null
  private claudeCli: string | null = null
  private codexCli: string | null = null
  private codexVer: string | null = null
  /** State of each agent: Claude Code, Codex and the added ACP entries. */
  private agents = new Map<string, AgentStatus>()
  private acpSpecs = new Map<string, AcpAgentSpec>()
  /** State of Claude Code and Codex for each non-default profile (profile id); the default lives in `agents`. */
  private profileAgents = new Map<string, AgentStatus>()
  private readonly profiles: Profiles
  private reviews = new Map<string, ReviewRun>()
  /** Subagents per session, for the agent map; updates to the renderer are batched. */
  private subagents = new SubagentBoard()
  private subagentFlush = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly terminals: TerminalManager
  /** "Other agents" in Subscriptions (access state, login and logout with their CLI). */
  private readonly otherAgents: OtherAgents
  /** Executable plans (the `ladder` MCP server, the runner, templates). */
  private readonly plans: Plans
  /** MCP tools for starting and waiting on other sessions. */
  private readonly agentSessions: AgentSessions
  /** Installation of the `ladder` command (created by the host at startup). */
  private cliInstall: CliInstall | null = null
  private readonly watcher: RootWatcher
  /** Ids of the roots served by the main process's ladder-file protocol. */
  private readonly fileRoots: FileRoots
  /** Git state for the header and the UI subscriptions. */
  private readonly gitStatus: GitStatusTracker
  /** `git.watch` subscriptions per connection (window): connection -> session -> folder. When the port closes, all are removed. */
  private readonly gitSubs = new Map<object, Map<string, string>>()
  /** Branch map and its subscriptions per connection: connection -> project -> count. */
  private readonly branchMaps: BranchMapService
  private readonly branchMapSubs = new Map<object, Map<string, number>>()
  /** `fs.watch` per connection: connection -> folder -> subscriptions (an `off` does not remove those of another window). */
  private readonly fsSubs = new Map<object, Map<string, number>>()
  private readonly ports: Ports
  /** Service start in progress, per session: archive() waits for it. */
  private readonly servicesStarting = new Map<string, Promise<void>>()
  /** Sessions being archived: services must no longer start. */
  private readonly archiving = new Set<string>()
  /** Archivals in progress, per session: a second archive() waits for the same promise and project.remove waits for all of them. */
  private readonly archiveRuns = new Map<string, Promise<void>>()
  private readonly restarting = new Set<string>()
  /** Sessions with an agent restart requested mid-turn: it happens at the first turn end with no open work. */
  private readonly restartAfterTurn = new Set<string>()
  private termStatus = new Map<string, TerminalStatus>()
  /** Sessions waiting for the worktree setup script before starting. */
  private preparing = new Set<string>()
  /** Sessions with a turn start in progress (startTurn): they count as busy. */
  private starting = new Map<string, number>()
  /** Newly created sessions whose first message has not been sent yet: session.wait does not see them as idle. */
  private firstMessage = new Map<string, number>()
  /** Projects with a branch change in progress in the main checkout: their sessions there queue messages until it ends. */
  private switchingBranch = new Set<string>()
  private stopped = false
  private prefs: HostPrefs = { generatedTitles: true, generatedText: true, autonomyHint: true, stallHint: false, worktreesDir: null, branchPrefix: DEFAULT_BRANCH_PREFIX, autoArchiveDays: null, busySend: 'steer', defaults: {} }
  /** Sessions with a title being generated: one attempt at a time. */
  private titling = new Set<string>()
  /** Browser for the agent (MCP server, state, channel to the main process). */
  private readonly browserAgent = new BrowserAgent({
    send: (message) => this.notify(message),
    broadcast: (event) => this.broadcast(event),
    setting: (projectId) => this.agentBrowserEnabled(projectId),
    alive: (sessionId) => (this.runtimes.has(sessionId) ? (this.rows.get(sessionId)?.project_id ?? null) : null),
    level: (sessionId) => (this.rows.get(sessionId)?.permission ?? 'ask') as PermissionLevel,
    request: (sessionId, request, signal) => this.openRequest(sessionId, request, signal)
  })
  /** Ladder MCP server (handoff, delegation, plans, sessions started by agents, report_result), for every chat session. */
  private readonly ladderMcp = new LadderMcpServer({
    tools: (sessionId) => (this.runtimes.has(sessionId) && !this.isGone(sessionId) ? this.ladderToolsFor(this.rows.get(sessionId)) : null),
    listAgents: (sessionId) => this.ladderListAgents(sessionId),
    handoff: (sessionId, args, call, signal) => this.ladderHandoff(sessionId, args, call, signal),
    delegate: (sessionId, args, call, signal) => this.ladderDelegate(sessionId, args, call, signal),
    report: (sessionId, args) => this.ladderReportAny(sessionId, args),
    plan: (sessionId, tool, args) => this.plans.call(sessionId, tool, args),
    sessions: (sessionId, tool, args, signal) => this.agentSessions.call(sessionId, tool, args, signal)
  })
  /** Delegations in progress per child session. */
  private readonly delegations = new Map<string, Delegation>()
  /** Delegations started in a parent's current turn (reset every turn). */
  private readonly delegateCounts = new Map<string, { turnId: string; n: number }>()
  /** 'tool' rows already taken by a delegation (another parallel call does not reuse them). */
  private readonly claimedToolRows = new Set<string>()
  /** Sessions with a commit message or PR text being written. */
  /** Commit/PR generations in progress per session; text.cancel cancels them. */
  private writing = new Map<string, AbortController>()
  private prFiles = new PrFiles()
  /** Effort the agent declares at session start (Claude's init), for when Ladder has not chosen one. */
  private initEffort = new Map<string, Effort>()
  /** Sessions for which the automatic title attempt has already run (in memory: once per launch). */
  private titleTried = new Set<string>()
  private badge = -1
  /** Last number of working sessions reported to the main process. */
  private running = 0
  private archiveTimer: NodeJS.Timeout | null = null
  /** Background subagents finished since the last read of the session: they go in the summary and the badge. */
  private agentsNotices = new Map<string, { finished: number; failed: number; at: number }>()
  /** Finished (and failed) ones not yet announced: the 'done' notice collects them when all backgrounds have finished. It is cleared on every notice, on a failed turn and when the agent exits. */
  /** Backgrounds finished while the session was idle (no open turn) since the last turn: if the agent restarts on its own, the 'agent-start' row declares it. */
  private agentsBeforeTurn = new Map<string, number>()
  /** Backgrounds finished (and failed) with the coordinator stopped since the last turn: they feed the 'agents-finished' row. */
  private agentsIdle = new Map<string, { finished: number; failed: number }>()
  /** Wait after the last agent: if no turn starts, the 'agents-finished' row is created. */
  private agentsWait = new Map<string, NodeJS.Timeout>()
  /** Id of the 'agents-finished' row still 'waiting', per session. */
  private agentsRows = new Map<string, string>()
  /** Last closed turn per session: the 'agents-finished' row sits at the end of that turn. */
  private lastTurnIds = new Map<string, string>()
  private agentsPending = new Map<string, { finished: number; failed: number }>()
  /** PR per folder and branch (`root\0branch`); null: the branch has no PR. */
  private prs = new Map<string, PrDetails | null>()
  private prTimer: NodeJS.Timeout | null = null
  private defaultBranches = new Map<string, Promise<string>>()
  /** Sessions archived because their PR was merged: not retried. */
  private mergedHandled = new Set<string>()
  /** GitHub, Claude Code and Codex: state, tool download and browser login. */
  private readonly connections: Connections
  /** ACP agents being removed: an install that finishes in the meantime does not register them again. */
  private removingAcp = new Set<string>()
  /** ACP agents with a login in progress (`agents.authenticate`): the promise is reused for a second request, `abort` serves `agents.authenticate.cancel`. */
  private authenticating = new Map<string, { methodId: string; abort: AbortController; promise: Promise<AgentLogin> }>()
  /** Binary downloads of ACP agents. */
  private readonly installer = new AgentInstaller({
    update: (install) => this.broadcast({ type: 'agent.install', install }),
    installed: async (spec, signature) => {
      // Removed while the install was finishing: not registered again.
      if (this.removingAcp.has(spec.id)) return
      const previous = this.acpSpecs.get(spec.id)
      try {
        spec.icon = await iconData(spec.icon ?? null)
        await this.registerAcp(spec)
        this.saveAcpSpecs()
        this.kvSet(`acp-signature:${spec.id}`, JSON.stringify({ version: spec.version ?? null, signature }))
      } catch (error) {
        // The installer restores the previous folder: the in-memory state also goes back to what it was.
        if (previous) this.acpSpecs.set(spec.id, previous)
        else this.acpSpecs.delete(spec.id)
        // If `acp-agents` had already been written with the new entry, it goes back in the database too (the folder is the old one).
        try {
          this.saveAcpSpecs()
        } catch {
          // The database does not respond: nothing else to do here.
        }
        if (previous) await this.registerAcp(previous).catch(() => undefined)
        else if (this.agents.delete(`acp:${spec.id}`)) this.broadcast({ type: 'agent.removed', agent: `acp:${spec.id}` as AgentId })
        throw error
      }
    },
    checksums: {
      get: (id, version) => this.kvGet(`acp-checksum:${id}:${version}`),
      set: (id, version, sha256) => this.kvSet(`acp-checksum:${id}:${version}`, sha256)
    }
  })

  constructor(
    private readonly db: Db,
    private readonly broadcast: Broadcast,
    private readonly notify: Notify = () => undefined,
    /** Without it, events meant for a single connection (branch map) go to all. */
    private readonly sendTo?: SendTo
  ) {
    this.terminals = new TerminalManager(db, {
      upsert: (terminal) => this.broadcast({ type: 'terminal.upsert', terminal }),
      removed: (id) => this.broadcast({ type: 'terminal.removed', id }),
      data: (id, data) => this.broadcast({ type: 'terminal.data', id, data }),
      cleared: (id) => this.broadcast({ type: 'terminal.cleared', id }),
      agent: (terminal, signal) => this.onAgentSignal(terminal, signal),
      devServer: (terminal, url) => this.broadcast({ type: 'browser.devserver', projectId: terminal.projectId, terminalId: terminal.id, url })
    })
    this.otherAgents = new OtherAgents({
      specs: () => this.acpSpecs,
      login: (id) => this.login(id),
      saveLogin: (id, login) => this.saveLogin(id, login),
      emit: (agent) => this.broadcast({ type: 'agent.connection', agent }),
      terminals: this.terminals,
      project: (projectId) => {
        const project = projectId ? this.mustProject(projectId) : [...this.projects.values()][0]
        if (!project) throw new Error(t('Open a project first.'))
        return project
      }
    })
    this.watcher = new RootWatcher((root) => this.notifyFsChanged(root))
    this.fileRoots = new FileRoots((message) => this.notify(message), () => [...this.projects.values()].map((p) => p.path).concat([...this.rows.values()].map((r) => this.cwdOf(r))).filter(Boolean))
    this.gitStatus = new GitStatusTracker({
      emit: (status) => {
        this.broadcast({ type: 'git.status', status })
        this.touchBranchMapOf(status.root)
      },
      isWorktree: (root) => this.isWorktreeRoot(root),
      busy: (root) => this.busySession(root) !== null,
      fetched: (root) => this.touchBranchMapOf(root)
    })
    this.branchMaps = new BranchMapService({
      source: (projectId) => this.branchMapSource(projectId),
      emit: (projectId, map) => this.emitBranchMap(projectId, map),
      dirty: (cwd) => this.gitStatus.peek(cwd)?.dirty ?? null
    })
    this.ports = new Ports(db)
    this.plans = new Plans({
      db,
      broadcast: (event) => this.broadcast(event),
      attention: (event) => this.attention(event),
      project: (projectId) => this.projects.get(projectId),
      session: (sessionId) => {
        const row = this.rows.get(sessionId)
        return row ? { projectId: row.project_id, agent: row.agent as AgentId, archived: row.archived === 1 || this.archiving.has(sessionId), title: row.title, chat: row.mode !== 'terminal' } : null
      },
      rules: (projectId) => this.projectRules(projectId),
      createTaskSession: (spec) => this.createTaskSession(spec),
      send: (sessionId, text) => this.send(sessionId, text),
      interrupt: (sessionId) => this.interrupt(sessionId),
      lastAssistantText: (sessionId) => this.lastAssistantText(sessionId, this.lastTurnIds.get(sessionId) ?? ''),
      addCard: (sessionId, planId) => {
        this.upsertItem(sessionId, { kind: 'plan', id: `plan:${planId}`, turnId: this.runtimes.get(sessionId)?.turnId ?? 'system', at: Date.now(), planId })
        this.flush()
      },
      notice: (sessionId, text) => this.noticeInfo(sessionId, text),
      emitSummary: (sessionId) => this.emitSummary(sessionId),
      workspace: (state, kind) => this.planWorkspace(state, kind),
      sideWorktree: (state, task, from) => this.planSideWorktree(state, task, from),
      archiveSession: (sessionId) => this.archive(sessionId),
      removeWorktree: (projectId, path, branch) => this.dropPlanWorktree(this.mustProject(projectId), path, branch),
      changed: (root) => this.notifyFsChanged(root)
    })
    this.agentSessions = new AgentSessions({
      now: () => Date.now(),
      t,
      info: (sessionId) => {
        const row = this.rows.get(sessionId)
        if (!row) return null
        return { sessionId, projectId: row.project_id, agent: row.agent as AgentId, permission: row.permission as PermissionLevel, origin: row.origin ? (JSON.parse(row.origin) as NonNullable<SessionSummary['origin']>) : null, usable: row.mode !== 'terminal' && !this.isGone(sessionId) }
      },
      rules: (projectId) => this.projectRules(projectId),
      isGit: (projectId) => this.projects.get(projectId)?.isGit === true,
      list: (projectId) =>
        [...this.rows.values()]
          .filter((r) => r.project_id === projectId && !r.archived && !r.parent && r.mode !== 'terminal')
          .map((r) => ({ id: r.id, title: r.title, agent: r.agent as AgentId, model: this.modelOf(r), state: r.run_state, cwd: this.cwdOf(r), branch: this.branchOf(r), origin: r.origin ? (JSON.parse(r.origin) as NonNullable<SessionSummary['origin']>) : null })),
      start: (spec) => this.startAgentSession(spec),
      send: (sessionId, text) => this.send(sessionId, text),
      wait: (sessionId, timeoutMs, signal) => this.waitSession(sessionId, timeoutMs, signal),
      // Ask level: the same approval card as the other tools.
      confirm: async (sessionId, title, reason, signal) => {
        const response = await this.openRequest(
          sessionId,
          {
            requestType: 'permission',
            toolName: 'ladder_start_session',
            title,
            command: null,
            path: null,
            reason,
            options: [
              { id: 'allow', label: t('Approve'), kind: 'allow' },
              { id: 'deny', label: t('Deny'), kind: 'deny' }
            ],
            questions: null
          },
          signal
        )
        return 'optionId' in response && response.optionId === 'allow'
      }
    })
    this.projectGroups = new ProjectGroups(
      db,
      () => [...this.projects.keys()],
      (state) => this.broadcast({ type: 'projectGroups.changed', state })
    )
    this.shortcuts = new Shortcuts(
      db,
      join(dirname(process.env.LADDER_DB_PATH ?? ''), 'keybindings.json'),
      (state) => this.broadcast({ type: 'shortcuts.changed', state }),
      (message) => this.notify(message)
    )
    this.profiles = new Profiles(db)
    this.connections = new Connections({
      publish: (status) => this.broadcast({ type: 'connection.update', status }),
      openUrl: (url) => this.notify({ type: 'open-url', url }),
      changed: (id, reset, probe, profileId) => this.reloadAgent(id, reset, probe, profileId),
      profiles: () => this.profiles.all(),
      profile: (profileId) => this.profiles.get(profileId)
    })
  }

  // ── Avvio ────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    for (const row of this.db.prepare('select * from projects order by added_at').all() as unknown as ProjectRow[]) {
      this.projects.set(row.id, await this.projectFromRow(row))
    }
    for (const row of this.db.prepare('select * from sessions').all() as unknown as SessionRow[]) this.rows.set(row.id, row)
    // Main checkouts take the first port blocks (4100, …), before any worktree.
    for (const project of this.projects.values()) this.ports.allocate(project.path)
    const resumeQueued = this.recoverInterrupted()
    this.restoreLimitWatches()
    this.dismissStaleAgentsRows()
    await this.terminals.init()
    // Children left open after the parent was archived (or vanished): they are archived with it.
    for (const row of this.rows.values()) {
      const parent = row.archived ? null : this.parentOf(row)
      if (parent && (this.rows.get(parent.sessionId)?.archived ?? 1)) void this.archive(row.id).catch(() => undefined)
    }
    // Interrupted agent installs (app closed halfway): restore or clean up before reading the agents.
    const storedAcp = this.db.prepare(`select value from kv where key = 'acp-agents'`).get() as { value: string } | undefined
    const registered = new Map<string, AcpAgentSpec>()
    try {
      for (const spec of storedAcp ? (JSON.parse(storedAcp.value) as AcpAgentSpec[]) : []) registered.set(spec.id, spec)
    } catch {
      // Unreadable list: `.old` is deleted as if nothing were registered.
    }
    await recoverInstalls((id) => registered.get(id) ?? null).catch(() => undefined)
    await this.initAgents()
    // Plan tasks that were running when Ladder closed are marked interrupted (after the agents: the rules are needed).
    await this.plans.recover().catch((error: Error) => console.error(`[host] piani: ${error.message}`))
    // Sessions that were "Queued" before this version: the first queued message starts, once only.
    for (const id of resumeQueued) this.startFirstQueued(id)
    this.updateBadge()
    this.shortcuts.start()
    this.prTimer = setTimeout(() => void this.pollPrs(), 4000)
    void this.autoArchive()
    // The state of the links is read in the background: it reaches the UI as events.
    void this.connections.list().catch(() => undefined)
  }

  // ── Agenti ─────────────────────────────────────────────────────────────────

  /** Account and models of the last session: needed by the composer before a new session starts. */
  private cachedAgent(agent: string, profileId?: string): Partial<AgentStatus> {
    const row = this.db.prepare(`select value from kv where key = ?`).get(profileId ? `agent:${agent}:${profileId}` : `agent:${agent}`) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as Partial<AgentStatus>) : {}
  }

  private async initAgents(): Promise<void> {
    const [claudeCli, codexCli] = await Promise.all([findClaudeCli(), findCodexCli()])
    this.claudeCli = claudeCli
    this.codexCli = codexCli
    const [claudeVer, codexVer] = await Promise.all([claudeCli ? claudeVersion(claudeCli) : null, codexCli ? codexVersion(codexCli) : null])
    this.codexVer = codexVer
    const claude = this.cachedAgent('claude-code')
    this.agents.set('claude-code', {
      agent: 'claude-code',
      name: 'Claude',
      kind: 'native',
      account: claude.account ?? null,
      email: claude.email ?? null,
      usage: claude.usage ?? [],
      usageAt: claude.usageAt ?? null,
      models: claude.models ?? [],
      available: Boolean(claudeCli),
      version: claudeVer,
      path: claudeCli,
      error: claudeCli ? null : t('Claude was not found. Reinstall Ladder or sign in with the Claude Code CLI.')
    })
    const codex = this.cachedAgent('codex')
    this.agents.set('codex', {
      agent: 'codex',
      name: 'Codex',
      kind: 'native',
      account: codex.account ?? null,
      email: codex.email ?? null,
      usage: codex.usage ?? [],
      usageAt: codex.usageAt ?? null,
      models: codex.models ?? [],
      limits: codex.limits ?? null,
      available: Boolean(codexCli),
      version: codexVer,
      path: codexCli,
      error: codexCli ? null : t('Codex not found. Install the CLI (npm i -g @openai/codex, or the Codex app) and reopen Ladder.')
    })
    // At startup: Claude Code account, models and limits, without waiting for the first session. If it does not respond the session will find out.
    if (claudeCli) {
      void probeClaude(claudeCli)
        .then((info) => this.updateAgent('claude-code', info))
        .catch(() => undefined)
    }
    // A non-default profile has its own state, account and limits: read in the background like the default.
    for (const profile of this.profiles.all()) {
      if (profile.isDefault) continue
      this.profileStatus(profile)
      this.probeProfile(profile)
    }
    // Codex account, models and limits without waiting for the first session (no turn, no quota).
    if (codexCli) {
      void probeCodex(codexCli, '0.0.0')
        .then((info) => this.updateAgent('codex', info))
        .catch((error: Error) => this.updateAgent('codex', { error: t('Codex is not responding: {message}', { message: error.message }) }))
    }
    const stored = this.db.prepare(`select value from kv where key = 'acp-agents'`).get() as { value: string } | undefined
    for (const spec of stored ? (JSON.parse(stored.value) as AcpAgentSpec[]) : []) await this.registerAcp(spec)
  }

  /** State of a non-default profile: the same tool data as the default, plus its own account, models and limits. */
  private profileStatus(profile: Profile): AgentStatus {
    const existing = this.profileAgents.get(profile.id)
    if (existing) return existing
    const base = this.agents.get(profile.agent)!
    const cached = this.cachedAgent(profile.agent, profile.id)
    const status: AgentStatus = {
      ...base,
      profileId: profile.id,
      account: cached.account ?? null,
      email: cached.email ?? null,
      usage: cached.usage ?? [],
      usageAt: cached.usageAt ?? null,
      // Until the profile is read, models are those of the default (usually the same).
      models: cached.models?.length ? cached.models : base.models,
      limits: cached.limits ?? null
    }
    this.profileAgents.set(profile.id, status)
    return status
  }

  /** Account, models and limits of the profile without opening sessions; in the background. */
  private probeProfile(profile: Profile): void {
    if (profile.agent === 'claude-code') {
      if (this.claudeCli) void probeClaude(this.claudeCli, profile.configDir).then((info) => this.updateAgent(profile.agent, info, false, profile.id), () => undefined)
    } else if (this.codexCli) {
      void probeCodex(this.codexCli, '0.0.0', profile.configDir).then((info) => this.updateAgent(profile.agent, info, false, profile.id), () => undefined)
    }
  }

  private async registerAcp(spec: AcpAgentSpec): Promise<AgentStatus> {
    this.acpSpecs.set(spec.id, spec)
    const agent = `acp:${spec.id}` as AgentId
    const cached = this.cachedAgent(agent)
    const resolved = await whichInShell(spec.command)
    // An absolute path (detected CLI, downloaded binary) must still exist.
    const command = resolved && (!resolved.startsWith('/') || existsSync(resolved)) ? resolved : null
    const status: AgentStatus = {
      agent,
      name: spec.name,
      kind: 'acp',
      account: cached.account ?? null,
      models: cached.models ?? [],
      available: Boolean(command),
      version: spec.version ?? null,
      path: command,
      icon: spec.icon ?? null,
      error: command ? null : t('Command “{command}” not found in the shell PATH.', { command: spec.command })
    }
    this.agents.set(agent, status)
    this.broadcast({ type: 'agent.status', status })
    return status
  }

  private saveAcpSpecs(): void {
    this.db
      .prepare(`insert into kv (key, value) values ('acp-agents', ?) on conflict(key) do update set value = excluded.value`)
      .run(JSON.stringify([...this.acpSpecs.values()]))
  }

  private kvGet(key: string): string | null {
    return (this.db.prepare(`select value from kv where key = ?`).get(key) as { value: string } | undefined)?.value ?? null
  }

  private kvSet(key: string, value: string): void {
    this.db.prepare(`insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`).run(key, value)
  }

  /** Signature recorded when a version is installed (codesign), null if unknown. */
  private signatureOf(id: string, version: string): AgentSignature | null {
    try {
      const saved = JSON.parse(this.kvGet(`acp-signature:${id}`) ?? 'null') as { version: string | null; signature: AgentSignature } | null
      return saved && saved.version === version ? saved.signature : null
    } catch {
      return null
    }
  }

  /** Dependencies of the agent catalog (`agents.catalog` and `agents.detect`). */
  private catalogDeps() {
    return {
      specs: this.acpSpecs,
      login: (id: string) => this.login(id),
      installs: (id: string) => this.installer.current(id),
      recorded: (id: string, version: string) => this.kvGet(`acp-checksum:${id}:${version}`),
      signature: (id: string, version: string) => this.signatureOf(id, version)
    }
  }

  private login(id: string): AgentLogin {
    const row = this.db.prepare(`select value from kv where key = ?`).get(`acp-login:${id}`) as { value: string } | undefined
    try {
      return row ? (JSON.parse(row.value) as AgentLogin) : UNKNOWN_LOGIN
    } catch {
      return UNKNOWN_LOGIN
    }
  }

  private saveLogin(id: string, login: AgentLogin): void {
    this.kvSet(`acp-login:${id}`, JSON.stringify(login))
    this.broadcast({ type: 'agent.login', id, login })
  }

  /**
   * Login with an agent method (ACP `authenticate`): no credentials pass through Ladder. A second request with the
   * same method while the login is in progress reuses the same promise (a single process); with another method it is an error.
   * If the login is cancelled (`agents.authenticate.cancel`) the login responds as it was, without an error.
   */
  private authenticateAcp(id: string, methodId: string, projectId?: string): Promise<AgentLogin> {
    const spec = this.acpSpecs.get(id)
    if (!spec) return Promise.reject(new Error(t('Unknown ACP agent.')))
    const running = this.authenticating.get(id)
    if (running) return running.methodId === methodId ? running.promise : Promise.reject(new Error(t('Sign-in is already in progress.')))
    const known = this.login(id)
    const method = known.methods.find((m) => m.id === methodId)
    if (!method) return Promise.reject(new Error(t('This sign-in method is not available for the agent.')))
    if (method.type === 'terminal') return Promise.reject(new Error(t('Signing in through a terminal is not supported yet.')))
    if (method.type !== 'agent') return Promise.reject(new Error(t('This sign-in method is not supported by Ladder.')))
    const cwd = projectId ? this.mustProject(projectId).path : homedir()
    const abort = new AbortController()
    const promise = acpAuthenticate(spec, methodId, cwd, abort.signal).then(
      (login) => {
        this.saveLogin(id, login)
        return login
      },
      (error: Error) => {
        if (error.name === 'AbortError') return this.login(id)
        throw error
      }
    )
    const entry = { methodId, abort, promise }
    this.authenticating.set(id, entry)
    // The entry is freed only if it is still this one (a cancel followed by a new request must not remove another's).
    void promise.then(
      () => undefined,
      () => undefined
    ).finally(() => {
      if (this.authenticating.get(id) === entry) this.authenticating.delete(id)
    })
    return promise
  }

  /** Stops a login in progress: kills the agent process and frees the id at once. */
  private cancelAuthenticate(id: string): void {
    const entry = this.authenticating.get(id)
    if (!entry) return
    this.authenticating.delete(id)
    entry.abort.abort()
  }

  private async addAcpAgent(input: AcpAgentSpec): Promise<AgentStatus> {
    let spec = input
    if (input.source === 'registry') {
      const entry = await registryEntry(input.id)
      if (!entry) throw new Error(t('Agent not found in the ACP registry.'))
      if (hasUnsafeArgs(entry)) throw new Error(t('The registry gives arguments or settings for this agent that Ladder does not accept.'))
      // Already downloaded binary or CLI detected in PATH, then npx/uvx. Only the binary to download goes through `agents.install`.
      const fromRegistry = (await resolveAgentSpec(entry, this.acpSpecs.get(entry.id))) ?? (await registrySpec(input.id))
      if (!fromRegistry) throw new Error(t('This agent is distributed as a binary: install it from the catalog first.'))
      if (!fromRegistry.icon?.startsWith('data:')) fromRegistry.icon = await iconData(fromRegistry.icon ?? null)
      spec = fromRegistry
    } else {
      const id = (input.id || input.name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      if (!id || !input.command.trim()) throw new Error(t('A name and a command are required.'))
      if (id === 'claude-code' || id === 'codex') throw new Error(t('This name is reserved for native agents.'))
      spec = { ...input, id, name: input.name.trim() || id, command: input.command.trim(), args: input.args.filter(Boolean) }
    }
    const status = await this.registerAcp(spec)
    this.saveAcpSpecs()
    return status
  }

  private async removeAcpAgent(id: string): Promise<void> {
    this.removingAcp.add(id)
    try {
      // An install or update in progress stops and cleans up before touching the folder.
      const hadJob = await this.installer.cancelAndWait(id)
      const spec = this.acpSpecs.get(id)
      const registered = this.acpSpecs.delete(id)
      // The binary downloaded by Ladder is removed with the agent (even if the install finished without registering it); a user's CLI is left alone.
      if (spec?.distribution === 'binary' || hadJob) {
        await rm(agentDir(id), { recursive: true, force: true }).catch(() => undefined)
        this.db.prepare(`delete from kv where key = ?`).run(`acp-signature:${id}`)
      }
      if (!registered) return
    } finally {
      this.removingAcp.delete(id)
    }
    this.agents.delete(`acp:${id}`)
    this.saveAcpSpecs()
    this.broadcast({ type: 'agent.removed', agent: `acp:${id}` })
  }

  /** `reset`: after an account logout, email and limits are cleared (otherwise a missing value does not erase the previous one). */
  private updateAgent(agent: string, patch: Partial<AgentStatus>, reset = false, profileId?: string): void {
    const current = profileId ? this.profileAgents.get(profileId) : this.agents.get(agent)
    if (!current) return
    const next: AgentStatus = {
      ...current,
      ...patch,
      account: reset ? (patch.account ?? null) : (patch.account ?? current.account),
      email: reset ? (patch.email ?? null) : (patch.email ?? current.email ?? null),
      models: patch.models?.length ? patch.models : current.models,
      limits: reset ? (patch.limits ?? null) : (patch.limits ?? current.limits ?? null),
      ...(reset ? { usage: patch.usage ?? [], usageAt: patch.usageAt ?? null } : {})
    }
    if (profileId) this.profileAgents.set(profileId, next)
    else this.agents.set(agent, next)
    this.db
      .prepare(`insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`)
      .run(profileId ? `agent:${agent}:${profileId}` : `agent:${agent}`, JSON.stringify({ account: next.account, email: next.email ?? null, models: next.models, limits: next.limits ?? null, usage: next.usage ?? [], usageAt: next.usageAt ?? null }))
    this.broadcast({ type: 'agent.status', status: next })
  }

  /**
   * After a download, a login or a logout: looks the CLI up again, updates availability and version and re-reads
   * the agent's account, models and limits without opening sessions. GitHub is not an agent: nothing to do here.
   */
  private async reloadAgent(id: 'github' | 'claude-code' | 'codex', reset: boolean, probe = !reset, profileId?: string): Promise<void> {
    if (id === 'github') return
    const custom = customProfileId(profileId)
    const profile = custom ? this.profiles.get(custom) : null
    if (custom && !profile) return
    let patch: Partial<AgentStatus>
    if (id === 'claude-code') {
      const cli = await findClaudeCli()
      this.claudeCli = cli
      patch = { available: Boolean(cli), path: cli, version: cli ? await claudeVersion(cli) : null, error: cli ? null : t('Claude was not found. Reinstall Ladder or sign in with the Claude Code CLI.') }
    } else {
      const cli = await findCodexCli()
      this.codexCli = cli
      this.codexVer = cli ? await codexVersion(cli) : null
      patch = { available: Boolean(cli), path: cli, version: this.codexVer, error: cli ? null : t('Codex not found. Install the CLI (npm i -g @openai/codex, or the Codex app) and reopen Ladder.') }
    }
    // The tool is a single one: availability and version apply to the default and to every profile; the reset only to the one that changed.
    this.updateAgent(id, patch, reset && !custom)
    for (const other of this.profiles.customOf(id)) this.updateAgent(id, patch, reset && other.id === custom, other.id)
    const cli = this.cliOf(id)
    if (!cli || !probe) return
    const configDir = profile?.configDir ?? null
    const info = await (id === 'claude-code' ? probeClaude(cli, configDir) : probeCodex(cli, '0.0.0', configDir)).catch(() => null)
    if (info) this.updateAgent(id, info, false, custom)
  }

  private cliOf(agent: ProfileAgent): string | null {
    return agent === 'claude-code' ? this.claudeCli : this.codexCli
  }

  private usageRefresh = new Map<string, Promise<AgentStatus | null>>()

  /** Usage limits read again, with a short-lived process and no turn. Two quick clicks share the same read. */
  private refreshUsage(agent: string, profileId?: string | null): Promise<AgentStatus | null> {
    const custom = isProfileAgent(agent) ? customProfileId(profileId) : undefined
    const profile = custom ? this.profiles.get(custom) : null
    if (custom && (!profile || profile.agent !== agent)) return Promise.reject(new Error(t('Account not found.')))
    const key = custom ? `${agent}:${custom}` : agent
    const running = this.usageRefresh.get(key)
    if (running) return running
    const configDir = profile?.configDir ?? null
    const read = async (): Promise<AgentStatus | null> => {
      if (agent === 'claude-code' && this.claudeCli) this.updateAgent(agent, await probeClaude(this.claudeCli, configDir), false, custom)
      else if (agent === 'codex' && this.codexCli) this.updateAgent(agent, await probeCodex(this.codexCli, '0.0.0', configDir), false, custom)
      return (custom ? this.profileAgents.get(custom) : this.agents.get(agent)) ?? null
    }
    const promise = read().finally(() => this.usageRefresh.delete(key))
    this.usageRefresh.set(key, promise)
    return promise
  }

  private agentName(agent: string): string {
    return this.agents.get(agent)?.name ?? agent
  }

  /** The right adapter for the agent: sessions and reviews use it the same way. */
  private createAdapter(agent: string, options: SessionOptions & { outputSchema?: unknown }, events: AdapterEvents, profileId: string | null = null): AgentSession {
    const status = this.agents.get(agent)
    if (!status) throw new Error(t('Unknown agent: add it in Settings → Agents.'))
    if (!status.available) throw new Error(status.error ?? t('{agent} is not available.', { agent: status.name }))
    // Account credentials live in the profile folder; without them, those of the CLI.
    const configDir = this.profiles.configDir(profileId)
    if (agent === 'claude-code') return new ClaudeSession({ ...options, cli: this.claudeCli, configDir }, events)
    if (agent === 'codex') return new CodexSession({ ...options, cli: this.codexCli!, version: '0.0.0', configDir }, events)
    const spec = this.acpSpecs.get(agent.replace(/^acp:/, ''))
    if (!spec) throw new Error(t('Unknown ACP agent.'))
    return new AcpSession({ ...options, spec, onLogin: (login) => this.saveLogin(spec.id, login) }, events)
  }

  // ── Review with another agent ─────────────────────────────────────────────

  private async startReview(sessionId: string, agent: AgentId, scope: DiffScope): Promise<ReviewState> {
    const row = this.mustRow(sessionId)
    const project = this.mustProject(row.project_id)
    const root = this.cwdOf(row)
    const settings = await loadProjectSettings(project.path)
    if (settings.agents.allowed.length && !settings.agents.allowed.includes(agent)) throw new Error(t('{agent} is not allowed by .ladder/settings.toml.', { agent: this.agentName(agent) }))
    const diff = await diffFiles(this.db, root, scope)
    if (diff.files.length === 0) throw new Error(t('No changes to review in this scope.'))
    const patch = await patchText(root, diff.from, diff.to)
    const base = await renderPrompt(project.path, 'review', {})
    const run = new ReviewRun(
      {
        create: (id, options, events) => this.createAdapter(id, options, events, this.profiles.resolve(id, project.id)),
        publish: (review) => this.broadcast({ type: 'review.update', review: { ...review } })
      },
      { sessionId, agent, agentName: this.agentName(agent), scope }
    )
    this.reviews.set(run.state.id, run)
    run.start(root, reviewPrompt(base, patch))
    return { ...run.state }
  }

  /** Reply from the main process to a browser operation of the agent. */
  browserAgentResult(rid: string, result: BrowserAgentResult): void {
    this.browserAgent.onResult(rid, result)
  }

  /** The agent's view was closed by the main process (tab or window closed). */
  browserAgentClosed(sessionId: string): void {
    this.browserAgent.onClosed(sessionId)
  }

  /** Preferences from the main process. */
  setPrefs(prefs: HostPrefs): void {
    if (prefs.locale) setLocale(prefs.locale)
    this.prefs = { generatedTitles: prefs.generatedTitles ?? this.prefs.generatedTitles, generatedText: prefs.generatedText ?? this.prefs.generatedText, autonomyHint: prefs.autonomyHint ?? this.prefs.autonomyHint, stallHint: prefs.stallHint ?? this.prefs.stallHint, worktreesDir: prefs.worktreesDir !== undefined ? prefs.worktreesDir : this.prefs.worktreesDir, branchPrefix: prefs.branchPrefix !== undefined ? cleanBranchPrefix(prefs.branchPrefix) : this.prefs.branchPrefix, autoArchiveDays: prefs.autoArchiveDays !== undefined ? prefs.autoArchiveDays : this.prefs.autoArchiveDays, agentBrowser: prefs.agentBrowser ?? this.prefs.agentBrowser, busySend: prefs.busySend ?? this.prefs.busySend, defaults: prefs.defaults ?? this.prefs.defaults }
    this.browserAgent.sync()
    void this.autoArchive()
  }

  /** Sessions that were working when Ladder was closed: they come back idle, with a note and expired requests. */
  private recoverInterrupted(): string[] {
    const resume: { id: string; at: number }[] = []
    // Advice with entries still 'running': child sessions do not restart, the entry becomes 'stopped'.
    const advices = this.db.prepare(`select session_id, json from items where json like '%"kind":"advice"%' and json like '%"state":"running"%'`).all() as { session_id: string; json: string }[]
    for (const { session_id, json } of advices) {
      const item = JSON.parse(json) as ChatItem
      if (item.kind !== 'advice') continue
      const entries = item.entries.map((e) => (e.state === 'running' ? { ...e, state: 'stopped' as const, error: t('Ladder was closed before the advice was ready.') } : e))
      this.writeItem(session_id, { ...item, entries })
    }
    // Resumed delegations left 'resumed': the process is gone, the card is open again.
    const resumed = this.db.prepare(`select session_id, json from items where json like '%"kind":"resume"%' and json like '%"state":"resumed"%'`).all() as { session_id: string; json: string }[]
    for (const { session_id, json } of resumed) {
      const item = JSON.parse(json) as ChatItem
      if (item.kind === 'resume' && item.state === 'resumed') this.writeItem(session_id, { ...item, state: 'open', error: null, reason: t('Ladder was closed while the delegate was working.') })
    }
    // Delegations in progress at close: the child stays stopped (the loop below does it), the parent's 'tool' row closes with a readable
    // error and the resume card appears next to it.
    for (const row of this.rows.values()) {
      const parent = this.parentOf(row)
      if (parent?.role !== 'delegate') continue
      const saved = this.db.prepare('select json from items where session_id = ? and id = ?').get(parent.sessionId, parent.itemId) as { json: string } | undefined
      const item = saved ? (JSON.parse(saved.json) as ChatItem) : null
      if (item?.kind === 'tool' && item.status === 'running') {
        const resumable = !row.archived && row.mode === 'chat' && !this.rows.get(parent.sessionId)?.archived
        this.writeItem(parent.sessionId, { ...item, status: 'error', endedAt: Date.now(), output: resumable ? t('Ladder was closed while the delegate was working. The delegation did not finish: resume it from the card below, or ask the agent to delegate again.') : t('Ladder was closed while the delegate was working. The delegation did not finish; ask the agent to delegate again if it is still needed.') })
        if (resumable) {
          this.writeItem(parent.sessionId, this.withSeq(parent.sessionId, { kind: 'resume', id: `${item.id}:resume`, turnId: item.turnId, at: Date.now(), toolItemId: item.id, agent: row.agent as AgentId, childSessionId: row.id, reason: t('Ladder was closed while the delegate was working.'), state: 'open', error: null }))
        }
      }
    }
    for (const row of this.rows.values()) {
      // Handoff left half done: the summary is not resumed, the row does not stay 'summarizing'.
      if (row.handoff) this.recoverHandoff(row)
      // 'queued' state from earlier versions (turn limit, now removed): it goes back to idle, messages stay queued and the first restarts.
      if ((row.run_state as string) === 'queued') {
        this.updateRow(row.id, { run_state: 'idle' })
        if (!row.archived && (JSON.parse(row.queue) as QueuedMessage[]).length) resume.push({ id: row.id, at: row.updated_at })
        continue
      }
      if (row.run_state === 'idle' || row.run_state === 'error') continue
      if (row.mode === 'terminal') {
        // The process is gone: the session view offers "Resume".
        this.updateRow(row.id, { run_state: 'idle', estimated: 0 })
        continue
      }
      const open = this.db
        .prepare(`select id, json from items where session_id = ? and json like '%"state":"open"%'`)
        .all(row.id) as { id: string; json: string }[]
      tx(this.db, () => {
        for (const { json } of open) {
          const item = JSON.parse(json) as ChatItem
          if (item.kind === 'request') this.writeItem(row.id, { ...item, state: 'expired', resolution: t('Expired') })
        }
        this.writeItem(row.id, this.withSeq(row.id, {
          kind: 'notice',
          id: randomUUID(),
          turnId: 'recovery',
          at: Date.now(),
          tone: 'info',
          text: t('Ladder was closed while the session was working. Send a message to continue.')
        }))
        this.updateRow(row.id, { run_state: 'idle' })
      })
    }
    return resume.sort((a, b) => a.at - b.at).map((r) => r.id)
  }

  /**
   * The 'out' row of a handoff interrupted by a restart becomes 'interrupted' (or 'done' if the destination session already existed).
   * The already saved summary stays and the row is 'resumable': the resume card delivers without repeating anything.
   */
  private recoverHandoff(row: SessionRow): void {
    try {
      const run = JSON.parse(row.handoff!) as HandoffRun
      const saved = this.db.prepare('select json from items where session_id = ? and id = ?').get(row.id, run.itemId) as { json: string } | undefined
      const item = saved ? (JSON.parse(saved.json) as ChatItem) : null
      if (item?.kind === 'handoff' && (item.state === 'summarizing' || item.state === 'pending')) {
        // Delivered only if the destination session has the 'in' row pointing at this one.
        const inRows = item.peerSessionId ? (this.db.prepare(`select json from items where session_id = ? and id = ?`).all(item.peerSessionId, `${run.itemId}:in`) as { json: string }[]) : []
        const arrived = inRows.some((r) => (JSON.parse(r.json) as { peerSessionId?: string }).peerSessionId === row.id)
        const reason = item.summary?.trim() ? t('Ladder was closed during the handoff. The summary is saved: resume to hand it over.') : t('Ladder was closed before the summary was ready. Nothing was handed over: resume to ask for it again.')
        this.writeItem(row.id, arrived ? { ...item, state: 'done', resumable: false } : { ...item, peerSessionId: null, state: 'interrupted', error: reason, resumable: true })
        // Plan-limit handoff delivered: the card becomes 'switched' (restoreLimitWatches, right after, resumes watching for the reset).
        if (arrived && run.limitItemId) {
          const saved = this.db.prepare('select json from items where session_id = ? and id = ?').get(row.id, run.limitItemId) as { json: string } | undefined
          const limit = saved ? (JSON.parse(saved.json) as ChatItem) : null
          if (limit?.kind === 'limit') this.writeItem(row.id, { ...limit, state: 'switched', peerSessionId: item.peerSessionId, error: null })
        }
        // Plan-limit handoff not delivered: the proposal goes back to proposed.
        if (!arrived && run.limitItemId) {
          const saved = this.db.prepare('select json from items where session_id = ? and id = ?').get(row.id, run.limitItemId) as { json: string } | undefined
          const limit = saved ? (JSON.parse(saved.json) as ChatItem) : null
          if (limit?.kind === 'limit') this.writeItem(row.id, { ...limit, state: 'proposed', automatic: false, peerSessionId: null, error: reason })
        }
      }
    } catch {
      // Unreadable state: just reset it.
    }
    this.updateRow(row.id, { handoff: null })
  }

  /** Starts the first queued message of an idle session (migration from the 'queued' state). */
  private startFirstQueued(sessionId: string): void {
    const row = this.rows.get(sessionId)
    if (!row || row.archived || row.run_state !== 'idle') return
    const queue = JSON.parse(row.queue) as QueuedMessage[]
    const next = queue.shift()
    if (!next) return
    this.updateRow(sessionId, { queue: JSON.stringify(queue) })
    void this.startTurn(sessionId, next.text, next.attachments ?? []).catch((e: Error) => {
      // The message goes back to the head of the queue and the runtime closes, as in the restart after exit.
      const current = JSON.parse(this.rows.get(sessionId)?.queue ?? '[]') as QueuedMessage[]
      current.unshift(next)
      this.revokeTools(sessionId)
      this.runtimes.get(sessionId)?.adapter.close()
      this.runtimes.delete(sessionId)
      this.updateRow(sessionId, { queue: JSON.stringify(current), run_state: 'idle' })
      this.noticeError(sessionId, e.message)
      this.emitSummary(sessionId)
    })
  }

  /** 'agents-finished' rows left 'waiting' from before the restart: superseded if the session had turns afterwards, otherwise they stay (a future turn closes them). */
  private dismissStaleAgentsRows(): void {
    const stale = this.db
      .prepare(`select session_id, seq, json from items where json like '%"kind":"agents-finished"%' and json like '%"state":"waiting"%' order by seq`)
      .all() as { session_id: string; seq: number; json: string }[]
    for (const { session_id, seq, json } of stale) {
      const item = JSON.parse(json) as ChatItem
      if (item.kind !== 'agents-finished' || item.state !== 'waiting' || !this.rows.has(session_id)) continue
      const later = this.db
        .prepare(`select 1 from items where session_id = ? and seq > ? and (json like '%"kind":"turn-end"%' or json like '%"kind":"user"%') limit 1`)
        .get(session_id, seq)
      if (later) this.writeItem(session_id, { ...item, state: 'dismissed' })
      else this.agentsRows.set(session_id, item.id)
    }
  }

  private async projectFromRow(row: ProjectRow): Promise<Project> {
    const info = existsSync(row.path) ? await repoInfo(row.path) : { isGit: false, branch: null, hasHead: false }
    const profiles = this.profiles.forProject(row.id)
    return { id: row.id, name: row.name, path: row.path, branch: info.branch, isGit: info.isGit, addedAt: row.added_at, ...(profiles ? { profiles } : {}) }
  }

  async snapshot(): Promise<Extract<HostEvent, { type: 'snapshot' }>> {
    // Branches change outside Ladder: we re-read them on every new UI connection.
    for (const project of this.projects.values()) {
      const info = existsSync(project.path) ? await repoInfo(project.path) : null
      if (info) this.projects.set(project.id, { ...project, branch: info.branch, isGit: info.isGit })
    }
    const drafts: Record<DraftKey, string> = {}
    for (const { key, text } of this.db.prepare('select key, text from drafts').all() as { key: string; text: string }[]) drafts[key] = text
    const ui: Record<string, ProjectUiState> = {}
    for (const { project_id, json } of this.db.prepare('select project_id, json from ui_state').all() as { project_id: string; json: string }[]) {
      ui[project_id] = JSON.parse(json) as ProjectUiState
    }
    return {
      type: 'snapshot',
      projects: [...this.projects.values()],
      sessions: [...this.rows.values()].filter((r) => !r.archived).map((r) => this.summary(r.id)),
      drafts,
      ui,
      projectGroups: this.projectGroups.get(),
      shortcuts: this.shortcuts.get(),
      agents: [...this.agents.values(), ...this.profileAgents.values()],
      profiles: this.profiles.all(),
      terminals: this.terminals.list(),
      connections: this.connections.cached(),
      plans: this.plans.snapshot()
    }
  }

  // ── Commands from the UI ─────────────────────────────────────────────────

  /** `origin`: the connection (port) the command comes from; used for subscriptions, which disappear with it (`connectionClosed`). */
  async handle(command: HostCommand, origin: object = LOCAL_ORIGIN, signal?: AbortSignal): Promise<unknown> {
    switch (command.type) {
      case 'hello':
        return this.snapshot()
      case 'project.add':
        return this.addProject(command.path)
      case 'project.remove':
        // The project's archivals in progress finish first (cleanup script included), then the project disappears.
        await Promise.all([...this.rows.values()].filter((r) => r.project_id === command.projectId).map((r) => this.archiveRuns.get(r.id)?.catch(() => undefined)))
        this.db.prepare('delete from projects where id = ?').run(command.projectId)
        this.profiles.dropProject(command.projectId)
        this.projects.delete(command.projectId)
        for (const row of this.rows.values()) if (row.project_id === command.projectId) this.unsubscribeGit(row.id)
        this.branchMaps.forget(command.projectId)
        for (const [conn, subs] of this.branchMapSubs) {
          subs.delete(command.projectId)
          if (subs.size === 0) this.branchMapSubs.delete(conn)
        }
        this.terminals.forgetProject(command.projectId)
        for (const terminal of this.terminals.list()) if (terminal.projectId === command.projectId) this.terminals.close(terminal.id)
        for (const row of this.rows.values()) if (row.project_id === command.projectId) this.commandLists.delete(row.id)
        this.broadcast({ type: 'project.removed', projectId: command.projectId })
        this.projectGroups.sync()
        return null
      case 'session.create':
        // Sessions created from the CLI get origin cli.
        return this.createSession(command, origin === CLI_ORIGIN ? { kind: 'cli' } : null)
      case 'session.resume':
        return this.resumeTerminalSession(command.sessionId)
      case 'session.send':
        // Writing to a stopped task puts it back in progress.
        this.plans.userWrote(command.sessionId)
        await this.send(command.sessionId, command.text, command.attachments ?? [], command.busy)
        return null
      case 'session.continue':
        await this.continueAgents(command.sessionId, command.itemId)
        return null
      case 'session.commands':
        return this.commandsFor(command.sessionId)
      case 'session.command':
        await this.runCommand(command.sessionId, command.name, command.args.trim())
        return null
      case 'session.handoff':
        this.assertNotChild(command.sessionId, t('A child session (advice or delegation) cannot be handed over.'))
        await this.startHandoff(command)
        return null
      case 'session.handoff.stop':
        await this.stopHandoff(command.sessionId, command.itemId)
        return null
      case 'session.handoff.resume':
        this.assertNotChild(command.sessionId, t('A child session (advice or delegation) cannot be handed over.'))
        await this.resumeHandoff(command)
        return null
      case 'session.delegation.resume':
        await this.resumeDelegation(command.sessionId, command.itemId, command.action)
        return null
      case 'session.limit.respond':
        this.assertNotChild(command.sessionId, t('A child session (advice or delegation) cannot be handed over.'))
        await this.respondLimit(command)
        return null
      case 'project.agents.set': {
        const project = this.mustProject(command.projectId)
        for (const agent of [command.patch.autoSwitch, command.patch.crossReview]) if (agent && !this.agents.has(agent)) throw new Error(t('Unknown agent: add it in Settings → Agents.'))
        await saveAgentsSettings(project.path, command.patch)
        // The personal file is not committed to git.
        void ensureExcluded(project.path, PERSONAL_PATTERNS).catch(() => undefined)
        return loadProjectSettings(project.path)
      }
      case 'session.advise':
        return this.advise(command)
      case 'session.advice.stop':
        await this.stopAdvice(command.sessionId, command.itemId)
        return null
      case 'session.advice.forward':
        await this.forwardAdvice(command.sessionId, command.itemId, command.note ?? null)
        return null
      case 'session.implement':
        return this.implement(command)
      case 'session.rename': {
        const title = command.title.trim()
        if (title) {
          // A manually chosen title wins over any automatic generation.
          this.updateRow(command.sessionId, { title, title_source: 'user' })
          this.emitSummary(command.sessionId)
        }
        return null
      }
      case 'session.title.regenerate':
        return this.regenerateTitle(command.sessionId)
      case 'session.unread': {
        const row = this.mustRow(command.sessionId)
        this.updateRow(row.id, { last_read_seq: Math.max(0, row.last_activity_seq - 1) })
        this.emitSummary(row.id)
        return null
      }
      case 'subagent.detail':
        return this.subagentDetail(command.sessionId, command.id)
      case 'subagent.list':
        this.mustRow(command.sessionId)
        return this.subagents.list(command.sessionId) ?? []
      case 'project.files':
        return this.projectFiles(command.projectId)
      case 'session.queue.set': {
        // The UI receives the queue without image data: attachments stay the ones saved here.
        const stored = new Map((JSON.parse(this.mustRow(command.sessionId).queue) as QueuedMessage[]).map((q) => [q.id, q]))
        const queue = command.queue.map((q) => {
          const attachments = stored.get(q.id)?.attachments
          return { id: q.id, text: q.text, ...(attachments?.length ? { attachments } : {}) }
        })
        this.updateRow(command.sessionId, { queue: JSON.stringify(queue) })
        this.emitSummary(command.sessionId)
        return null
      }
      case 'session.queue.deliver':
        await this.deliverQueued(command.sessionId, command.id, command.how)
        return null
      case 'session.interrupt':
        await this.interrupt(command.sessionId)
        return null
      case 'session.respond':
        this.respond(command.sessionId, command.requestId, command.response, command.via ?? 'chat', undefined, command.viaDevice)
        return null
      case 'session.permission.set':
        this.assertNotChild(command.sessionId, t('The permission level of a child session (advice or delegation) cannot be changed.'))
        return await this.setPermission(command.sessionId, command.permission)
      case 'session.effort.set': {
        this.mustRow(command.sessionId)
        this.updateRow(command.sessionId, { effort: command.effort })
        await this.runtimes.get(command.sessionId)?.adapter.setEffort(command.effort)
        this.emitSummary(command.sessionId)
        return null
      }
      case 'session.model.set':
        this.initEffort.delete(command.sessionId)
        this.updateRow(command.sessionId, { model: command.model })
        await this.runtimes.get(command.sessionId)?.adapter.setModel(command.model)
        this.emitSummary(command.sessionId)
        return null
      case 'session.open':
        this.clearAgentsNotice(command.sessionId)
        this.broadcast({ type: 'session.items', sessionId: command.sessionId, items: this.loadItems(command.sessionId), replace: true })
        return null
      case 'session.read': {
        this.clearAgentsNotice(command.sessionId)
        const row = this.rows.get(command.sessionId)
        if (row && row.last_read_seq < row.last_seq) {
          this.updateRow(row.id, { last_read_seq: row.last_seq })
          this.emitSummary(row.id)
        }
        return null
      }
      case 'session.archive':
        await this.archive(command.sessionId)
        return null
      case 'session.restartAgent':
        this.restartAgent(command.sessionId)
        return null
      case 'draft.set':
        if (command.text.trim()) {
          this.db
            .prepare('insert into drafts (key, text, updated_at) values (?, ?, ?) on conflict(key) do update set text = excluded.text, updated_at = excluded.updated_at')
            .run(command.key, command.text, Date.now())
        } else {
          this.db.prepare('delete from drafts where key = ?').run(command.key)
        }
        return null
      case 'ui.set':
        this.db
          .prepare('insert into ui_state (project_id, json) values (?, ?) on conflict(project_id) do update set json = excluded.json')
          .run(command.projectId, JSON.stringify(command.state))
        this.browserAgent.sync()
        return null
      // ── Agent browser ──
      case 'browser.agent.stop':
        return this.browserAgent.stop(command.sessionId)
      case 'browser.agent.resume':
        return this.browserAgent.resume(command.sessionId)
      case 'browser.agent.state':
        return this.browserAgent.snapshot(command.sessionId)
      // ── End of agent browser ──

      // ── CLI ──
      case 'session.wait':
        return this.waitSession(command.sessionId, command.timeoutMs, signal)
      case 'session.transcript':
        this.mustRow(command.sessionId)
        return this.loadItems(command.sessionId).map((item): TranscriptMark => ({ id: item.id, mark: markOf(item) }))
      case 'cli.status':
        return this.mustCli().status()
      case 'cli.install':
        return this.mustCli().install()
      case 'cli.uninstall':
        return this.mustCli().uninstall()

      // ── Executable plans ──
      case 'plan.get':
      case 'plan.edit':
      case 'plan.approve':
      case 'plan.reject':
      case 'plan.choose':
      case 'plan.confirmUpdate':
      case 'plan.stop':
      case 'plan.templates':
      case 'plan.saveTemplate':
      case 'plan.deleteTemplate':
      case 'plan.useTemplate':
        return this.plans.handle(command)

      case 'projectGroups.create':
        return this.projectGroups.create(command.name, command.projectIds)
      case 'projectGroups.rename':
        return this.projectGroups.rename(command.groupId, command.name)
      case 'projectGroups.delete':
        return this.projectGroups.delete(command.groupId)
      case 'projectGroups.collapse':
        return this.projectGroups.collapse(command.groupId, command.collapsed)
      case 'projectGroups.reorder':
        return this.projectGroups.reorder(command.groupIds)
      case 'projectGroups.move':
        return this.projectGroups.move(command.projectId, command.groupId, command.index)

      // Files, diff and history.
      case 'fs.tree':
        return listTree(this.knownRoot(command.root))
      case 'fs.read':
        return readText(this.knownRoot(command.root), command.path, this.fileRoots.idFor(this.knownRoot(command.root)))
      // ── File media and reveal ──
      case 'fs.media': {
        const root = this.knownRoot(command.root)
        return mediaInfo(root, command.path, this.fileRoots.idFor(root), command.rev ?? null)
      }
      case 'fs.reveal': {
        const root = this.knownRoot(command.root)
        insideRoot(root, command.path)
        this.notify({ type: 'reveal-file', id: this.fileRoots.idFor(root), path: command.path })
        return null
      }
      // ── End of file media and reveal ──
      case 'fs.write':
        return writeText(this.knownRoot(command.root), command.path, command.text, command.baseMtime)
      case 'fs.watch': {
        const subs = this.fsSubs.get(origin) ?? new Map<string, number>()
        if (command.on) {
          const root = this.knownRoot(command.root)
          this.watcher.watch(root)
          subs.set(root, (subs.get(root) ?? 0) + 1)
          this.fsSubs.set(origin, subs)
        } else {
          // Only what this connection subscribed is removed.
          const root = command.root.replace(/\/+$/, '')
          const count = subs.get(root) ?? 0
          if (count > 0) {
            this.watcher.unwatch(root)
            if (count === 1) subs.delete(root)
            else subs.set(root, count - 1)
          }
        }
        return null
      }
      case 'diff.files':
        return diffFiles(this.db, this.knownRoot(command.root), command.scope)
      case 'diff.file':
        return diffFile(this.knownRoot(command.root), command.from, command.to, command.path, command.oldPath ?? null)
      case 'git.restore': {
        const root = this.knownRoot(command.root)
        const busy = this.busySession(root)
        if (busy) throw new Error(t('“{title}” is working in this folder: stop it before restoring.', { title: busy.title }))
        const sessionId = [...this.rows.values()].find((r) => this.cwdOf(r) === root && !r.archived && !r.parent)?.id ?? null
        const result = await restore(this.db, root, command.to, command.paths, command.label, sessionId)
        this.notifyFsChanged(root)
        return result
      }
      case 'history.list':
        return historyList(this.db, this.knownRoot(command.root), command.sessionId ?? null, this.rows)

      // Terminali.
      case 'terminal.create': {
        const project = this.mustProject(command.projectId)
        const row = command.sessionId ? this.rows.get(command.sessionId) : undefined
        const cwd = this.knownRoot(command.cwd ?? (row ? this.cwdOf(row) : project.path))
        return this.terminals.spawn({
          projectId: project.id,
          sessionId: command.sessionId ?? null,
          kind: 'shell',
          title: basename(process.env.SHELL || 'zsh'),
          cwd,
          command: null,
          port: this.ports.allocate(cwd)
        })
      }
      case 'terminal.attach':
        return { data: this.terminals.attach(command.id, command.cols, command.rows) }
      case 'terminal.input':
        this.terminals.input(command.id, command.data)
        return null
      case 'terminal.resize':
        this.terminals.resize(command.id, command.cols, command.rows)
        return null
      case 'terminal.close': {
        const terminal = this.terminals.get(command.id)
        if (terminal?.kind === 'agent') throw new Error(t('A session terminal closes when you archive the session.'))
        await this.terminals.close(command.id)
        return null
      }
      case 'terminal.restart':
        return this.restartTerminal(command.id)
      case 'terminal.clear':
        this.terminals.clear(command.id)
        return null
      case 'terminal.output':
        return this.terminals.output(command.id, command.lines ?? 200)

      // Scorciatoie.
      case 'shortcuts.get':
        return this.shortcuts.get()
      case 'shortcuts.save':
        return this.shortcuts.save(command.preset, command.overrides)
      case 'shortcuts.reset':
        return this.shortcuts.reset()
      case 'shortcuts.openFile':
        return this.shortcuts.openFile()

      // Project configuration and start actions.
      case 'project.settings':
        return loadProjectSettings(this.mustProject(command.projectId).path)
      case 'run.start':
        return this.startRun(command.projectId, command.sessionId ?? null, command.name)
      case 'project.worktree.set': {
        const project = this.mustProject(command.projectId)
        await saveWorktreeSettings(project.path, command.patch)
        // The personal file does not go in git.
        void ensureExcluded(project.path, PERSONAL_PATTERNS).catch(() => undefined)
        return loadProjectSettings(project.path)
      }
      case 'project.worktreeFiles': {
        const project = this.mustProject(command.projectId)
        return project.isGit ? worktreeIncludeFiles(project.path) : { source: 'default', patterns: [], files: [] }
      }

      // Dati.
      case 'data.info':
        return dataInfo(process.env.LADDER_DB_PATH ?? '')
      case 'data.backup':
        return backupDatabase(this.db, process.env.LADDER_DB_PATH ?? '', command.to)
      case 'data.openFolder':
        this.notify({ type: 'open-path', path: dirname(process.env.LADDER_DB_PATH ?? '') })
        return null

      // Search, issues, merge and prompts.
      case 'search':
        return searchItems(this.db, this.rows, command.query)
      case 'issues.list':
        return this.listIssues(command.projectId, command.source)
      case 'merge.info':
        return this.mergeInfo(this.knownRoot(command.root), command.fetch === true)
      case 'prompt.render':
        return renderPrompt(this.mustProject(command.projectId).path, command.name, command.vars)

      // ACP agents and review.
      case 'agents.add':
        return this.addAcpAgent(command.spec)
      case 'agents.catalog':
        return agentCatalog(this.catalogDeps())
      case 'agents.detect':
        return agentCatalog(this.catalogDeps(), true)
      case 'agents.install':
        return this.installer.start(command.id, command.version, command.confirmed, command.sha256, command.host)
      case 'agents.authenticate':
        return this.authenticateAcp(command.id, command.methodId, command.projectId)
      case 'agents.authenticate.cancel':
        this.cancelAuthenticate(command.id)
        return null
      case 'agents.others':
        return this.otherAgents.list()
      case 'agents.others.refresh':
        return this.otherAgents.refresh(command.id)
      case 'agents.others.login':
        return this.otherAgents.launch(command.id, 'login', command.projectId)
      case 'agents.others.logout':
        return this.otherAgents.launch(command.id, 'logout', command.projectId)
      case 'agents.install.cancel':
        this.installer.cancel(command.id)
        return null
      case 'agents.remove':
        await this.removeAcpAgent(command.id)
        return null
      case 'agents.usage':
        return this.refreshUsage(command.agent, command.profileId)
      case 'agents.defaults':
        return this.agentDefaults(command.agent, command.projectId, command.profileId)
      case 'profile.create':
        return this.createProfile(command.agent, command.name)
      case 'profile.rename': {
        const profile = this.profiles.rename(command.profileId, command.name)
        this.broadcast({ type: 'profile.upsert', profile })
        return profile
      }
      case 'profile.remove':
        this.removeProfile(command.profileId)
        return null
      case 'project.profile':
        return this.setProjectProfile(command.projectId, command.agent, command.profileId)
      case 'connection.list':
        return this.connections.list()
      case 'connection.refresh':
        return this.connections.refresh(command.id, command.profileId)
      case 'connection.login':
        return this.connections.login(command.id, command.switchAccount === true, command.profileId)
      case 'connection.cancel':
        this.connections.cancel(command.id, command.profileId)
        return null
      case 'connection.logout':
        return this.connections.logout(command.id, command.profileId)
      case 'text.commit':
        return this.writeCommit(command.sessionId, command.source)
      case 'text.pr':
        return this.writePr(command.sessionId)
      case 'git.commit': {
        const root = this.mustCwd(this.mustRow(command.sessionId))
        const result = await commitChanges(root, command.subject, command.body, command.paths)
        this.notifyFsChanged(root)
        return result
      }
      case 'git.status': {
        const row = this.mustRow(command.sessionId)
        return this.gitStatus.read(this.mustCwd(row))
      }
      // ── Branch map ──
      case 'project.branchMap':
        return this.branchMaps.read(this.mustProject(command.projectId).id)
      case 'project.branchMap.watch': {
        const projectId = this.mustProject(command.projectId).id
        const subs = this.branchMapSubs.get(origin) ?? new Map<string, number>()
        const count = subs.get(projectId) ?? 0
        if (command.on) {
          subs.set(projectId, count + 1)
          this.branchMapSubs.set(origin, subs)
          this.branchMaps.watch(projectId)
        } else if (count > 0) {
          // An `off` removes only a subscription of this window, never those of another.
          if (count === 1) subs.delete(projectId)
          else subs.set(projectId, count - 1)
          // With no subscriptions left the connection leaves the list (`touchBranchMapOf` stops at once on an empty list).
          if (subs.size === 0) this.branchMapSubs.delete(origin)
          this.branchMaps.unwatch(projectId)
        }
        return null
      }
      // ── End of branch map ──
      case 'project.branches':
        return this.projectBranches(command.projectId)
      case 'project.branch.switch':
        return this.changeBranch(command.projectId, (project, idle) => switchBranch(project.path, command.branch, { dirty: command.dirty, assertIdle: idle }))
      case 'project.branch.create':
        return this.changeBranch(command.projectId, (project, idle) => createBranch(project.path, command.name.trim(), { assertIdle: idle }))
      case 'git.watch': {
        if (command.on) this.subscribeGit(origin, command.sessionId, this.mustCwd(this.mustRow(command.sessionId)))
        else this.unsubscribeGit(command.sessionId, origin)
        return null
      }
      // ── Push, merge and archive ──
      case 'git.push.preview':
        return pushPreview(this.mustCwd(this.mustRow(command.sessionId)), { remote: command.remote })
      case 'git.push': {
        const root = this.mustCwd(this.mustRow(command.sessionId))
        try {
          return await pushBranch(root, { publish: command.publish === true, remote: command.remote, expectedHead: command.expectedHead }, () => this.busySession(root) !== null)
        } finally {
          // Whether it succeeded or was refused, chip and panel re-read at once.
          this.notifyFsChanged(root)
        }
      }
      case 'pr.merge': {
        const row = this.mustRow(command.sessionId)
        const root = this.mustCwd(row)
        const project = this.mustProject(row.project_id)
        const info = await repoInfo(root)
        if (!info.isGit) throw new Error(t('The folder is not a git repository.'))
        if (!info.branch) throw new Error(t('HEAD is detached: switch to a branch before merging.'))
        if (info.branch === (await this.defaultBranchOf(project))) throw new Error(t('This is the default branch: there is no pull request to merge.'))
        try {
          const result = await mergePullRequest(root, info.branch, { number: command.number, method: command.method, deleteBranch: command.deleteBranch === true, expectedHeadOid: command.expectedHeadOid }, () => this.busySession(root) !== null)
          // PR state re-read at once: the session and the panel show "merged" without waiting for the periodic round.
          const details = await prForBranch(root, info.branch).catch(() => null)
          if (details) this.storePr(root, info.branch, details)
          return { ...result, pr: details?.status ?? null }
        } catch (error) {
          // Also after an error (for example no reply from gh: GitHub may have merged) the PR state is re-read.
          const details = await prForBranch(root, info.branch).catch(() => null)
          if (details) this.storePr(root, info.branch, details)
          throw error
        } finally {
          this.notifyFsChanged(root)
        }
      }
      case 'git.archive':
        return this.archiveAfterMerge(command.sessionId)
      // ── End of push, merge and archive ──
      case 'pr.prepare': {
        const project = this.mustProject(command.projectId)
        this.mustRow(command.sessionId)
        const { titlePath, bodyPath } = await this.prFiles.prepare(command.sessionId, command.title, command.body)
        const prompt = await renderPrPrompt(project.path, { branch: command.branch, base: command.base, titlePath, bodyPath, title: command.title.trim(), body: command.body })
        return { prompt, titlePath, bodyPath }
      }
      case 'text.cancel':
        this.cancelWriting(command.sessionId)
        return null
      case 'review.start':
        return this.startReview(command.sessionId, command.agent, command.scope)
      case 'review.cancel':
        this.reviews.get(command.reviewId)?.cancel()
        return null
    }
  }

  private mustProject(projectId: string): Project {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(t('Project not found.'))
    return project
  }

  // ── CLI and MCP tools for sessions ──────────────────────────────────────────

  /** Project rules for whoever starts sessions (plans, MCP tools): allowed and available agents, maximum permission. */
  private async projectRules(projectId: string): Promise<{ allowed: AgentId[]; available: AgentId[]; permissionsMax: PermissionLevel | null }> {
    const settings = await loadProjectSettings(this.mustProject(projectId).path)
    return { allowed: settings.agents.allowed as AgentId[], available: [...this.agents.values()].filter((a) => a.available).map((a) => a.agent), permissionsMax: settings.agents.permissionsMax }
  }

  setCli(install: CliInstall): void {
    this.cliInstall = install
  }

  private mustCli(): CliInstall {
    if (!this.cliInstall) throw new Error(t('The command line tool is not available.'))
    return this.cliInstall
  }

  /**
   * `ladder_start_session`: a child session. It runs in the starter's folder (with its worktree, if any), or in a
   * new worktree with `worktree`. The first message is sent right away.
   */
  private async startAgentSession(spec: StartSpec): Promise<{ sessionId: string; cwd: string | null; branch: string | null }> {
    const caller = this.mustRow(spec.callerId)
    if (spec.worktree) {
      const created = await this.createSession({ type: 'session.create', projectId: spec.projectId, agent: spec.agent, text: spec.prompt, model: spec.model, effort: spec.effort, permission: spec.permission, worktree: true, ...(spec.title ? { title: spec.title } : {}) }, spec.origin)
      return { sessionId: created.id, cwd: created.cwd, branch: created.branch }
    }
    const id = this.createTaskSession(
      { projectId: spec.projectId, planId: '', taskId: '', title: spec.title ?? titleFrom(spec.prompt), agent: spec.agent, model: spec.model, effort: spec.effort, permission: spec.permission, cwd: this.cwdOf(caller), worktree: caller.worktree ? (JSON.parse(caller.worktree) as WorktreeInfo) : null },
      spec.origin
    )
    // Right after creation (same tick): until the message is sent, the session does not look idle to whoever waits on it.
    this.holdFirst(id)
    try {
      await this.send(id, spec.prompt)
    } finally {
      this.releaseFirst(id)
    }
    const row = this.mustRow(id)
    return { sessionId: id, cwd: this.cwdOf(row), branch: this.branchOf(row) }
  }

  /** From here until the first message is sent, the session does not look idle to whoever waits on it. */
  private holdFirst(sessionId: string): void {
    this.firstMessage.set(sessionId, (this.firstMessage.get(sessionId) ?? 0) + 1)
  }

  private releaseFirst(sessionId: string): void {
    const left = (this.firstMessage.get(sessionId) ?? 1) - 1
    if (left > 0) this.firstMessage.set(sessionId, left)
    else this.firstMessage.delete(sessionId)
    this.wakeWaiters(sessionId)
  }

  /** What `session.wait` answers right now; null if the session is still working. */
  private waitState(sessionId: string): SessionWaitResult | null {
    const row = this.mustRow(sessionId)
    return decideWait({
      sessionId,
      runState: row.run_state,
      waitingLabel: row.run_state === 'waiting' ? this.summary(sessionId).waitingLabel : null,
      planLabel: row.run_state === 'idle' ? (this.plans.waitingFor(sessionId)?.label ?? null) : null,
      busy: this.isBusyNow(sessionId) || (this.firstMessage.get(sessionId) ?? 0) > 0,
      background: (this.subagents.list(sessionId) ?? []).some((a) => a.status === 'running') || this.agentsWait.has(sessionId) || this.agentsIdle.has(sessionId),
      continueLabel: this.agentsRows.has(sessionId) ? t('Continue') : null,
      queued: (JSON.parse(row.queue) as QueuedMessage[]).length,
      items: () => this.loadItems(sessionId),
      seq: row.last_seq
    })
  }

  /** Pending `session.wait` calls, per session: they wake up on every session update (emitSummary). */
  private waiters = new Map<string, Set<() => void>>()

  private wakeWaiters(sessionId: string): void {
    for (const wake of [...(this.waiters.get(sessionId) ?? [])]) wake()
  }

  /**
   * `session.wait`: waits for the work to finish, for your reply, or for the timeout (default 10 minutes, maximum 60). It wakes up
   * on session updates (with a safety check every 2 seconds) and stops right away if `signal` fires
   * (the client closed the connection or cancelled the call).
   */
  private async waitSession(sessionId: string, timeoutMs: number | undefined, signal?: AbortSignal): Promise<SessionWaitResult> {
    this.mustRow(sessionId)
    const limit = Math.min(Math.max(timeoutMs ?? 10 * 60_000, 1000), 60 * 60_000)
    const deadline = Date.now() + limit
    for (;;) {
      if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
      const state = this.waitState(sessionId)
      if (state) return state
      if (Date.now() >= deadline || signal?.aborted) return { sessionId, status: 'timeout', text: null, error: null, waitingLabel: null, seq: this.mustRow(sessionId).last_seq }
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(sessionId) ?? new Set<() => void>()
        this.waiters.set(sessionId, set)
        const done = () => {
          clearTimeout(timer)
          set.delete(done)
          if (set.size === 0) this.waiters.delete(sessionId)
          signal?.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, Math.min(2000, Math.max(1, deadline - Date.now())))
        set.add(done)
        signal?.addEventListener('abort', done, { once: true })
      })
    }
  }

  // ── Executable plans ────────────────────────────────────────────────────────

  /** Session for a plan task, in the plan's folder (or its separate worktree). It sends nothing: the plan does. */
  private createTaskSession(spec: TaskSessionSpec, origin: SessionSummary['origin'] = null): string {
    const project = this.mustProject(spec.projectId)
    const now = Date.now()
    const profileId = this.profiles.resolve(spec.agent, project.id, undefined)
    const row: SessionRow = {
      id: randomUUID(),
      project_id: project.id,
      title: spec.title,
      agent: spec.agent,
      model: spec.model,
      effort: spec.effort,
      permission: spec.permission,
      created_at: now,
      updated_at: now,
      archived: 0,
      external_id: null,
      run_state: 'idle',
      last_seq: 0,
      last_activity_seq: 0,
      last_read_seq: 0,
      queue: '[]',
      context: null,
      mode: 'chat',
      command: null,
      cwd: spec.cwd,
      worktree: spec.worktree ? JSON.stringify(spec.worktree) : null,
      estimated: 0,
      agent_ref: null,
      activity_at: now,
      source: null,
      // The title is the task's title: no regeneration.
      title_source: 'user',
      profile_id: profileId,
      permission_next: null,
      merged_via: null,
      merged_at: null,
      handoff_from: null,
      handoff: null,
      parent: null,
      origin: origin ? JSON.stringify(origin) : null
    }
    this.insertSession(row)
    this.emitSummary(row.id)
    return row.id
  }

  /** The plan's folder: the main checkout, or a new worktree on the plan's branch. */
  private async planWorkspace(state: PlanState, kind: 'main' | 'worktree'): Promise<NonNullable<PlanState['workspace']>> {
    const project = this.mustProject(state.projectId)
    if (kind === 'worktree') {
      if (!project.isGit) throw new Error(t('A worktree requires a git repository.'))
      const info = await this.planWorktree(project, state.plan.goal, state.sessionId, null)
      return { kind: 'worktree', path: info.path, branch: info.branch, base: info.base }
    }
    return { kind: 'main', path: project.path, branch: project.branch, base: project.isGit ? await resolveCommit(project.path, 'HEAD') : null }
  }

  /** Separate worktree for a task that writes in parallel: it starts from the plan folder's checkpoint. */
  private async planSideWorktree(state: PlanState, task: PlanTask, from: string): Promise<{ path: string; branch: string }> {
    const info = await this.planWorktree(this.mustProject(state.projectId), task.title, state.sessionId, from)
    return { path: info.path, branch: info.branch }
  }

  /** A plan's worktree: copied files and setup script as for a session; `resetTo` moves it to a checkpoint. */
  private async planWorktree(project: Project, title: string, coordinatorId: string, resetTo: string | null): Promise<WorktreeInfo> {
    const settings = await loadProjectSettings(project.path)
    const created = await createWorktree(project, title, settings.worktree.copy, null, { dir: this.prefs.worktreesDir, branchPrefix: this.prefs.branchPrefix })
    await this.ports.reserve(created.info.path)
    void ensureExcluded(project.path, PERSONAL_PATTERNS).catch(() => undefined)
    if (resetTo) {
      // A worktree that cannot be moved to the checkpoint is useless: remove it right away, with its branch and port block.
      await git(created.info.path, ['reset', '--hard', resetTo]).catch(async (error) => {
        await this.dropPlanWorktree(project, created.info.path, created.info.branch)
        throw error
      })
    }
    if (settings.worktree.setup) this.noticeSetupFailed(coordinatorId, await this.runSetup(coordinatorId, project, created.info.path, settings.worktree.setup), true)
    return created.info
  }

  /** Removes a plan worktree (even if dirty) and its branch, and frees its ports. Does not throw. */
  private async dropPlanWorktree(project: Project, path: string, branch: string): Promise<void> {
    await this.stopServices(path).catch(() => undefined)
    await git(project.path, ['worktree', 'remove', '--force', path]).catch(() => undefined)
    if (branch) await git(project.path, ['branch', '-D', branch]).catch(() => undefined)
    this.ports.release(path)
  }

  /** Working folder of the session: the worktree if there is one, otherwise the project. */
  private cwdOf(row: SessionRow): string {
    return row.cwd ?? this.projects.get(row.project_id)?.path ?? ''
  }

  /** Working folder of the session, or an error if it no longer exists (project removed): with '' git would work in the host's current folder. */
  private mustCwd(row: SessionRow): string {
    const cwd = this.cwdOf(row)
    if (!cwd) throw new Error(t('Folder unknown to Ladder.'))
    return cwd
  }

  /** Only project and session folders: the UI cannot ask for files from other parts of the disk. */
  private knownRoot(root: string): string {
    const normalized = root.replace(/\/+$/, '')
    // '/' becomes '' and would match sessions with no folder.
    if (!normalized) throw new Error(t('Folder unknown to Ladder.'))
    for (const project of this.projects.values()) if (project.path === normalized) return normalized
    for (const row of this.rows.values()) if (this.cwdOf(row) === normalized) return normalized
    throw new Error(t('Folder unknown to Ladder.'))
  }

  /** Change in the folder: the UI re-reads tree and diff, and the header's git state updates at once. */
  private notifyFsChanged(root: string): void {
    this.broadcast({ type: 'fs.changed', root })
    this.gitStatus.refresh(root)
    this.touchBranchMapOf(root)
  }

  /** Non-archived session working in the project's main checkout (not in a worktree) with a turn, subagents or a wait in progress. */
  private mainCheckoutBusy(project: Project): SessionRow | null {
    for (const row of this.rows.values()) {
      if (row.archived || row.project_id !== project.id || row.worktree || this.cwdOf(row) !== project.path) continue
      const runtime = this.runtimes.get(row.id)
      if (this.isBusyNow(row.id) || row.run_state === 'running' || row.run_state === 'starting' || row.run_state === 'waiting' || (runtime && this.agentBusy(row.id, runtime))) return row
    }
    return null
  }

  /** Project's local branches for the branch menu and for a worktree's starting point. */
  private async projectBranches(projectId: string): Promise<ProjectBranches> {
    const project = this.mustProject(projectId)
    const busy = this.mainCheckoutBusy(project)
    const folder = join(worktreesRoot(this.prefs.worktreesDir), project.name)
    const home = homedir()
    const worktreesFolder = folder === home || folder.startsWith(home + sep) ? `~${folder.slice(home.length)}` : folder
    const empty: ProjectBranches = { projectId, current: null, branches: [], dirty: 0, busy: busy ? { sessionId: busy.id, title: busy.title } : null, worktreesFolder }
    if (!project.path || !project.isGit || !existsSync(project.path)) return empty
    const [{ current, branches }, dirty] = await Promise.all([listLocalBranches(project.path), dirtyCount(project.path).catch(() => 0)])
    return { ...empty, current, branches, dirty }
  }

  /**
   * Branch switch or creation in the main checkout. Refusal because of a working session is re-read inside the lock, right
   * before writing. Afterwards, the project, the main checkout's sessions, git state and the map update as for a change made elsewhere.
   */
  private async changeBranch(projectId: string, run: (project: Project, assertIdle: () => void) => Promise<BranchSwitchResult>): Promise<BranchSwitchResult> {
    const project = this.mustProject(projectId)
    if (!project.path || !project.isGit || !existsSync(project.path)) throw new Error(t('The project is not a git repository.'))
    if (this.switchingBranch.has(projectId)) throw new Error(t('The branch is already being changed in this project. Wait a moment.'))
    // From here no new turn starts in the main checkout (messages queue); those already running are seen by `assertIdle`.
    this.switchingBranch.add(projectId)
    const assertIdle = () => {
      const busy = this.mainCheckoutBusy(project)
      if (busy) throw new Error(t('“{title}” has an agent at work in the main checkout. Wait for it to finish or stop it, then change branch.', { title: busy.title }))
    }
    try {
      return await run(project, assertIdle)
    } finally {
      this.switchingBranch.delete(projectId)
      // Messages that arrived during the switch restart now, on the new branch.
      for (const row of this.rows.values()) if (row.project_id === projectId && !row.worktree && !row.archived) this.startFirstQueued(row.id)
      // Success or not, what is shown is re-read: git may have changed HEAD even before a late error.
      const info = await repoInfo(project.path).catch(() => null)
      if (info && this.projects.has(projectId)) {
        const current = this.mustProject(projectId)
        if (current.branch !== info.branch) {
          this.projects.set(projectId, { ...current, branch: info.branch })
          this.broadcast({ type: 'project.upsert', project: this.mustProject(projectId) })
          for (const row of this.rows.values()) if (row.project_id === projectId && !row.worktree && !row.archived) this.emitSummary(row.id)
        }
      }
      this.notifyFsChanged(project.path)
    }
  }

  /** The new map goes only to connections subscribed to that project. */
  private emitBranchMap(projectId: string, map: BranchMap): void {
    const event: HostEvent = { type: 'project.branchMap', projectId, map }
    if (!this.sendTo) return this.broadcast(event)
    for (const [origin, subs] of this.branchMapSubs) if (subs.has(projectId)) this.sendTo(origin, event)
  }

  /** The folder changed (file, commit, fetch): if a window is looking at its project's map, it re-reads. */
  private touchBranchMapOf(root: string): void {
    if (this.branchMapSubs.size === 0) return
    const row = [...this.rows.values()].find((r) => this.cwdOf(r) === root)
    const projectId = row?.project_id ?? [...this.projects.values()].find((p) => p.path === root)?.id
    // Only a change in the main checkout makes the count of its uncommitted files stale.
    if (projectId) this.branchMaps.touch(projectId, [...this.projects.values()].some((p) => p.id === projectId && p.path === root))
  }

  /** Rows and main branch for the branch map: host data and PR cache, no call to gh (not even for the base). */
  private async branchMapSource(projectId: string): Promise<BranchMapSource> {
    const project = this.mustProject(projectId)
    // With an empty path git would work in the host's current folder.
    if (!project.path) throw new Error(t('Folder unknown to Ladder.'))
    const usable = project.isGit && existsSync(project.path)
    // Base without network: if the Merge panel already resolved it (also with gh) that one applies, otherwise origin/HEAD, main or master.
    const base = usable ? await (this.defaultBranches.get(project.path) ?? defaultBranch(project.path, false)) : null
    const rows: BranchMapRow[] = []
    for (const row of this.rows.values()) {
      if (row.project_id !== projectId || !usable || row.parent) continue
      let worktree: WorktreeInfo | null = null
      try {
        worktree = row.worktree ? (JSON.parse(row.worktree) as WorktreeInfo) : null
      } catch {
        // Row with corrupted JSON: we do not know where it is or on which branch, so it does not enter the map (the others do).
        continue
      }
      const cwd = this.cwdOf(row)
      const branch = worktree ? (worktree.branch ?? null) : (project.branch ?? null)
      const pr = branch ? (this.prs.get(`${cwd}\0${branch}`) ?? null) : null
      const mergedAt = pr?.status.state === 'merged' ? (pr.status.mergedAt ?? null) : null
      rows.push({
        sessionId: row.id,
        title: row.title,
        agent: row.agent as BranchMapRow['agent'],
        run: row.run_state as BranchMapRow['run'],
        archived: row.archived === 1,
        activityAt: row.activity_at || row.updated_at,
        prState: pr?.status.state ?? null,
        isWorktree: worktree !== null,
        worktreeMissing: worktree !== null && !existsSync(cwd),
        cwd,
        branch,
        start: worktree?.base ?? null,
        // As in refreshPrs: a merged PR from before the session was created belongs to an earlier branch with the same name (mergedAt counts, not updatedAt).
        prMerged: mergedAt !== null && mergedAt >= row.created_at ? { at: mergedAt, oid: pr?.headOid ?? null } : null,
        saved: row.merged_via === 'git' || row.merged_via === 'pr' ? { via: row.merged_via, at: row.merged_at } : null
      })
    }
    return { root: project.path, base, rows }
  }

  /** Subscribes the connection to git updates of the session's folder (once per connection and session). */
  private subscribeGit(origin: object, sessionId: string, root: string): void {
    const subs = this.gitSubs.get(origin) ?? new Map<string, string>()
    if (subs.has(sessionId) || !root) return
    subs.set(sessionId, root)
    this.gitSubs.set(origin, subs)
    this.watcher.watch(root)
    this.gitStatus.track(root)
  }

  /** Removes a connection's subscription; without `origin` (archived session, removed project) those of all connections. */
  private unsubscribeGit(sessionId: string, origin?: object): void {
    for (const [conn, subs] of this.gitSubs) {
      if (origin && conn !== origin) continue
      const root = subs.get(sessionId)
      if (!root) continue
      subs.delete(sessionId)
      this.watcher.unwatch(root)
      this.gitStatus.untrack(root)
    }
  }

  /** A connection (window) has closed: its git and file subscriptions go with it. */
  connectionClosed(origin: object): void {
    const git = this.gitSubs.get(origin)
    this.gitSubs.delete(origin)
    for (const root of git?.values() ?? []) {
      this.watcher.unwatch(root)
      this.gitStatus.untrack(root)
    }
    const maps = this.branchMapSubs.get(origin)
    this.branchMapSubs.delete(origin)
    for (const [projectId, count] of maps ?? []) for (let i = 0; i < count; i++) this.branchMaps.unwatch(projectId)
    const files = this.fsSubs.get(origin)
    this.fsSubs.delete(origin)
    for (const [root, count] of files ?? []) for (let i = 0; i < count; i++) this.watcher.unwatch(root)
  }

  /** Active subscriptions (for tests): git and fs. */
  subscriptionCount(): { git: number; fs: number } {
    let git = 0
    let fs = 0
    for (const subs of this.gitSubs.values()) git += subs.size
    for (const subs of this.fsSubs.values()) for (const n of subs.values()) fs += n
    return { git, fs }
  }

  /** A session that is writing in `root`, if any. */
  private busySession(root: string): SessionRow | null {
    for (const row of this.rows.values()) {
      // Advice (advisor) sessions are read-only: they do not block a restore.
      if (row.archived || ['advisor', 'review'].includes(this.parentOf(row)?.role ?? '') || this.cwdOf(row) !== root) continue
      if (this.runtimes.get(row.id)?.adapter.isRunning || row.run_state === 'running' || row.run_state === 'waiting') return row
    }
    return null
  }

  private createProfile(agent: ProfileAgent, name: string): Profile {
    const profile = this.profiles.create(agent, name)
    // Empty state at once (no account until login): the UI already has the row to show.
    this.broadcast({ type: 'agent.status', status: this.profileStatus(profile) })
    this.broadcast({ type: 'profile.upsert', profile })
    return profile
  }

  /**
   * Removes a profile. It refuses while an active session uses it; idle sessions move to the default (their process
   * closes: the next message restarts without the profile folder). The config folder stays: it holds the credentials.
   */
  private removeProfile(profileId: string): void {
    const profile = this.profiles.mustGet(profileId)
    if (profile.isDefault) throw new Error(t('The default account cannot be removed.'))
    // Archived ones too: they hold a profile that no longer exists.
    const users = [...this.rows.values()].filter((r) => r.profile_id === profileId)
    const active = users.some((r) => !r.archived && (this.isBusy(r.id) || r.run_state === 'running' || r.run_state === 'starting'))
    if (active) throw new Error(t('A session is using this account. Wait for it to finish, then try again.'))
    // A live terminal (even a TUI idle at the prompt, run_state idle) has the profile folder in its environment.
    if (users.some((r) => this.terminals.bySession(r.id, 'agent').some((term) => term.state === 'running'))) {
      throw new Error(t('A terminal is using this account. Close it, then try again.'))
    }
    this.connections.forget(profileId)
    this.profiles.remove(profileId)
    this.profileAgents.delete(profileId)
    this.db.prepare('delete from kv where key = ?').run(`agent:${profile.agent}:${profileId}`)
    for (const row of users) {
      // Revocation first: it releases the agent browser's confirmations still open, while the runtime can find them.
      this.revokeTools(row.id)
      this.runtimes.get(row.id)?.adapter.close()
      this.runtimes.delete(row.id)
      // The conversation lives in the profile folder: with the default, resume would not find it, so a new one starts.
      // The transcript in Ladder stays.
      // For terminals the conversation to resume is agent_ref.
      this.updateRow(row.id, { profile_id: null, external_id: null, ...(row.mode === 'terminal' ? { agent_ref: null } : {}) })
      if (!row.archived) this.emitSummary(row.id)
    }
    // Projects that had chosen it go back to the default too.
    for (const project of this.projects.values()) {
      if (!Object.values(project.profiles ?? {}).includes(profileId)) continue
      this.refreshProject(project.id)
    }
    this.broadcast({ type: 'profile.removed', profileId })
  }

  /** The profile a project uses to start new sessions of an agent; existing sessions keep theirs. */
  private setProjectProfile(projectId: string, agent: ProfileAgent, profileId: string | null): Project {
    this.mustProject(projectId)
    this.profiles.setForProject(projectId, agent, profileId)
    return this.refreshProject(projectId)
  }

  private refreshProject(projectId: string): Project {
    const { profiles: _old, ...rest } = this.mustProject(projectId)
    const profiles = this.profiles.forProject(projectId)
    const project: Project = { ...rest, ...(profiles ? { profiles } : {}) }
    this.projects.set(projectId, project)
    this.broadcast({ type: 'project.upsert', project })
    return project
  }

  private async addProject(path: string): Promise<Project> {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(t('The folder does not exist.'))
    const existing = [...this.projects.values()].find((p) => p.path === path)
    if (existing) return existing
    const row: ProjectRow = { id: randomUUID(), name: basename(path), path, added_at: Date.now() }
    this.db.prepare('insert into projects (id, name, path, added_at) values (?, ?, ?, ?)').run(row.id, row.name, row.path, row.added_at)
    const project = await this.projectFromRow(row)
    this.projects.set(project.id, project)
    this.ports.allocate(project.path)
    // Ladder's personal files stay out of git, without touching the project's .gitignore.
    if (project.isGit) void ensureExcluded(project.path, PERSONAL_PATTERNS).catch(() => undefined)
    this.broadcast({ type: 'project.upsert', project })
    this.projectGroups.sync()
    return project
  }

  private async createSession(command: Extract<HostCommand, { type: 'session.create' }>, origin: SessionSummary['origin'] = null): Promise<SessionSummary> {
    const project = this.mustProject(command.projectId)
    const mode = command.mode ?? 'chat'
    const now = Date.now()
    const shellCommand = mode === 'terminal' ? (command.command?.trim() || 'claude') : null
    const title = command.title?.trim() || (mode === 'terminal' && !command.text.trim() ? shellCommand! : titleFrom(command.text))

    // Worktree: new folder and branch, files to copy, then the setup script before starting.
    let worktree: WorktreeInfo | null = null
    const settings = await loadProjectSettings(project.path)
    // Project rules ([agents] in .ladder/settings.toml): allowed agents and maximum permission level.
    if (mode === 'chat') this.assertHandoffAgent(settings, command.agent)
    // Session profile (account): chosen here, then it never changes (not even on resume).
    // A terminal session has agent 'claude-code' for the UI: the profile is that of the command's program.
    const programAgent = mode === 'terminal' ? terminalAgent(shellCommand) : command.agent
    const requested = mode === 'terminal' && command.profileId && !isDefaultProfileId(command.profileId) && this.profiles.get(command.profileId)?.agent !== programAgent ? null : command.profileId
    const profileId = this.profiles.resolve(programAgent, project.id, requested)
    command = { ...command, permission: clampPermission(command.permission, settings.agents.permissionsMax) }
    const notices: string[] = []
    // An existing branch already checked out in the main checkout cannot have a worktree: work happens there.
    let wanted: WorktreeBranch | null = command.branch ?? null
    // Name chosen in the new chat: used as is. A branch that already exists is not silently reused (`wanted` would treat it as "existing").
    const chosenName = !wanted && command.worktree && typeof command.newBranch === 'string' ? command.newBranch.trim() : ''
    if (chosenName) {
      if (!validBranchName(chosenName)) throw new Error(t('“{name}” is not a valid branch name: use letters, digits and . _ / @ + -, and no spaces.', { name: chosenName }))
      if (await resolveCommit(project.path, `refs/heads/${chosenName}`)) throw new Error(t('A branch named “{name}” already exists.', { name: chosenName }))
      wanted = { name: chosenName, existing: false }
    }
    const startFrom = !command.branch && command.worktree && typeof command.baseBranch === 'string' ? command.baseBranch.trim() : ''
    const useWorktree = Boolean(command.worktree) && !(wanted?.existing && wanted.name === project.branch)
    if (!useWorktree && this.switchingBranch.has(project.id)) throw new Error(t('The branch of the main checkout is being changed. Try again in a moment.'))
    if (command.worktree && !useWorktree) notices.push(t('Branch {branch} is already checked out in the main checkout: the session works there.', { branch: wanted!.name }))
    if (useWorktree) {
      if (!project.isGit) throw new Error(t('A worktree requires a git repository.'))
      // The branch is not renamed after creation: if the message cites an issue, its identifier goes into the name.
      // The name suggested by Linear needs its API with the user's credentials: not used.
      const ref = wanted ? null : issueRef(command.text, this.teamsOf(project.id))
      // With no issue cited and generated titles on, the small model proposes the branch name (short timeout: it falls back to the title).
      const named = !wanted && !ref && mode === 'chat' ? await this.branchName(project.id, command.agent, profileId, command.text) : null
      const created = await createWorktree(project, withIssue(named ?? title, ref, ' '), settings.worktree.copy, wanted, { dir: this.prefs.worktreesDir, branchPrefix: this.prefs.branchPrefix, startFrom: startFrom || undefined, strictName: Boolean(chosenName) })
      worktree = created.info
      // The port slot is chosen now, skipping blocks whose base is taken by someone else.
      await this.ports.reserve(worktree.path)
      void ensureExcluded(project.path, PERSONAL_PATTERNS).catch(() => undefined)
      if (created.missing.length) notices.push(t('Files to copy that were not found in the project: {files}.', { files: created.missing.join(', ') }))
    }

    const row: SessionRow = {
      id: randomUUID(),
      project_id: project.id,
      title,
      agent: command.agent,
      model: command.model,
      effort: command.effort,
      permission: command.permission,
      created_at: now,
      updated_at: now,
      archived: 0,
      external_id: null,
      run_state: 'idle',
      last_seq: 0,
      last_activity_seq: 0,
      last_read_seq: 0,
      queue: '[]',
      context: null,
      mode,
      command: shellCommand,
      cwd: worktree?.path ?? project.path,
      worktree: worktree ? JSON.stringify(worktree) : null,
      estimated: 0,
      agent_ref: null,
      activity_at: now,
      source: command.source ? JSON.stringify(command.source) : null,
      // A title given at creation is a user choice.
      title_source: command.title?.trim() ? 'user' : 'provisional',
      profile_id: profileId,
      permission_next: null,
      merged_via: null,
      merged_at: null,
      handoff_from: null,
      handoff: null,
      parent: null,
      origin: origin ? JSON.stringify(origin) : null
    }
    this.insertSession(row)
    // Until the first message is sent, whoever waits on this session does not see it idle.
    this.holdFirst(row.id)
    const beginHeld = async () => {
      try {
        await begin()
      } finally {
        this.releaseFirst(row.id)
      }
    }
    for (const text of notices) this.upsertItem(row.id, { kind: 'notice', id: randomUUID(), turnId: 'system', at: now, tone: 'info', text })

    const begin = async () => {
      if (mode === 'terminal') this.startTerminalAgent(row.id, command.text.trim() || null)
      else await this.send(row.id, command.text, command.attachments ?? [])
    }

    if (worktree && settings.worktree.setup && (command.setupWait ?? settings.worktree.setupWait) === false) {
      // The session starts at once; the script runs in parallel in the "setup" terminal and an exit with an error is reported.
      this.emitSummary(row.id)
      void this.runSetup(row.id, project, worktree.path, settings.worktree.setup).then((code) => {
        // Archived during setup: the exit is due to the terminal closing, no notes.
        if (this.isGone(row.id)) return
        this.noticeSetupFailed(row.id, code, false)
        return this.startServices(row.id, project, worktree.path, settings.worktree, code)
      })
      await beginHeld()
    } else if (worktree && settings.worktree.setup) {
      // The first message waits in the queue for setup to finish; meanwhile the session is "running".
      this.preparing.add(row.id)
      if (mode === 'chat') {
        const queued: QueuedMessage = { id: randomUUID(), text: command.text, ...(command.attachments?.length ? { attachments: command.attachments } : {}) }
        this.updateRow(row.id, { queue: JSON.stringify([queued]) })
      }
      this.updateRow(row.id, { run_state: 'running' })
      this.termStatus.set(row.id, { label: null, activity: t('Preparing the worktree…'), turn: null, waitingSince: null })
      this.emitSummary(row.id)
      void this.runSetup(row.id, project, worktree.path, settings.worktree.setup).then(async (code) => {
        // The first message is sent (or given up) before the waiter sees the session idle: the hold is released at the end.
        try {
          this.preparing.delete(row.id)
          this.termStatus.delete(row.id)
          // Archived during setup: no notes, services or queued message. If archiving has not finished
          // (or failed), the setup's "in progress" state must not linger.
          if (this.isGone(row.id)) {
            if (this.rows.get(row.id)?.run_state === 'running') this.updateRow(row.id, { run_state: 'idle' })
            return
          }
          this.updateRow(row.id, { run_state: 'idle' })
          this.noticeSetupFailed(row.id, code, true)
          await this.startServices(row.id, project, worktree.path, settings.worktree, code)
          // Archived while the services were starting: archive() awaits the same promise and resumes before us.
          if (this.isGone(row.id)) return
          if (mode === 'chat') {
            const queue = JSON.parse(this.mustRow(row.id).queue) as QueuedMessage[]
            const next = queue.shift()
            this.updateRow(row.id, { queue: JSON.stringify(queue) })
            this.emitSummary(row.id)
            if (next) await this.startTurn(row.id, next.text, next.attachments ?? []).catch((e: Error) => this.noticeError(row.id, e.message))
          } else {
            this.emitSummary(row.id)
            await begin()
          }
        } finally {
          this.releaseFirst(row.id)
        }
      })
    } else {
      this.emitSummary(row.id)
      // Without setup the services start at once.
      if (worktree) void this.startServices(row.id, project, worktree.path, settings.worktree, 0)
      await beginHeld()
    }
    return this.summary(row.id)
  }

  /**
   * Starts the worktree's services (`[[worktree.services]]`), each in a `service` terminal. `setupCode`: exit code of the setup script
   * (0 if there is none); if it failed the services do not start. A service with `port` gets LADDER_PORT: the first free port in the worktree's block
   * (trial bind), so two worktrees of the same project do not collide. Never throws: a problem becomes a note in the session.
   */
  private startServices(sessionId: string, project: Project, cwd: string, config: ProjectSettings['worktree'], setupCode: number | null): Promise<void> {
    const run = this.runServices(sessionId, project, cwd, config, setupCode)
    // The promise is kept per session: archive() waits for it before stopping services, so none starts afterwards.
    this.servicesStarting.set(sessionId, run)
    void run.then(() => {
      if (this.servicesStarting.get(sessionId) === run) this.servicesStarting.delete(sessionId)
    })
    return run
  }

  /** Archived or being archived session: no more services or setup notes start. */
  private isGone(sessionId: string): boolean {
    return this.rows.get(sessionId)?.archived !== 0 || this.archiving.has(sessionId)
  }

  private async runServices(sessionId: string, project: Project, cwd: string, config: ProjectSettings['worktree'], setupCode: number | null): Promise<void> {
    // Disabled services (`disabled`) stay in the list but do not start.
    const services = config.services.filter((s) => !s.disabled && s.command.trim())
    if (!services.length) return
    const noticeError = (text: string) => {
      this.upsertItem(sessionId, { kind: 'notice', id: randomUUID(), turnId: 'system', at: Date.now(), tone: 'error', text })
      this.flush()
    }
    try {
      if (this.isGone(sessionId)) return
      if (setupCode !== 0) return noticeError(t('The worktree services were not started because the setup script failed.'))
      // The base stays for setup, shell and [[run]]: services start from base + 1, so a `[[run]] dev --port $LADDER_PORT` does not collide with them.
      const base = this.ports.allocate(cwd) + 1
      const count = config.ports - 1
      const taken = new Set<number>()
      if (count < 1 && services.some((s) => s.port)) noticeError(t('The services with a port were not started: worktree.ports must be at least 2 (the first port is kept for setup and [[run]] actions).'))
      for (const service of services) {
        // The session may have been archived while waiting for setup.
        if (this.isGone(sessionId)) return
        let port: number | null = null
        if (service.port) {
          if (count < 1) continue
          port = await freePort(base, count, taken)
          if (port === null) {
            noticeError(t('No free port for the service “{name}”: the worktree has {count} ports from {base}.', { name: service.name, count, base }))
            continue
          }
          taken.add(port)
          // freePort is asynchronous: archival may have arrived in the meantime.
          if (this.isGone(sessionId)) return
        }
        this.terminals.spawn({ projectId: project.id, sessionId, kind: 'service', title: service.name, cwd, command: service.command, port })
      }
    } catch (error) {
      noticeError(t('Could not start the worktree services: {message}', { message: error instanceof Error ? error.message : String(error) }))
    }
  }

  /**
   * When restarting a service (already stopped by restartTerminal) its port may have been taken by others: if it is free it stays, otherwise another from the block is assigned
   * (from base + 1, excluding those of the worktree's other services). No change for other terminals.
   */
  private async servicePort(id: string): Promise<Partial<SpawnOptions>> {
    const term = this.terminals.get(id)
    if (!term || term.kind !== 'service' || term.port === null) return {}
    const others = new Set(this.terminals.list().filter((o) => o.id !== id && o.kind === 'service' && o.cwd === term.cwd && o.port !== null).map((o) => o.port as number))
    if (!others.has(term.port) && (await portIsFree(term.port))) return {}
    const project = this.mustProject(term.projectId)
    const count = (await loadProjectSettings(project.path)).worktree.ports - 1
    const port = await freePort(this.ports.allocate(term.cwd) + 1, count, others)
    if (port === null) throw new Error(t('No free port for the service “{name}”: the worktree has {count} ports from {base}.', { name: term.title, count, base: this.ports.allocate(term.cwd) + 1 }))
    return { port }
  }

  /**
   * Restart of a terminal. A running service really stops (processes exited, port free) before starting again; an archived
   * or being-archived session does not restart, even if archival arrives while waiting for the stop.
   */
  private async restartTerminal(id: string): Promise<TerminalInfo> {
    // The sessionId is read once: if archival closes the terminal while waiting, the error stays "archived".
    const sessionId = this.terminals.get(id)?.sessionId
    const gone = () => !!sessionId && this.isGone(sessionId)
    if (gone()) throw new Error(t('The session is archived.'))
    if (this.restarting.has(id)) throw new Error(t('The terminal is already restarting.'))
    this.restarting.add(id)
    try {
      if (this.terminals.get(id)?.kind === 'service') await this.terminals.stop(id)
      const patch = await this.servicePort(id)
      if (gone()) throw new Error(t('The session is archived.'))
      return this.terminals.restart(id, patch)
    } finally {
      this.restarting.delete(id)
    }
  }

  /** Stops a worktree's services and waits for their processes to exit (ports free). Terminals stay: whoever archives closes them. */
  private async stopServices(cwd: string): Promise<void> {
    // Even after the shell has exited: a `cmd &` left in the background holds the port, and its process group is still alive.
    const alive = this.terminals.list().filter((term) => term.kind === 'service' && term.cwd === cwd && (term.state === 'running' || this.terminals.isAlive(term.id)))
    await Promise.all(alive.map((term) => this.terminals.stop(term.id)))
  }

  /** The setup script exited with an error: a note in the session. `waited`: the session was starting after it. */
  private noticeSetupFailed(sessionId: string, code: number | null, waited: boolean): void {
    if (code === 0) return
    const tail = waited ? t('The session starts anyway.') : t('The session had already started.')
    this.upsertItem(sessionId, {
      kind: 'notice',
      id: randomUUID(),
      turnId: 'system',
      at: Date.now(),
      tone: 'error',
      text:
        code === null
          ? t('The worktree setup script exited without a code: check the “setup” terminal. {tail}', { tail })
          : t('The worktree setup script exited with code {code}: check the “setup” terminal. {tail}', { code, tail })
    })
    this.flush()
  }

  private runSetup(sessionId: string, project: Project, cwd: string, setup: string): Promise<number | null> {
    const terminal = this.terminals.spawn({
      projectId: project.id,
      sessionId,
      kind: 'run',
      title: 'setup',
      cwd,
      command: setup,
      port: this.ports.allocate(cwd)
    })
    return this.terminals.onceExit(terminal.id)
  }

  /**
   * Archives sessions idle for `autoArchiveDays` days: with no turn, requests, queue, setup or terminal in progress (services, always on, do not count: archive() stops them).
   * It runs at startup, on every preference change and every hour.
   */
  private async autoArchive(): Promise<void> {
    if (this.archiveTimer) clearTimeout(this.archiveTimer)
    this.archiveTimer = this.stopped ? null : setTimeout(() => void this.autoArchive(), AUTO_ARCHIVE_EVERY_MS)
    const days = this.prefs.autoArchiveDays
    if (!days || this.stopped) return
    const limit = Date.now() - days * 86_400_000
    const archived: string[] = []
    for (const row of [...this.rows.values()]) {
      // Child sessions do not count on their own: they are archived with the parent.
      if (row.archived || row.parent || (row.run_state !== 'idle' && row.run_state !== 'error') || this.preparing.has(row.id)) continue
      if (Math.max(row.activity_at, row.updated_at, row.created_at) > limit) continue
      if (row.queue !== '[]' || this.isBusy(row.id) || this.terminals.bySession(row.id).some((term) => term.state === 'running' && term.kind !== 'service')) continue
      try {
        await this.archive(row.id)
        archived.push(row.id)
      } catch {
        // A session that fails to archive does not stop the others; it is retried next round.
      }
    }
    if (archived.length) this.broadcast({ type: 'sessions.autoArchived', sessionIds: archived })
  }

  /**
   * Agent restart (for example after adding an MCP server): the conversation stays on disk and the next turn
   * resumes it (resume) with a new process. It interrupts nothing: with a turn or subagents working it waits for the end.
   * Only the "for this session" approvals given in the old process are lost: the agent will ask for them again.
   */
  private restartAgent(sessionId: string): void {
    const row = this.mustRow(sessionId)
    if (this.isGone(sessionId)) return
    if (row.mode === 'terminal') throw new Error(t('Terminal sessions restart from their terminal.'))
    // Only agents that resume the conversation from a new process: the others would start from scratch.
    if (!RESTARTABLE_AGENTS.has(row.agent)) throw new Error(t('This agent can’t continue the conversation after a restart.'))
    const runtime = this.runtimes.get(sessionId)
    if (runtime && this.agentBusy(sessionId, runtime)) {
      if (this.restartAfterTurn.has(sessionId)) return
      this.restartAfterTurn.add(sessionId)
      const turn = runtime.adapter.isRunning || runtime.turnId !== null
      this.noticeInfo(
        sessionId,
        turn
          ? t('The agent restarts when the current turn ends. Stop the turn to restart it sooner.')
          : t('The agent restarts when its background work ends, so nothing running in the background gets lost.')
      )
      return
    }
    this.restartAfterTurn.delete(sessionId)
    if (runtime) this.closeRuntime(sessionId)
    this.noticeInfo(sessionId, t('Agent restarted. The next message continues the conversation with settings and MCP servers loaded again.'))
    this.emitSummary(sessionId)
  }

  /**
   * The process is still needed: turn open or closing, subagents or background commands alive,
   * or a subagent just finished whose result the agent has not received yet (implicit turn coming).
   * ownClosing: turn endings not to count (from onTurnEnd, its own).
   */
  private agentBusy(sessionId: string, runtime: Runtime, ownClosing = 0): boolean {
    return (
      runtime.adapter.isRunning ||
      runtime.turnId !== null ||
      runtime.closing > ownClosing ||
      runtime.adapter.hasBackgroundWork === true ||
      this.subagents.hasRunning(sessionId) ||
      this.agentsIdle.has(sessionId) ||
      this.agentsWait.has(sessionId)
    )
  }

  /** When a session's process closes, the MCP server tokens (agent browser and Ladder) stop being valid: releases pending confirmations, delegations and waits. */
  private revokeTools(sessionId: string): void {
    this.browserAgent.revoke(sessionId)
    this.ladderMcp.revoke(sessionId)
  }

  /** Closes the agent process without touching the session: like archival, the agent browser's revocation comes first. */
  private closeRuntime(sessionId: string): void {
    this.revokeTools(sessionId)
    this.runtimes.get(sessionId)?.adapter.close()
    this.runtimes.delete(sessionId)
    this.agentsIdle.delete(sessionId)
  }

  private noticeInfo(sessionId: string, text: string): void {
    this.upsertItem(sessionId, { kind: 'notice', id: randomUUID(), turnId: 'system', at: Date.now(), tone: 'info', text })
    this.flush()
  }

  /** `cleanup: false` when the caller removes the worktree: the cleanup script starts from removeWorktree. */
  private async archive(sessionId: string, options: { cleanup?: boolean } = {}): Promise<void> {
    // Double click, automatic archival and merged PR: whoever arrives later waits for the same archival, the cleanup script runs only once.
    const running = this.archiveRuns.get(sessionId)
    if (running) return running
    const row = this.mustRow(sessionId)
    if (row.archived) return
    const run = this.runArchive(sessionId, row, options)
    this.archiveRuns.set(sessionId, run)
    try {
      await run
    } finally {
      this.archiveRuns.delete(sessionId)
    }
  }

  private async runArchive(sessionId: string, row: SessionRow, options: { cleanup?: boolean }): Promise<void> {
    // From here the session is "archiving": send, turn starts, restarts and new services are refused (even a concurrent session.advise).
    this.archiving.add(sessionId)
    // Project and cleanup script are read now, before any wait: project.remove may remove the project while services stop.
    let project: Project | undefined
    let script: string | null = null
    // Child with its own worktree (delegate with worktree: true): at the end of archiving the worktree is removed if clean.
    const childWorktree = !!row.parent && this.ownsWorktree(row)
    try {
      // Child sessions (advice, delegations) are archived with the parent, before it.
      for (const child of [...this.rows.values()]) if (!child.archived && this.parentOf(child)?.sessionId === sessionId) await this.archive(child.id).catch(() => undefined)
      // The cleanup script closes the worktree: it does not run if another live session uses the same folder.
      if (this.ownsWorktree(row) && options.cleanup !== false && !this.worktreeHeir(row) && !this.plans.usesFolder(this.cwdOf(row))) {
        project = this.projects.get(row.project_id)
        script = project ? (await loadProjectSettings(project.path)).worktree.archive : null
      }
      await this.archiveSession(sessionId, row)
    } finally {
      this.archiving.delete(sessionId)
    }
    this.emitSummary(sessionId)
    this.attention({ kind: 'resolved', sessionId, itemId: null })
    // Worktree close command (for example docker compose down), in-process and with a timeout. The worktree stays: archiveMerged removes it.
    let cleanupOk = true
    if (project && script) {
      const cwd = this.cwdOf(row)
      if (existsSync(cwd)) {
        const result = await runCleanupScript(cwd, script, this.ports.allocate(cwd))
        cleanupOk = result.code === 0 && !result.timedOut
        this.noticeCleanup(sessionId, result)
      }
    }
    if (childWorktree) await this.removeChildWorktree(row, cleanupOk)
  }

  /**
   * Archived child with its own worktree: if clean it is removed and the ports are freed; if it has uncommitted files (or git
   * refuses) it stays, and a note in the parent says where the work is (the branch always stays).
   */
  private async removeChildWorktree(row: SessionRow, cleanupOk: boolean): Promise<void> {
    const project = this.projects.get(row.project_id)
    const parent = this.parentOf(row)
    if (!project || !row.worktree) return
    const cwd = this.cwdOf(row)
    const branch = (JSON.parse(row.worktree) as WorktreeInfo).branch
    // The cleanup script (if any) already ran in runArchive.
    const { removed, error } = await removeWorktree(project, cwd, { skipCleanup: true })
    if (removed && cleanupOk) this.ports.release(cwd)
    if (removed || !parent || !this.rows.has(parent.sessionId)) return
    const dirty = existsSync(cwd) ? ((await gitStatus(cwd, true, false).catch(() => null))?.dirty ?? 0) > 0 : false
    this.upsertItem(parent.sessionId, {
      kind: 'notice',
      id: randomUUID(),
      turnId: 'system',
      at: Date.now(),
      tone: 'info',
      text: dirty
        ? t('The worktree of the delegate “{title}” was kept because it has uncommitted files. Its work is on branch {branch}.', { title: row.title, branch })
        : t('Git could not remove the worktree of the delegate “{title}”: {reason} Its work is on branch {branch}.', { title: row.title, reason: error ?? t('the folder no longer exists'), branch })
    })
    this.flush()
  }

  private async archiveSession(sessionId: string, row: SessionRow): Promise<void> {
    this.restartAfterTurn.delete(sessionId)
    // A child archived mid-work: the parent's row does not stay 'running'.
    this.settleAdvice(sessionId, { state: 'stopped', error: null })
    this.finishDelegation(sessionId, 'stopped', null, '')
    this.delegateCounts.delete(sessionId)
    this.delegateHints.delete(sessionId)
    this.reviewForwards.delete(sessionId)
    this.reviewQueued.delete(sessionId)
    for (const key of [...this.limitSeen.keys()]) if (key.startsWith(`${sessionId}\0`)) this.limitSeen.delete(key)
    for (const key of [...this.reviewForwarded]) if (key.startsWith(`${sessionId}\0`)) this.reviewForwarded.delete(key)
    // A plan task's turn will never finish (events from the closed adapter are ignored): the plan learns of it immediately.
    await this.plans.sessionGone(sessionId).catch(() => undefined)
    // Revocation first releases the agent browser's confirmations still open (expireRequest needs the runtime).
    this.revokeTools(sessionId)
    const closing = this.runtimes.get(sessionId)
    if (closing?.handoff) {
      const run = closing.handoff
      closing.handoff = null
      this.failHandoff(sessionId, run, 'interrupted', t('The handoff was interrupted.'))
    }
    this.runtimes.get(sessionId)?.adapter.close()
    this.runtimes.delete(sessionId)
    this.unsubscribeGit(sessionId)
    this.initEffort.delete(sessionId)
    this.commandLists.delete(sessionId)
    this.contextAt.delete(sessionId)
    this.subagents.forget(sessionId)
    void this.prFiles.forget(sessionId)
    this.agentsNotices.delete(sessionId)
    this.agentsPending.delete(sessionId)
    this.agentsBeforeTurn.delete(sessionId)
    this.agentsIdle.delete(sessionId)
    this.agentsRows.delete(sessionId)
    clearTimeout(this.agentsWait.get(sessionId))
    this.agentsWait.delete(sessionId)
    this.broadcast({ type: 'session.subagents', sessionId, subagents: [] })
    // First wait for any pending service start (which from now on does not spawn), then the worktree's services really stop
    // and free their ports, then all terminals close (services with a wait).
    await this.servicesStarting.get(sessionId)
    // Folder also used by another live session (linked sessions): services do not stop, they pass to that session.
    const heir = this.worktreeHeir(row)
    // A child does not own the folder's services: archiving it does not stop them.
    if (!heir && !this.plans.usesFolder(this.cwdOf(row)) && (!row.parent || this.ownsWorktree(row))) await this.stopServices(this.cwdOf(row))
    await Promise.all(
      this.terminals
        .bySession(sessionId)
        .filter((terminal) => {
          if (!heir || terminal.kind !== 'service') return true
          this.terminals.reassign(terminal.id, heir.id)
          return false
        })
        .map((terminal) => this.terminals.close(terminal.id))
    )
    this.termStatus.delete(sessionId)
    this.updateRow(sessionId, { archived: 1, run_state: 'idle' })
  }

  /** The cleanup script failed or timed out: a note in the session, which carries on anyway. */
  private noticeCleanup(sessionId: string, result: CleanupResult | null): void {
    if (!result || (result.code === 0 && !result.timedOut)) return
    const tail = result.output ? ` ${result.output.split('\n').slice(-3).join(' ').slice(-300)}` : ''
    this.upsertItem(sessionId, {
      kind: 'notice',
      id: randomUUID(),
      turnId: 'system',
      at: Date.now(),
      tone: 'error',
      text: result.timedOut
        ? t('The worktree cleanup script timed out and was stopped; Ladder went on anyway.{tail}', { tail })
        : t('The worktree cleanup script exited with code {code}; Ladder went on anyway.{tail}', { code: result.code ?? '-', tail })
    })
    this.flush()
  }

  // ── Start actions ([[run]] in .ladder/settings.toml) ────────────────────

  private async startRun(projectId: string, sessionId: string | null, name: string): Promise<TerminalInfo> {
    const project = this.mustProject(projectId)
    const settings = await loadProjectSettings(project.path)
    const action = settings.run.find((r) => r.name === name)
    if (!action) throw new Error(t('No action “{name}” in .ladder/settings.toml.', { name }))
    const row = sessionId ? this.rows.get(sessionId) : undefined
    const cwd = row ? this.cwdOf(row) : project.path
    const same = this.terminals.list().filter((t) => t.kind === 'run' && t.title === action.name && t.cwd === cwd)
    // One run at a time: the existing one is restarted. With concurrent = true another opens only if the existing one is still running.
    const reusable = action.concurrent ? same.find((t) => t.state !== 'running') : same[0]
    if (reusable) return this.terminals.restart(reusable.id, { command: action.command })
    return this.terminals.spawn({ projectId, sessionId, kind: 'run', title: action.name, cwd, command: action.command, port: this.ports.allocate(cwd) })
  }

  // ── Terminal sessions ───────────────────────────────────────────────────

  /** Starts the session's CLI in its terminal. `prompt` becomes the first message for claude and codex. */
  private startTerminalAgent(sessionId: string, prompt: string | null, resume = false): void {
    const row = this.mustRow(sessionId)
    const project = this.mustProject(row.project_id)
    const cwd = this.cwdOf(row)
    const words = splitCommand(row.command ?? 'claude')
    const program = basename(words[0] ?? '')
    const kind: AgentKind = program === 'claude' ? 'claude' : program === 'codex' ? 'codex' : 'generic'
    const options: SpawnOptions = {
      projectId: project.id,
      sessionId,
      kind: 'agent',
      title: row.title,
      cwd,
      command: row.command,
      port: this.ports.allocate(cwd)
    }
    if (kind === 'claude') {
      const claudeId = row.agent_ref ?? randomUUID()
      if (!row.agent_ref) this.updateRow(sessionId, { agent_ref: claudeId })
      options.file = words[0] === 'claude' && this.claudeCli ? this.claudeCli : words[0]
      options.args = [...words.slice(1), ...(prompt && !resume ? [prompt] : [])]
      options.agent = { kind, claudeSessionId: claudeId, resume }
      const configDir = this.profiles.configDir(row.profile_id)
      // Always set, even if empty: restart() merges the options and would keep the env of a removed profile.
      options.env = configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}
    } else if (kind === 'codex') {
      options.file = words[0]
      options.args = [...words.slice(1), ...(prompt && !resume ? [prompt] : [])]
      options.agent = { kind }
      const configDir = this.profiles.configDir(row.profile_id)
      options.env = configDir ? { CODEX_HOME: configDir } : {}
    } else {
      options.agent = { kind }
    }
    const existing = this.terminals.bySession(sessionId, 'agent')[0]
    const resolved = options.file && !options.file.includes('/') ? null : options.file
    void (async () => {
      // GUI apps do not see the shell's PATH: the command is resolved with the login shell.
      if (options.file && !resolved) options.file = (await whichInShell(options.file)) ?? options.file
      if (existing) this.terminals.restart(existing.id, options)
      else this.terminals.spawn(options)
      this.updateRow(sessionId, { run_state: kind === 'generic' ? 'running' : 'starting', estimated: kind === 'generic' ? 1 : 0 })
      this.termStatus.set(sessionId, { label: null, activity: null, turn: null, waitingSince: null })
      this.emitSummary(sessionId)
      // Session start checkpoint: it is the "before" of the session's diff.
      if (!resume) void this.terminalCheckpoint(sessionId, 'session', 'start', t('Session start'))
    })()
  }

  private resumeTerminalSession(sessionId: string): null {
    const row = this.mustRow(sessionId)
    if (row.mode !== 'terminal') throw new Error(t('Only terminal sessions can be restarted.'))
    const terminal = this.terminals.bySession(sessionId, 'agent')[0]
    if (terminal?.state === 'running') return null
    this.startTerminalAgent(sessionId, null, Boolean(row.agent_ref))
    return null
  }

  private async terminalCheckpoint(sessionId: string, turnId: string, kind: 'start' | 'end', label: string | null): Promise<string | null> {
    const row = this.rows.get(sessionId)
    const project = row ? this.projects.get(row.project_id) : undefined
    if (!row || !project?.isGit) return null
    const root = this.cwdOf(row)
    const sha = await createCheckpoint(root, `refs/ladder/${sessionId}/${turnId}-${kind}`, `ladder: turn ${kind}`).catch(() => null)
    if (sha) recordCheckpoint(this.db, { session_id: sessionId, turn_id: turnId, kind, sha, root, label, at: Date.now() })
    return sha
  }

  private onAgentSignal(terminal: TerminalInfo, signal: AgentSignal): void {
    const sessionId = terminal.sessionId
    const row = sessionId ? this.rows.get(sessionId) : undefined
    if (!sessionId || !row || row.mode !== 'terminal' || terminal.kind !== 'agent') return
    const status = this.termStatus.get(sessionId) ?? { label: null, activity: null, turn: null, waitingSince: null }
    this.termStatus.set(sessionId, status)
    const wasWaiting = row.run_state === 'waiting'
    const project = this.projects.get(row.project_id)
    switch (signal.type) {
      case 'ready':
        status.label = null
        status.activity = null
        if (row.run_state !== 'idle') this.updateRow(sessionId, { run_state: 'idle', estimated: 0 })
        break
      case 'turn-start': {
        const turnId = randomUUID()
        const label = signal.prompt ? titleFrom(signal.prompt) : t('Message in the terminal')
        status.turn = { id: turnId, start: this.terminalCheckpoint(sessionId, turnId, 'start', label), at: Date.now() }
        break
      }
      case 'running':
        status.label = null
        status.activity = signal.activity ?? status.activity
        this.updateRow(sessionId, { run_state: 'running', estimated: signal.estimated ? 1 : 0 })
        break
      case 'waiting':
        status.label = signal.label
        status.activity = signal.activity
        if (!wasWaiting) status.waitingSince = Date.now()
        this.updateRow(sessionId, { run_state: 'waiting', estimated: signal.estimated ? 1 : 0 })
        if (!wasWaiting && project) {
          const cli = basename(splitCommand(row.command ?? 'claude')[0] ?? 'claude')
          this.attention({
            kind: 'request',
            sessionId,
            projectId: project.id,
            itemId: null,
            title: `${project.name} · ${row.title}`,
            body: `${t('{cli} in the terminal is waiting for you: {label}', { cli, label: (signal.label ?? t('request')).toLowerCase() })}${signal.activity ? ` · ${signal.activity}` : ''}`
          })
        }
        break
      case 'done': {
        status.label = null
        status.activity = null
        // End of turn: the session becomes "unread" and the turn gets its end checkpoint.
        const seq = row.last_seq + 1
        const now = Date.now()
        this.updateRow(sessionId, { run_state: 'idle', estimated: signal.estimated ? 1 : 0, last_seq: seq, last_activity_seq: seq, activity_at: now })
        const turn = status.turn
        status.turn = null
        if (turn) void turn.start.then((start) => (start ? this.terminalCheckpoint(sessionId, turn.id, 'end', null) : null))
        if (turn && project) {
          this.attention({ kind: 'turn', sessionId, projectId: project.id, projectName: project.name, itemId: null, durationMs: now - turn.at, title: row.title })
        }
        break
      }
      case 'error':
        status.label = null
        status.activity = signal.message
        this.updateRow(sessionId, { run_state: 'error', estimated: 0, activity_at: Date.now(), last_seq: row.last_seq + 1, last_activity_seq: row.last_seq + 1 })
        if (project) this.attention({ kind: 'error', sessionId, projectId: project.id, itemId: null, title: `${project.name} · ${row.title}`, body: signal.message })
        break
      case 'exit':
        status.label = null
        status.activity = null
        status.turn = null
        this.updateRow(sessionId, { run_state: 'idle', estimated: 0 })
        break
    }
    if (wasWaiting && row.run_state !== 'waiting') {
      status.waitingSince = null
      this.attention({ kind: 'resolved', sessionId, itemId: null })
    }
    this.emitSummary(sessionId)
  }

  // ── Turni ────────────────────────────────────────────────────────────────

  private async send(sessionId: string, text: string, attachments: Attachment[] = [], busy: 'queue' | 'steer' = 'queue'): Promise<void> {
    const row = this.mustRow(sessionId)
    if (row.mode === 'terminal') throw new Error(t('A terminal session is used from its terminal.'))
    if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
    if (this.isBusy(sessionId)) {
      if (busy === 'steer' && (await this.steerInto(sessionId, text, attachments))) return
      // The turn may have ended while we waited for the agent: then the message starts, it does not stay queued.
      if (this.isBusy(sessionId)) {
        const queue = JSON.parse(this.mustRow(sessionId).queue) as QueuedMessage[]
        queue.push({ id: randomUUID(), text, ...(attachments.length ? { attachments } : {}) })
        this.updateRow(sessionId, { queue: JSON.stringify(queue) })
        this.emitSummary(sessionId)
        return
      }
    }
    await this.startTurn(sessionId, text, attachments)
  }

  /** The session cannot start a turn now: it is working, waiting for an answer or for setup. */
  private isBusy(sessionId: string): boolean {
    const row = this.mustRow(sessionId)
    // During a branch switch of the main checkout no turn starts there: the message is queued and restarts when the switch ends.
    if (!row.worktree && this.switchingBranch.has(row.project_id)) return true
    return this.isBusyNow(sessionId)
  }

  /** Like `isBusy`, without the branch switch in progress (which is what the switch's own check must ignore). */
  private isBusyNow(sessionId: string): boolean {
    const row = this.mustRow(sessionId)
    const runtime = this.runtimes.get(sessionId)
    // The host turn stays open until onTurnEnd has finished: a send in that time is queued and the final drain picks it up.
    return !!runtime?.adapter.isRunning || !!runtime?.turnId || (runtime?.closing ?? 0) > 0 || !!runtime?.exited || row.run_state === 'waiting' || this.preparing.has(sessionId) || (this.starting.get(sessionId) ?? 0) > 0
  }

  /** The agent accepts messages inside the current turn (Claude and Codex; ACP agents do not). */
  private canSteer(row: SessionRow): boolean {
    return row.mode !== 'terminal' && (row.agent === 'claude-code' || row.agent === 'codex')
  }

  /**
   * Inserts the message into the current turn, with the 'user' row right in the turn. False if it cannot
   * (agent without insertion, / command turn, open request, interruption in progress): the caller queues it.
   * With an open request it queues by choice: the agent is stopped waiting for your answer and a message in between
   * would change that request's context.
   */
  private async steerInto(sessionId: string, text: string, attachments: Attachment[]): Promise<boolean> {
    const row = this.mustRow(sessionId)
    const runtime = this.runtimes.get(sessionId)
    if (!runtime?.turnId || !runtime.adapter.steer || !runtime.adapter.isRunning) return false
    if (!this.canSteer(row) || row.run_state !== 'running' || runtime.command || runtime.handoff || runtime.interrupting || runtime.closing > 0 || this.preparing.has(sessionId)) return false
    const turnId = runtime.turnId
    // The row id is also the message uuid in the stream: needed to find it again if it runs on its own.
    const id = randomUUID()
    if (!(await runtime.adapter.steer(text, attachments, id))) return false
    this.upsertItem(sessionId, this.userItem(turnId, text, attachments, { id, steered: true }))
    this.flush()
    return true
  }

  /**
   * Delivers a queued message. 'steer': enters the current turn. 'now': interrupts the turn and starts
   * this one ahead of the rest of the queue. When idle it starts like a normal message.
   */
  private async deliverQueued(sessionId: string, id: string, how: 'steer' | 'now'): Promise<void> {
    const row = this.mustRow(sessionId)
    if (row.mode === 'terminal') throw new Error(t('A terminal session is used from its terminal.'))
    const queue = JSON.parse(row.queue) as QueuedMessage[]
    const index = queue.findIndex((q) => q.id === id)
    if (index < 0) return
    const [message] = queue.splice(index, 1)
    const attachments = message.attachments ?? []
    const runtime = this.runtimes.get(sessionId)
    const working = !!runtime?.adapter.isRunning && !this.preparing.has(sessionId)

    if (!working && !this.isBusy(sessionId)) {
      // When idle: no turn to enter or interrupt, it starts like a normal message.
      this.updateRow(sessionId, { queue: JSON.stringify(queue) })
      this.emitSummary(sessionId)
      await this.startTurn(sessionId, message.text, attachments)
      return
    }
    if (how === 'steer') {
      if (!this.canSteer(row)) throw new Error(t('This agent cannot take messages during a turn.'))
      if (!working || row.run_state !== 'running') throw new Error(t('The session cannot take a message right now.'))
      this.updateRow(sessionId, { queue: JSON.stringify(queue) })
      if (await this.steerInto(sessionId, message.text, attachments)) {
        this.emitSummary(sessionId)
        return
      }
      // The turn ended while we were inserting and the session is free: the message starts like a normal one.
      if (!this.isBusy(sessionId)) {
        this.emitSummary(sessionId)
        await this.startTurn(sessionId, message.text, attachments)
        return
      }
      // The turn does not accept messages: the message goes back to its place.
      const current = JSON.parse(this.mustRow(sessionId).queue) as QueuedMessage[]
      current.splice(Math.min(index, current.length), 0, message)
      this.updateRow(sessionId, { queue: JSON.stringify(current) })
      this.emitSummary(sessionId)
      throw new Error(t('The message could not be added to the running turn.'))
    }
    // With pending inserted messages (Claude) the message enters the stream right after the interruption receipt:
    // the CLI and the host thus open a single turn (the implicit one) with the pending ones and the message.
    if (working && runtime?.adapter.interruptThenSend && (runtime.adapter.pendingSteerCount ?? 0) > 0) {
      const turnId = runtime.turnId ?? 'system'
      this.updateRow(sessionId, { queue: JSON.stringify(queue) })
      this.emitSummary(sessionId)
      for (const [requestId] of runtime.pending) this.expireRequest(sessionId, requestId)
      runtime.interrupting = true
      const id = randomUUID()
      const ok = await runtime.adapter.interruptThenSend(message.text, attachments, id, () =>
        this.upsertItem(sessionId, this.userItem(turnId, message.text, attachments, { id }))
      )
      if (!ok) {
        runtime.interrupting = false
        const current = JSON.parse(this.mustRow(sessionId).queue) as QueuedMessage[]
        current.unshift(message)
        this.updateRow(sessionId, { queue: JSON.stringify(current) })
        this.emitSummary(sessionId)
      }
      return
    }
    // 'now': at the head of the queue; when the interruption ends onTurnEnd starts the first.
    queue.unshift(message)
    this.updateRow(sessionId, { queue: JSON.stringify(queue) })
    this.emitSummary(sessionId)
    if (working) await this.interrupt(sessionId, false)
  }

  /**
   * / commands of a session, without starting processes: the session's list, then Codex's fixed commands,
   * then the last known list per agent and folder. The real list arrives with the event when the runtime starts.
   */
  private commandsFor(sessionId: string): SlashCommand[] {
    const row = this.rows.get(sessionId)
    if (!row || row.mode === 'terminal' || row.archived) return []
    const own = this.commandLists.get(sessionId)
    if (own) return own
    if (row.agent === 'codex') return codexFixedCommands()
    return this.lastCommands.get(`${row.agent}\0${this.cwdOf(row)}`) ?? []
  }

  /** Runs an agent / command: a turn like the others, but with a 'command' row in place of the user's. */
  private async runCommand(sessionId: string, name: string, args: string): Promise<void> {
    const row = this.mustRow(sessionId)
    if (row.mode === 'terminal') throw new Error(t('A terminal session is used from its terminal.'))
    if (this.isBusy(sessionId) || (row.run_state !== 'idle' && row.run_state !== 'error')) throw new Error(t('Wait for the session to finish before running a command.'))
    if (!this.commandsFor(sessionId).some((c) => c.name === name)) throw new Error(t('Unknown command: /{name}', { name }))
    await this.startTurn(sessionId, `/${name} ${args}`.trim(), [], { name, args })
  }

  /** The session's agent process: creates and starts it if missing. */
  private ensureRuntime(sessionId: string): Runtime {
    // An archived or being-archived session does not restart the agent: it would create a process nobody closes.
    if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
    const existing = this.runtimes.get(sessionId)
    if (existing) return existing
    const row = this.mustRow(sessionId)
    const owner: { adapter?: AgentSession } = {}
    const adapter = this.createAdapter(
      row.agent,
      { cwd: this.cwdOf(row), model: row.model, effort: row.effort as Effort | null, permission: row.permission as PermissionLevel, resume: row.external_id, autonomyHint: this.prefs.autonomyHint !== false, ...(this.isReadOnlyRow(row) ? { readOnly: true } : {}), ...(row.parent ? {} : { browserTools: this.browserAgent.register(sessionId, row.project_id) }), ladderTools: this.ladderMcp.register(sessionId), delegateHint: this.delegateHints.get(sessionId) ?? null },
      this.guardEvents(sessionId, owner, this.adapterEvents(sessionId)),
      row.profile_id
    )
    owner.adapter = adapter
    const runtime: Runtime = { adapter, turnId: null, turnStart: null, turnCounts: emptyCounts(), activity: null, pending: new Map(), command: null, interrupting: false, closing: 0, ending: Promise.resolve(), startedAt: Date.now() }
    this.runtimes.set(sessionId, runtime)
    adapter.start()
    return runtime
  }

  /** Events from an adapter that is no longer the session's (closed, replaced) are ignored. */
  private guardEvents(sessionId: string, owner: { adapter?: AgentSession }, events: AdapterEvents): AdapterEvents {
    const guarded: Record<string, unknown> = {}
    for (const [name, handler] of Object.entries(events) as [string, (...args: unknown[]) => unknown][]) {
      guarded[name] = (...args: unknown[]) => {
        if (this.runtimes.get(sessionId)?.adapter === owner.adapter) return handler(...args)
        return name === 'request' ? Promise.resolve({ optionId: 'deny', message: t('The request expired.') }) : undefined
      }
    }
    return guarded as unknown as AdapterEvents
  }

  /** 'user' row of a message: the same for starting a turn and for inserting into one in progress. */
  private userItem(turnId: string, text: string, attachments: Attachment[], extra: { id?: string; steered?: boolean } = {}): ItemInput {
    return {
      kind: 'user',
      id: extra.id ?? randomUUID(),
      turnId,
      at: Date.now(),
      text,
      ...(extra.steered ? { steered: true } : {}),
      ...(attachments.length ? { attachments: attachments.map((a) => ({ name: a.name, mediaType: a.mediaType })) } : {})
    }
  }

  /**
   * Opens a turn on the host side: runtime state, the session's 'running' row and start checkpoint.
   * `rows` writes the turn's rows (user message or command) with the new turnId.
   */
  private async beginTurn(sessionId: string, runtime: Runtime, opts: { title?: string; label: string | null; rows?: (turnId: string, backgroundDone: number) => void; implicit?: boolean; agentsState?: 'resumed' | 'continued' | 'dismissed' }): Promise<string> {
    const row = this.mustRow(sessionId)
    const project = this.mustProject(row.project_id)
    const cwd = this.cwdOf(row)
    const turnId = randomUUID()
    runtime.turnId = turnId
    runtime.implicit = !!opts.implicit
    runtime.approveAll = false
    // A new user turn re-enables the agent browser tools stopped by the turn's interruption, not by an explicit stop.
    if (!opts.implicit) this.browserAgent.turnStarted(sessionId)
    // The count applies to the first turn after the backgrounds end, whichever it is.
    const backgroundDone = this.agentsBeforeTurn.get(sessionId) ?? 0
    this.agentsBeforeTurn.delete(sessionId)
    // Any turn closes the background wait: restarted on its own (implicit) or by a user message.
    this.agentsIdle.delete(sessionId)
    clearTimeout(this.agentsWait.get(sessionId))
    this.agentsWait.delete(sessionId)
    this.settleAgentsFinished(sessionId, opts.agentsState ?? 'continued')
    runtime.turnAgents = 0
    runtime.turnRequests = 0
    runtime.interrupting = false
    runtime.turnCounts = emptyCounts()
    // The implicit turn is opened by the agent for an inserted message: it does not prune the list.
    if (!opts.implicit && this.subagents.turnStarted(sessionId)) this.emitSubagents(sessionId)
    runtime.activity = t('Thinking…')
    opts.rows?.(turnId, backgroundDone)
    this.updateRow(sessionId, { run_state: 'running', ...(opts.title ? { title: opts.title } : {}) })
    this.emitSummary(sessionId)
    this.flush()
    // Turn already open (turnId assigned): the level left waiting applies from this turn, before the agent receives the message.
    await this.applyNextPermission(sessionId, runtime)
    runtime.turnStart = project.isGit ? await createCheckpoint(cwd, `refs/ladder/${sessionId}/${turnId}-start`, 'ladder: turn start').catch(() => null) : null
    if (runtime.turnStart) recordCheckpoint(this.db, { session_id: sessionId, turn_id: turnId, kind: 'start', sha: runtime.turnStart, root: cwd, label: opts.label, at: Date.now() })
    return turnId
  }

  /** Turn start in progress (from the message to the host turn opening): meanwhile the session is not idle, and a second send is queued. */
  private async startTurn(sessionId: string, text: string, attachments: Attachment[] = [], command: { name: string; args: string } | null = null, system: { rows: (turnId: string) => HandoffRun | void } | null = null): Promise<void> {
    this.starting.set(sessionId, (this.starting.get(sessionId) ?? 0) + 1)
    try {
      await this.startTurnNow(sessionId, text, attachments, command, system)
    } finally {
      const left = (this.starting.get(sessionId) ?? 1) - 1
      if (left > 0) this.starting.set(sessionId, left)
      else this.starting.delete(sessionId)
    }
  }

  private async startTurnNow(sessionId: string, text: string, attachments: Attachment[] = [], command: { name: string; args: string } | null = null, system: { rows: (turnId: string) => HandoffRun | void } | null = null): Promise<void> {
    const row = this.mustRow(sessionId)
    // Browser for the agent: the server must already be listening when the runtime is created (only if the switch is on).
    if (this.isGone(sessionId)) return
    // Deferred restart that found no free turn end (background subagents finished without a turn): it happens now, before the message.
    const previous = this.runtimes.get(sessionId)
    // Without a process the next one is created fresh: a deferred restart is no longer needed.
    if (!previous) this.restartAfterTurn.delete(sessionId)
    else if (this.restartAfterTurn.has(sessionId) && !this.agentBusy(sessionId, previous)) {
      this.restartAfterTurn.delete(sessionId)
      this.closeRuntime(sessionId)
      this.noticeInfo(sessionId, t('Agent restarted. The next message continues the conversation with settings and MCP servers loaded again.'))
    }
    // Read-only children do not have the agent browser.
    const browserReady = this.runtimes.has(sessionId) || row.parent ? null : this.browserAgent.prepare(row.project_id)
    if (browserReady) await browserReady
    // Ladder MCP server: must be listening before the runtime is created (all chat sessions, children included).
    if (!this.runtimes.has(sessionId)) await this.ladderMcp.start().catch((error: Error) => console.error(`[host] Ladder MCP server: ${error.message}`))
    // Project delegates in the system prompt: the prompt is fixed when the process starts, so they are read first.
    if (!this.runtimes.has(sessionId)) await this.loadDelegateHint(sessionId).catch(() => undefined)
    // Archival may have arrived while waiting for the browser.
    if (this.isGone(sessionId)) return
    const runtime = this.ensureRuntime(sessionId)
    // The title comes from the user's first message: an initial command does not consume it.
    // A chosen title (renamed or given at creation) is left alone: only the placeholder is replaced.
    const firstMessage = !command && !system && isPlaceholderTitle(row.title) && !this.hasUserMessage(sessionId)
    runtime.lastCommand = command?.name ?? null
    await this.beginTurn(sessionId, runtime, {
      // The title comes from the first message, except for sessions from an issue, PR or branch: those keep their title.
      title: firstMessage && !row.source ? titleFrom(text) : undefined,
      label: titleFrom(text),
      // A / command is not the resumption of backgrounds.
      agentsState: command || system ? 'dismissed' : 'continued',
      rows: (turnId) => {
        if (system) {
          // System turn (handoff): its own row in place of the user's.
          const run = system.rows(turnId)
          if (run) runtime.handoff = run
        } else if (command) {
          runtime.command = { id: randomUUID(), at: Date.now(), ...command }
          this.upsertItem(sessionId, { kind: 'command', ...runtime.command, turnId, status: 'running', error: null })
        } else {
          this.upsertItem(sessionId, this.userItem(turnId, text, attachments))
        }
      }
    })
    // Message forwarded by the cross-review: the turn it creates is not reviewed in turn.
    if (this.reviewForwards.get(sessionId) === text && runtime.turnId) {
      this.reviewForwards.delete(sessionId)
      this.reviewTurns.add(runtime.turnId)
    }
    if (command) runtime.adapter.command(command.name, command.args)
    else runtime.adapter.send(text, attachments)
  }

  /**
   * An inserted message that survived an interruption runs as a turn of its own: the host opens it here, so the output
   * is not lost. Its 'user' rows (already created at insertion, id = uuid) move to the new turn without "steered".
   */
  private async openImplicitTurn(sessionId: string, uuids: string[]): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    const row = this.rows.get(sessionId)
    if (!runtime || !row || !this.projects.has(row.project_id)) return
    // The turn has its turnId right away: output does not land in the turn being closed (onTurnEnd holds a snapshot of it).
    await this.beginTurn(sessionId, runtime, {
      label: null,
      implicit: true,
      // Restarted on its own after the backgrounds: 'resumed'. Born from inserted messages: unrelated to the row.
      agentsState: uuids.length === 0 ? 'resumed' : 'dismissed',
      rows: (turnId, backgroundDone) => {
        // At the head of the turn: because the agent restarted on its own.
        if (uuids.length === 0) {
          this.upsertItem(sessionId, { kind: 'agent-start', id: `${turnId}:start`, turnId, at: Date.now(), reason: backgroundDone > 0 ? 'background-agents' : 'other', finished: backgroundDone > 0 ? backgroundDone : null })
        }
        for (const uuid of uuids) {
          const item = this.liveItems.get(sessionId)?.get(uuid)
          if (item?.kind !== 'user') continue
          const { steered: _steered, ...rest } = item
          this.upsertItem(sessionId, { ...rest, turnId })
        }
      }
    })
  }

  /** A single automatic attempt: when the first message's turn is complete, if the title is not the user's. Never noise toward the user. */
  private async autoTitle(sessionId: string): Promise<void> {
    const row = this.rows.get(sessionId)
    if (!row || !this.prefs.generatedTitles || row.mode !== 'chat' || row.title_source !== 'provisional' || this.titling.has(sessionId) || this.titleTried.has(sessionId)) return
    // Sessions from an issue, PR or branch keep their title.
    if (row.source) return
    // Without a message and a reply from the first turn it does not count as an attempt: it is retried next turn.
    if (!this.titleInputs(sessionId)) return
    this.titleTried.add(sessionId)
    await inTitleQueue(() => this.generateTitle(sessionId, false)).catch(() => undefined)
  }

  /** "Regenerate title": explicit action, it also applies to a renamed title (the source goes back to 'generated'). */
  private async regenerateTitle(sessionId: string): Promise<string> {
    const row = this.mustRow(sessionId)
    if (row.mode !== 'chat') throw new Error(t('Only chat sessions have a generated title.'))
    if (this.titling.has(sessionId)) throw new Error(t('A title is already being generated.'))
    const title = await this.generateTitle(sessionId, true)
    if (!title) throw new Error(t('Could not generate a title.'))
    return title
  }

  /** User's first message and start of the reply in the same turn, if that turn is complete. */
  private titleInputs(sessionId: string): { first: Extract<ChatItem, { kind: 'user' }>; reply: Extract<ChatItem, { kind: 'assistant' }> } | null {
    const items = this.loadItems(sessionId)
    const first = items.find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user')
    if (!first || !items.some((i) => i.kind === 'turn-end' && i.status === 'completed' && i.turnId === first.turnId)) return null
    const reply = items.find((i): i is Extract<ChatItem, { kind: 'assistant' }> => i.kind === 'assistant' && i.turnId === first.turnId && Boolean(i.text.trim()))
    return reply ? { first, reply } : null
  }

  /** Team prefixes (LAD, LIN…) of the issues the project's sessions came from. */
  private teamsOf(projectId: string): string[] {
    const refs: string[] = []
    for (const row of this.rows.values()) {
      if (row.project_id === projectId && row.source) refs.push((JSON.parse(row.source) as SessionSource).ref)
    }
    return teamPrefixes(refs)
  }

  /**
   * First message and start of the reply to the agent's small model; writes only if the title has not changed in the meantime.
   * Returns the written title, or the current one if the user renamed in the meantime; null if the model gave no title.
   */
  private async generateTitle(sessionId: string, force: boolean): Promise<string | null> {
    const row = this.mustRow(sessionId)
    const inputs = this.titleInputs(sessionId)
    if (!inputs) {
      if (force) throw new Error(t('There is no conversation to title yet.'))
      return null
    }
    const small = this.titleModel(row.agent, row.profile_id)
    if (!small) {
      if (force) throw new Error(t('{agent} cannot generate titles.', { agent: this.agentName(row.agent) }))
      return null
    }
    const startTitle = row.title
    this.titling.add(sessionId)
    this.emitSummary(sessionId)
    let title: string | null = null
    try {
      title = await small(titlePrompt(inputs.first.text, inputs.reply.text))
    } catch {
      title = null
    } finally {
      this.titling.delete(sessionId)
    }
    const current = this.rows.get(sessionId)
    if (!current) return null
    // The user may have renamed while the model was working: the user wins, and it is not an error.
    if (current.title !== startTitle || (!force && current.title_source === 'user')) {
      this.emitSummary(sessionId)
      return current.title
    }
    if (!title) {
      this.emitSummary(sessionId)
      return null
    }
    const source = current.source ? (JSON.parse(current.source) as SessionSource) : null
    // From an issue, PR or Linear the prefix is their reference; for a branch there is none.
    const ref = source ? (source.kind === 'branch' ? null : source.ref) : issueRef(inputs.first.text, this.teamsOf(current.project_id))
    const final = clipTitle(withIssue(title, ref))
    this.updateRow(sessionId, { title: final, title_source: 'generated' })
    this.emitSummary(sessionId)
    return final
  }

  /** Branch, commit and PR generation on: global switch and, if present, the project's. */
  private textEnabled(projectId: string): boolean {
    if (this.prefs.generatedText === false) return false
    const row = this.db.prepare('select json from ui_state where project_id = ?').get(projectId) as { json: string } | undefined
    try {
      return !row || (JSON.parse(row.json) as ProjectUiState).generatedText !== false
    } catch {
      return true
    }
  }

  /** Agent browser on? The project setting (true/false) overrides the global switch; off by default. */
  private agentBrowserEnabled(projectId: string): boolean {
    const row = this.db.prepare('select json from ui_state where project_id = ?').get(projectId) as { json: string } | undefined
    try {
      const own = row ? (JSON.parse(row.json) as ProjectUiState).agentBrowser : undefined
      return own ?? this.prefs.agentBrowser === true
    } catch {
      return this.prefs.agentBrowser === true
    }
  }

  /** Like titleModel, but for free text with its own timeout. */
  private textModel(agent: string, profileId: string | null): TextModel | null {
    const custom = customProfileId(profileId)
    const configDir = this.profiles.configDir(profileId)
    const status = custom ? this.profileAgents.get(custom) : this.agents.get(agent)
    if (agent === 'claude-code') return status?.available ? (system, prompt, ms, signal) => claudeText(this.claudeCli, system, prompt, ms, configDir, signal) : null
    if (agent === 'codex') {
      const model = status?.available && this.codexCli ? smallCodexModel(status.models) : null
      return model ? (system, prompt, ms, signal) => codexText(this.codexCli!, this.codexVer ?? '0.0.0', model, system, prompt, ms, configDir, signal) : null
    }
    return null
  }

  /** Branch name from the request, only with generated texts on (global and project); null: the name from the title is used. Never errors. */
  private async branchName(projectId: string, agent: string, profileId: string | null, text: string): Promise<string | null> {
    if (!this.textEnabled(projectId) || !text.trim()) return null
    const model = this.textModel(agent, profileId)
    if (!model) return null
    try {
      const raw = await model(BRANCH_SYSTEM, branchPrompt(text), BRANCH_TIMEOUT_MS)
      return raw ? cleanBranch(raw) : null
    } catch {
      return null
    }
  }

  /** Model, folder and conversation of a text request; errors are already translated. */
  private writingContext(sessionId: string): { row: SessionRow; project: Project; root: string; model: TextModel } {
    const row = this.mustRow(sessionId)
    const project = this.mustProject(row.project_id)
    if (!this.textEnabled(project.id)) throw new Error(textErrors.off())
    if (this.writing.has(sessionId)) throw new Error(textErrors.busy())
    const model = this.textModel(row.agent, row.profile_id)
    if (!model) throw new Error(textErrors.unavailable(this.agentName(row.agent)))
    return { row, project, root: this.cwdOf(row), model }
  }

  private beginWriting(sessionId: string): AbortController {
    const abort = new AbortController()
    this.writing.set(sessionId, abort)
    return abort
  }

  /** text.cancel: stops the generation in progress and frees the session at once, without waiting for the model to stop. */
  private cancelWriting(sessionId: string): void {
    this.writing.get(sessionId)?.abort()
    this.writing.delete(sessionId)
  }

  /** The session's issue reference: from the source (GitHub, Linear issue) or cited in the first message. */
  private issueOf(row: SessionRow, items: ChatItem[]): { ref: string; url: string | null } | null {
    const source = row.source ? (JSON.parse(row.source) as SessionSource) : null
    if (source && (source.kind === 'github-issue' || source.kind === 'linear')) return { ref: source.ref, url: source.url }
    const first = items.find((i) => i.kind === 'user')
    const ref = first && first.kind === 'user' ? issueRef(first.text, this.teamsOf(row.project_id)) : null
    return ref ? { ref, url: null } : null
  }

  /** "Write message": commit message proposal from the diff and the conversation. It does not commit. */
  private async writeCommit(sessionId: string, wanted: 'staged' | 'working' | undefined): Promise<GeneratedCommit> {
    const { row, project, root, model } = this.writingContext(sessionId)
    const abort = this.beginWriting(sessionId)
    try {
      const staged = (await git(root, ['diff', '--cached', '--name-only'])).length > 0
      const source = wanted ?? (staged ? 'staged' : 'working')
      if (source === 'staged' && !staged) throw new Error(textErrors.noStaged())
      const diff = await diffExcerpt(root, source)
      if (diff.files === 0) throw new Error(textErrors.noChanges())
      const items = this.loadItems(sessionId)
      const prompt = commitPrompt({
        diff: diff.text,
        conversation: conversationExcerpt(items),
        subjects: await recentSubjects(root),
        rules: await projectRules(root, project.path),
        issue: this.issueOf(row, items)?.ref ?? null
      })
      const raw = await model(COMMIT_SYSTEM, prompt, COMMIT_TIMEOUT_MS, abort.signal).catch(keepBlocked)
      if (abort.signal.aborted) throw new Error(textErrors.cancelled())
      const parts = raw ? splitText(raw, COMMIT_LABEL, 72, COMMIT_BODY_MAX) : null
      if (!parts) throw new Error(textErrors.failed())
      return { subject: parts.first, body: parts.body, source, files: diff.files, truncated: diff.cut }
    } finally {
      // After a cancellation the entry may already belong to a new request: only one's own is freed.
      if (this.writing.get(sessionId) === abort) this.writing.delete(sessionId)
    }
  }

  /** PR title and description from the branch's commits against the base. It does not create the PR. */
  private async writePr(sessionId: string): Promise<GeneratedPr> {
    const { row, project, root, model } = this.writingContext(sessionId)
    const abort = this.beginWriting(sessionId)
    try {
      const branch = (await repoInfo(root)).branch
      const cached = branch ? this.prs.get(`${root}\0${branch}`)?.status.base : null
      const base = cached ?? (await this.defaultBranchOf(project))
      const baseRef = (await resolveCommit(root, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base
      const commits = await branchSubjects(root, baseRef)
      if (commits.length === 0) throw new Error(textErrors.noCommits(base))
      const diff = await diffExcerpt(root, { range: `${baseRef}...HEAD` })
      const items = this.loadItems(sessionId)
      const prompt = prPrompt({
        diff: diff.text,
        conversation: conversationExcerpt(items),
        subjects: await recentSubjects(root),
        commits,
        rules: await projectRules(root, project.path)
      })
      const raw = await model(PR_SYSTEM, prompt, COMMIT_TIMEOUT_MS, abort.signal).catch(keepBlocked)
      if (abort.signal.aborted) throw new Error(textErrors.cancelled())
      const parts = raw ? splitText(raw, PR_LABEL, 80, PR_BODY_MAX) : null
      if (!parts) throw new Error(textErrors.failed())
      const issue = this.issueOf(row, items)
      // The link is added by Ladder, the same way every time: "Closes #12" / "Closes ABC-59".
      const escaped = issue?.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const body = issue && !new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(parts.body) ? `${parts.body}\n\nCloses ${issue.ref}`.trim() : parts.body
      return { title: parts.first, body, issue, base, files: diff.files, truncated: diff.cut }
    } finally {
      // After a cancellation the entry may already belong to a new request: only one's own is freed.
      if (this.writing.get(sessionId) === abort) this.writing.delete(sessionId)
    }
  }

  /** The small model from the same provider as the session: Claude (Haiku), Codex (a "mini" model); other agents none. */
  private titleModel(agent: string, profileId: string | null): ((prompt: string) => Promise<string | null>) | null {
    const custom = customProfileId(profileId)
    const configDir = this.profiles.configDir(profileId)
    const status = custom ? this.profileAgents.get(custom) : this.agents.get(agent)
    if (agent === 'claude-code') return status?.available ? (prompt) => claudeTitle(this.claudeCli, prompt, configDir) : null
    if (agent === 'codex') {
      const model = status?.available && this.codexCli ? smallCodexModel(status.models) : null
      return model ? (prompt) => codexTitle(this.codexCli!, this.codexVer ?? '0.0.0', model, prompt, configDir) : null
    }
    return null
  }

  private hasUserMessage(sessionId: string): boolean {
    const live = this.liveItems.get(sessionId)
    for (const item of live ? live.values() : this.loadItems(sessionId)) if (item.kind === 'user') return true
    return false
  }

  private noticeError(sessionId: string, text: string): void {
    this.upsertItem(sessionId, { kind: 'notice', id: randomUUID(), turnId: 'system', at: Date.now(), tone: 'error', text })
    this.flush()
  }

  private adapterEvents(sessionId: string): AdapterEvents {
    return {
      init: ({ externalId, model, effort }) => {
        const row = this.rows.get(sessionId)
        if (!row) return
        if (effort) this.initEffort.set(sessionId, effort)
        else this.initEffort.delete(sessionId)
        this.updateRow(sessionId, { external_id: externalId, model: row.model ?? model })
      },
      assistant: (id, text, streaming) => {
        const runtime = this.runtimes.get(sessionId)
        if (!runtime?.turnId) return
        this.upsertItem(sessionId, { kind: 'assistant', id, turnId: runtime.turnId, at: Date.now(), text, streaming })
      },
      tool: (update) => this.onTool(sessionId, update),
      activity: (text) => {
        const runtime = this.runtimes.get(sessionId)
        if (!runtime || runtime.activity === text) return
        runtime.activity = text
        this.emitSummary(sessionId)
      },
      request: (request, signal) => this.openRequest(sessionId, request, signal),
      turnEnd: (result) => {
        const runtime = this.runtimes.get(sessionId)
        if (!runtime) return
        // Snapshot of the turn being closed: an implicit turn may open while onTurnEnd waits for the checkpoints.
        // Without an open turn there is nothing to close (late result after an interruption).
        if (!runtime.turnId) return
        const snap = { runtime, turnId: runtime.turnId, turnStart: runtime.turnStart, counts: runtime.turnCounts, interrupting: runtime.interrupting, implicit: !!runtime.implicit, agents: runtime.turnAgents ?? 0, requests: runtime.turnRequests ?? 0 }
        runtime.closing++
        const endedAt = Date.now()
        runtime.ending = runtime.ending
          .then(() => this.onTurnEnd(sessionId, result, { ...snap, endedAt }))
          .catch((error: Error) => this.noticeError(sessionId, error.message))
          .finally(() => runtime.closing--)
      },
      turnStart: (uuids) => void this.openImplicitTurn(sessionId, uuids).catch(() => undefined),
      notice: (tone, text) => {
        const runtime = this.runtimes.get(sessionId)
        this.upsertItem(sessionId, { kind: 'notice', id: randomUUID(), turnId: runtime?.turnId ?? 'system', at: Date.now(), tone, text })
      },
      account: ({ account, email, models, limits }) => {
        const row = this.rows.get(sessionId)
        if (!row) return
        const same = [...this.rows.values()].filter((r) => r.agent === row.agent && r.profile_id === row.profile_id && !r.effort)
        const before = new Map(same.map((r) => [r.id, this.effectiveEffort(r)]))
        this.updateAgent(row.agent, { account, email, models, limits }, false, customProfileId(row.profile_id))
        // The effective effort depends on the model's defaults: if it changes with the new list, the summary is re-emitted.
        for (const r of same) if (this.effectiveEffort(r) !== before.get(r.id)) this.emitSummary(r.id)
      },
      usage: (windows) => {
        const row = this.rows.get(sessionId)
        if (!row || windows.length === 0) return
        const profileId = customProfileId(row.profile_id)
        const merged = new Map(((profileId ? this.profileAgents.get(profileId) : this.agents.get(row.agent))?.usage ?? []).map((w) => [w.key, w]))
        for (const window of windows) merged.set(window.key, window)
        this.updateAgent(row.agent, { usage: [...merged.values()], usageAt: Date.now() }, false, profileId)
      },
      subagent: (update) => {
        const found = this.subagents.find(sessionId, update.id)?.info
        // Closed by the safety net: if it now really finishes, it counts as if it had been in progress.
        const before = found && this.subagents.wasExpired(sessionId, update.id) ? { ...found, status: 'running' as const } : found
        const changed = this.subagents.update(sessionId, update)
        const runtimeNow = this.runtimes.get(sessionId)
        if (!found && runtimeNow?.turnId && this.subagents.find(sessionId, update.id)) runtimeNow.turnAgents = (runtimeNow.turnAgents ?? 0) + 1
        if (changed) {
          this.emitSubagents(sessionId)
          this.trackAgentEnd(sessionId, update.id, before)
          if (update.model !== undefined || update.effort !== undefined) this.saveSubagentMeta(sessionId, update.id)
        }
      },
      commands: (commands) => {
        this.commandLists.set(sessionId, commands)
        const row = this.rows.get(sessionId)
        if (row) this.lastCommands.set(`${row.agent}\0${this.cwdOf(row)}`, commands)
        this.broadcast({ type: 'session.commands', sessionId, commands })
      },
      compacted: ({ trigger, preTokens, postTokens }) => {
        const runtime = this.runtimes.get(sessionId)
        this.upsertItem(sessionId, { kind: 'compacted', id: randomUUID(), turnId: runtime?.turnId ?? 'system', at: Date.now(), trigger, preTokens, postTokens })
        // Context drops at once to the post-compaction value.
        const row = this.rows.get(sessionId)
        const known = row?.context ? (JSON.parse(row.context) as SessionSummary['context']) : null
        if (row && known && postTokens !== null) {
          this.updateRow(sessionId, { context: JSON.stringify({ ...known, used: postTokens }) })
          this.emitSummary(sessionId)
        }
      },
      context: (context) => {
        if (!this.rows.has(sessionId)) return
        this.contextAt.set(sessionId, Date.now())
        this.updateRow(sessionId, { context: JSON.stringify(context) })
        this.emitSummary(sessionId)
      },
      exit: (error) => {
        if (this.subagents.stopRunning(sessionId)) this.emitSubagents(sessionId)
        const runtime = this.runtimes.get(sessionId)
        if (!runtime) return
        runtime.exited = true
        this.agentsPending.delete(sessionId)
        this.agentsIdle.delete(sessionId)
        this.agentsRows.delete(sessionId)
        clearTimeout(this.agentsWait.get(sessionId))
        this.agentsWait.delete(sessionId)
        // A / command started by the user (e.g. /exit) can close the agent on purpose: the queue does not restart.
        const byCommand = !!runtime.lastCommand
        // Turn endings already queued finish before the runtime is removed.
        void runtime.ending.then(() => {
          if (this.runtimes.get(sessionId) !== runtime) return
          for (const [requestId] of runtime.pending) this.expireRequest(sessionId, requestId)
          // Turn still open at exit: it is not "done" (interrupted if you asked for it, otherwise an error).
          this.finishCommand(sessionId, runtime, runtime.interrupting ? 'interrupted' : 'error', runtime.interrupting ? null : error ?? t('{agent} exited', { agent: this.agentName(this.rows.get(sessionId)?.agent ?? '') }))
          if (runtime.handoff) {
            const run = runtime.handoff
            runtime.handoff = null
            this.failHandoff(sessionId, run, runtime.interrupting ? 'interrupted' : 'error', runtime.interrupting ? t('The handoff was interrupted.') : error ?? t('{agent} exited', { agent: this.agentName(this.rows.get(sessionId)?.agent ?? '') }))
          }
          // Child exited before answering: the entry on the parent's card does not stay 'running'.
          this.settleAdvice(sessionId, runtime.interrupting ? { state: 'stopped', error: null } : { state: 'error', error: error ?? t('{agent} exited', { agent: this.agentName(this.rows.get(sessionId)?.agent ?? '') }) })
          this.finishDelegation(sessionId, runtime.interrupting ? 'stopped' : 'error', error ?? t('{agent} exited', { agent: this.agentName(this.rows.get(sessionId)?.agent ?? '') }), '')
          this.runtimes.delete(sessionId)
          this.restartAfterTurn.delete(sessionId)
          this.revokeTools(sessionId)
          if (error) {
            const notice = this.upsertItem(sessionId, { kind: 'notice', id: randomUUID(), turnId: runtime.turnId ?? 'system', at: Date.now(), tone: 'error', text: t('{agent} exited: {error}', { agent: this.agentName(this.rows.get(sessionId)?.agent ?? ''), error }) })
            this.updateRow(sessionId, { run_state: 'error', activity_at: Date.now(), last_activity_seq: notice.seq })
            this.errorAttention(sessionId, notice.id, t('{agent} exited: {error}', { agent: this.agentName(this.rows.get(sessionId)?.agent ?? ''), error }))
          } else if (this.rows.get(sessionId)?.run_state !== 'idle') {
            this.updateRow(sessionId, { run_state: 'idle' })
          }
          this.emitSummary(sessionId)
          // Exit without an error (not a failed login or similar): the first queued message restarts with a new runtime.
          const queue = JSON.parse(this.rows.get(sessionId)?.queue ?? '[]') as QueuedMessage[]
          const early = Date.now() - runtime.startedAt < 5000
          const next = this.rows.get(sessionId)?.run_state === 'idle' && !error && !this.stopped && !byCommand && !early ? queue.shift() : undefined
          if (next) {
            this.updateRow(sessionId, { queue: JSON.stringify(queue) })
            void this.startTurn(sessionId, next.text, next.attachments ?? []).catch((e: Error) => {
              const current = JSON.parse(this.rows.get(sessionId)?.queue ?? '[]') as QueuedMessage[]
              current.unshift(next)
              this.revokeTools(sessionId)
              this.runtimes.get(sessionId)?.adapter.close()
              this.runtimes.delete(sessionId)
              this.updateRow(sessionId, { queue: JSON.stringify(current), run_state: 'idle' })
              this.noticeError(sessionId, e.message)
              this.emitSummary(sessionId)
            })
          }
        })
      }
    }
  }

  private onTool(sessionId: string, update: ToolUpdate): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime?.turnId) return
    const existing = this.liveItems.get(sessionId)?.get(update.id)
    if (!existing) {
      if (update.tool === 'command') runtime.turnCounts.commands++
      else if (update.tool === 'edit') runtime.turnCounts.edits++
      else if (update.tool === 'read') runtime.turnCounts.reads++
      else if (update.tool === 'search' || update.tool === 'web') runtime.turnCounts.searches++
    }
    const agent = existing?.kind === 'tool' ? existing.agent : undefined
    this.upsertItem(sessionId, {
      kind: 'tool',
      id: update.id,
      turnId: runtime.turnId,
      at: existing?.at ?? Date.now(),
      tool: update.tool,
      name: update.name,
      title: update.title,
      detail: update.detail,
      status: update.status,
      output: update.output,
      endedAt: update.status === 'running' ? null : Date.now(),
      ...(agent ? { agent } : {})
    })
  }

  /** Model and effort of the subagent also on the tool row that launched it: they stay visible after a restart. */
  private saveSubagentMeta(sessionId: string, id: string): void {
    const info = this.subagents.find(sessionId, id)?.info
    const item = info?.toolId ? this.liveItems.get(sessionId)?.get(info.toolId) : undefined
    if (!info || !item || item.kind !== 'tool') return
    const old = item.agent
    if (old?.model === info.model && old?.effort === (info.effort ?? null)) return
    this.upsertItem(sessionId, { ...item, agent: { model: info.model, effort: info.effort ?? null } })
  }

  /** Closes the turn's 'command' row, if the turn came from a / command. */
  private finishCommand(sessionId: string, runtime: Runtime, status: 'done' | 'error' | 'interrupted', error: string | null): void {
    const command = runtime.command
    if (!command) return
    runtime.command = null
    this.upsertItem(sessionId, { kind: 'command', ...command, turnId: runtime.turnId ?? 'system', status, error })
  }

  private openRequest(sessionId: string, request: UserRequest, signal: AbortSignal): Promise<RequestResponse> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime?.turnId) return Promise.resolve({ optionId: 'deny', message: t('Session not active.') })
    // Child session: nobody watches it and it does not end up in "Waiting".
    const own = this.rows.get(sessionId)
    const parent = own ? this.parentOf(own) : null
    if (own && parent) {
      if (this.isReadOnlyRow(own)) {
        // Read-only: commands that only read approve themselves (in Plan the CLI may still ask), the rest is refused.
        const allow = request.options.find((o) => o.kind === 'allow')
        if (request.requestType === 'permission' && request.command && allow && isReadOnlyBash(request.command)) return Promise.resolve({ optionId: allow.id })
        return Promise.resolve({ optionId: 'deny', message: t('This session is read-only: answer in text, without asking to run or change anything.') })
      }
      // Delegation with write permission: confirmations go to the parent's card, which the user watches; questions do not.
      if (parent.role !== 'delegate' || request.requestType === 'question' || !this.runtimes.get(parent.sessionId)?.turnId) {
        return Promise.resolve({ optionId: 'deny', message: t('This delegated session cannot ask the user questions: make reasonable assumptions or report that you are blocked.') })
      }
      return this.openRequest(parent.sessionId, { ...request, title: t('{agent} (delegated): {title}', { agent: this.agentName(own.agent), title: request.title }) }, signal)
    }
    const requestId = randomUUID()
    // The request is "pending" before it appears: the session summary already includes it (for "Waiting").
    let resolve!: (response: RequestResponse) => void
    const answer = new Promise<RequestResponse>((r) => (resolve = r))
    runtime.pending.set(requestId, { itemId: requestId, resolve })
    runtime.turnRequests = (runtime.turnRequests ?? 0) + 1
    signal.addEventListener('abort', () => this.expireRequest(sessionId, requestId), { once: true })
    this.upsertItem(sessionId, {
      kind: 'request',
      id: requestId,
      requestId,
      turnId: runtime.turnId,
      at: Date.now(),
      ...request,
      state: 'open',
      resolution: null
    })
    this.updateRow(sessionId, { run_state: 'waiting' })
    this.emitSummary(sessionId)
    this.flush()
    // Switched to Full access mid-turn (Codex): this turn's requests wait for nobody.
    if (runtime.approveAll && request.requestType === 'permission' && !NEVER_AUTO.has(request.toolName)) {
      this.autoApprove(sessionId, requestId, 'full')
      return answer
    }
    const row = this.mustRow(sessionId)
    const project = this.projects.get(row.project_id)
    if (project) {
      this.attention({ kind: 'request', sessionId, projectId: project.id, itemId: requestId, title: `${project.name} · ${row.title}`, body: requestBody(request) })
    }
    return answer
  }

  private respond(sessionId: string, requestId: string, response: RequestResponse, via: RequestItemData['via'] = 'chat', resolution?: string, viaDevice?: string): void {
    const runtime = this.runtimes.get(sessionId)
    const pending = runtime?.pending.get(requestId)
    const item = this.liveItems.get(sessionId)?.get(requestId) ?? this.loadItems(sessionId).find((i) => i.id === requestId)
    if (!pending || !runtime || !item || item.kind !== 'request') {
      throw new Error(t('This request is no longer active.'))
    }
    // An answer that is not among the options resolves nothing (it does not end up as "Approved"); the text is computed before touching the state.
    if ('optionId' in response && !item.options.some((o) => o.id === response.optionId)) throw new Error(t('That option is not available for this request.'))
    const text = resolution ?? describeResponse(item, response)
    runtime.pending.delete(requestId)
    this.upsertItem(sessionId, { ...item, state: 'resolved', resolution: text, via, ...(viaDevice ? { viaDevice } : {}) })
    if (runtime.pending.size === 0) this.updateRow(sessionId, { run_state: 'running' })
    this.emitSummary(sessionId)
    this.attention({ kind: 'resolved', sessionId, itemId: requestId })
    pending.resolve(response)
  }

  /** Approves an open request with the allow option (never always), because the new level permits it. */
  private autoApprove(sessionId: string, requestId: string, level: PermissionLevel): void {
    if (!this.runtimes.get(sessionId)?.pending.has(requestId)) return
    const item = this.liveItems.get(sessionId)?.get(requestId)
    const allow = item?.kind === 'request' ? item.options.find((o) => o.kind === 'allow') : null
    if (!allow) return
    this.respond(sessionId, requestId, { optionId: allow.id }, 'chat', level === 'full' ? t('Approved by switching to Full access') : t('Approved by switching to Edit'))
  }

  /** Does the level alone permit this request? Edit only for files inside the working folder. */
  private async allows(sessionId: string, level: PermissionLevel, item: RequestItemData): Promise<boolean> {
    if (item.requestType !== 'permission' || NEVER_AUTO.has(item.toolName)) return false
    if (level === 'full') return true
    const paths = [...(item.path ? [item.path] : []), ...(item.paths ?? [])]
    if (level !== 'edit' || !EDIT_TOOLS.has(item.toolName) || paths.length === 0) return false
    const row = this.rows.get(sessionId)
    if (!row) return false
    const cwd = this.cwdOf(row)
    for (const path of paths) if (!(await insideDir(cwd, path))) return false
    return true
  }

  /** The level left waiting for the next turn becomes the session's (with the project's current limits). */
  private applyNextPermission(sessionId: string, runtime: Runtime | null): Promise<void> {
    return this.withPermissionLock(sessionId, () => this.applyNextNow(sessionId, runtime))
  }

  private async applyNextNow(sessionId: string, runtime: Runtime | null): Promise<void> {
    const pending = this.rows.get(sessionId)?.permission_next as PermissionLevel | null | undefined
    if (!pending) return
    const project = this.projects.get(this.mustRow(sessionId).project_id)
    const settings = project ? await loadProjectSettings(project.path) : null
    const level = clampPermission(pending, settings?.agents.permissionsMax ?? null)
    // The agent recreated in the meantime starts from the old level: it is aligned.
    let failure: Error | null = null
    if (runtime) await runtime.adapter.setPermission(level).catch((error: Error) => (failure = error))
    if (!this.rows.has(sessionId)) return
    // Rejected: the row keeps the current level, no false level.
    if (failure) {
      this.updateRow(sessionId, { permission_next: null })
      this.noticeError(sessionId, t('Could not change the permission level: {message}', { message: (failure as Error).message }))
      this.emitSummary(sessionId)
      return
    }
    this.updateRow(sessionId, { permission: level, permission_next: null })
    this.browserAgent.permissionChanged(sessionId)
    this.emitSummary(sessionId)
  }

  private expireRequest(sessionId: string, requestId: string): void {
    const runtime = this.runtimes.get(sessionId)
    const pending = runtime?.pending.get(requestId)
    runtime?.pending.delete(requestId)
    const item = this.liveItems.get(sessionId)?.get(requestId)
    if (item?.kind === 'request' && item.state === 'open') {
      this.upsertItem(sessionId, { ...item, state: 'expired', resolution: t('Expired') })
      this.attention({ kind: 'resolved', sessionId, itemId: requestId })
    }
    pending?.resolve({ optionId: 'deny', message: t('The request expired.') })
    if (runtime && runtime.pending.size === 0 && this.rows.get(sessionId)?.run_state === 'waiting') {
      this.updateRow(sessionId, { run_state: runtime.adapter.isRunning ? 'running' : 'idle' })
      this.emitSummary(sessionId)
    }
  }

  private async onTurnEnd(
    sessionId: string,
    result: TurnResult,
    snap: { runtime: Runtime; turnId: string; turnStart: string | null; counts: Runtime['turnCounts']; interrupting: boolean; implicit: boolean; agents: number; requests: number; endedAt: number }
  ): Promise<void> {
    const { runtime } = snap
    const row = this.rows.get(sessionId)
    if (!row || this.runtimes.get(sessionId) !== runtime) return
    const { turnId, turnStart } = snap
    // An interruption we requested also holds if the agent replies with an error (ACP on cancel).
    const wasInterrupting = snap.interrupting
    // Turn born from advice that the cross-review forwarded: it is not reviewed.
    const fromReview = this.reviewTurns.delete(snap.turnId)
    // To be read before expireRequest empties pending and before finishCommand closes the command.
    const hadRequest = runtime.pending.size > 0
    const wasCommand = !!runtime.command
    // Summary turn of a handoff: the text is read now, before anything else covers it.
    const handoff = runtime.handoff?.turnId === snap.turnId ? runtime.handoff : null
    if (handoff) runtime.handoff = null
    const handoffSummary = handoff ? (handoff.reason === 'agent' ? (handoff.summary ?? '') : this.lastAssistantText(sessionId, snap.turnId)) : ''
    // Child session: the advice is the last text of the turn, read now like the handoff summary.
    const child = !!row.parent
    const adviceText = child ? this.lastAssistantText(sessionId, snap.turnId) : ''
    for (const [requestId] of runtime.pending) this.expireRequest(sessionId, requestId)
    this.finishCommand(sessionId, runtime, result.status === 'completed' ? 'done' : result.status === 'interrupted' ? 'interrupted' : 'error', result.status === 'error' ? result.error : null)
    // Interruption or error: foreground subagents stop with the turn, background ones do not.
    if (result.status !== 'completed' && this.subagents.stopRunning(sessionId, { foregroundOnly: true })) this.emitSubagents(sessionId)
    // Safety net: "running" entries with no updates for a while and outside the set of live backgrounds are ghosts.
    const stale = this.subagents.expireStale(sessionId, STALE_AGENT_MS, runtime.adapter.liveAgentIds?.() ?? null)
    if (stale.length > 0) {
      this.emitSubagents(sessionId)
      for (const before of stale) this.trackAgentEnd(sessionId, before.id, before)
    }
    const project = this.projects.get(row.project_id)
    const cwd = this.cwdOf(row)
    let files: Extract<ChatItem, { kind: 'turn-end' }>['files'] = []
    let checkpoints: { start: string; end: string } | null = null
    if (project?.isGit && turnStart) {
      const end = await createCheckpoint(cwd, `refs/ladder/${sessionId}/${turnId}-end`, 'ladder: turn end').catch(() => null)
      if (end) {
        recordCheckpoint(this.db, { session_id: sessionId, turn_id: turnId, kind: 'end', sha: end, root: cwd, label: null, at: Date.now() })
        checkpoints = { start: turnStart, end }
        files = await changedFiles(cwd, turnStart, end).catch(() => [])
      }
    }
    // Closes any messages left streaming (for example after an interruption).
    for (const item of this.liveItems.get(sessionId)?.values() ?? []) {
      if (item.kind === 'assistant' && item.streaming && item.turnId === turnId) this.upsertItem(sessionId, { ...item, streaming: false })
      if (item.kind === 'tool' && item.status === 'running' && item.turnId === turnId)
        this.upsertItem(sessionId, { ...item, status: result.status === 'completed' ? 'done' : 'error', endedAt: Date.now() })
    }
    // Turn stopped for no reason: completed, with no commands or edits, requests, running agents or final question (Edit and Full access only).
    const stalled =
      !!this.prefs.stallHint &&
      result.status === 'completed' &&
      (row.permission === 'edit' || row.permission === 'full') &&
      !wasCommand &&
      !handoff &&
      !child &&
      !snap.implicit &&
      snap.agents === 0 &&
      snap.requests === 0 &&
      !hadRequest &&
      snap.counts.commands === 0 &&
      snap.counts.edits === 0 &&
      files.length === 0 &&
      !(this.subagents.list(sessionId) ?? []).some((a) => a.status === 'running') &&
      !/[?？]\s*$/.test(this.lastAssistantText(sessionId, turnId))
    const end = this.upsertItem(sessionId, {
      kind: 'turn-end',
      id: `${turnId}:end`,
      turnId,
      at: Date.now(),
      status: result.status,
      durationMs: result.durationMs,
      counts: snap.counts,
      ...(stalled ? { stalled: true } : {}),
      files,
      error: result.error,
      costUsd: result.costUsd,
      checkpoints
    })
    this.lastTurnIds.set(sessionId, turnId)
    // If an implicit turn has already taken its place, it is the one that holds turnId, activity and the "running" state.
    const superseded = runtime.turnId !== turnId && runtime.turnId !== null
    if (!superseded) {
      this.delegateCounts.delete(sessionId)
      runtime.turnId = null
      runtime.activity = null
      runtime.approveAll = false
    }
    this.updateRow(sessionId, {
      ...(superseded ? {} : { run_state: result.status === 'error' ? 'error' : 'idle' }),
      last_activity_seq: end.seq,
      activity_at: Date.now(),
      context:
        result.context && !((this.contextAt.get(sessionId) ?? 0) >= snap.endedAt)
          ? JSON.stringify({ ...(row.context ? (JSON.parse(row.context) as object) : {}), ...result.context })
          : row.context
    })
    this.flush()
    this.emitSummary(sessionId)
    // A background finished while the turn was closing: now that no turn is open the "Continue" wait starts.
    if (!superseded && this.agentsIdle.has(sessionId)) this.armAgentsFinished(sessionId)
    // Row already at rest: only now does the level requested mid-turn become the session's.
    if (!superseded) await this.applyNextPermission(sessionId, runtime)
    if (files.length > 0) this.notifyFsChanged(cwd)
    // The subagent notice deferred to the end of the turn merges with the turn's notification, without duplicates.
    if (result.status === 'error') this.agentsPending.delete(sessionId)
    const merged = result.status !== 'error' && !superseded && this.flushAgentsDone(sessionId, end.id)
    // A plan task does not notify on its own: the plan does (pause, end).
    const planTask = this.plans.controls(sessionId)
    if (result.status === 'error') {
      if (!planTask) this.errorAttention(sessionId, end.id, result.error ?? t('The turn stopped because of an error.'))
    } else if (result.status === 'completed' && project && !merged && !planTask && !child && !(handoff && handoffSummary)) {
      this.attention({ kind: 'turn', sessionId, projectId: project.id, projectName: project.name, itemId: end.id, durationMs: result.durationMs, title: row.title })
    }
    // Title from a small model, after the first turn completes: in the background, without waiting for it.
    if (result.status === 'completed' && !superseded && !handoff && !child) void this.autoTitle(sessionId)
    // End of a child's first turn: the parent's row goes to 'done', 'error' or 'stopped'.
    if (child) {
      const stopped = result.status === 'interrupted' || (result.status === 'error' && wasInterrupting)
      if (stopped) this.settleAdvice(sessionId, { state: 'stopped', error: null })
      else if (result.status === 'error') this.settleAdvice(sessionId, { state: 'error', error: result.error ?? t('The turn stopped because of an error.') })
      else if (!adviceText) this.settleAdvice(sessionId, { state: 'error', error: t('The agent wrote no opinion.') })
      else this.settleAdvice(sessionId, { state: 'done', text: adviceText, error: null })
      // Delegation: the child's first turn is the result of the parent's call.
      this.finishDelegation(sessionId, stopped ? 'stopped' : result.status === 'error' ? 'error' : 'completed', result.error, adviceText)
      // Entry closed: the process is no longer needed; if the user opens the child and writes, the conversation resumes with a new one.
      // A stopped delegation closes the process anyway: nobody watches it, and the parent already got the error.
      if ((!stopped || this.parentOf(row)?.role === 'delegate') && !superseded && !runtime.adapter.isRunning) this.closeRuntime(sessionId)
    }
    // Summary ready (or failed): deliver to the other agent, without holding up the end of the turn.
    if (handoff) void this.finishHandoff(sessionId, handoff, result.status === 'error' && wasInterrupting ? 'interrupted' : result.status, result.error, handoffSummary, checkpoints?.end ?? null)
    // Plan limit: limit error or 'limited' window of the session's agent. With autoSwitch the handoff starts on its own.
    // A plan task is left to the plan, which fails it and offers retry or reassign. A session started by the CLI or by an agent stays
    // where its starter waits: no switch to another session and no review turn that nobody waits for.
    const started = !!row.origin
    let switching = false
    if (!child && !planTask && !started && !handoff && !superseded && !wasInterrupting && result.status !== 'interrupted') {
      const hit = this.limitHit(row, result)
      if (hit) switching = await this.onLimit(sessionId, turnId, hit).catch(() => false)
    }
    // Cross-review: turn ended with changes, not a child's nor born from advice forwarded by the review.
    if (!child && !planTask && !started && !handoff && !superseded && !fromReview && !switching && result.status === 'completed' && files.length > 0) void this.startCrossReview(sessionId, files).catch(() => undefined)
    // A plan task reports its outcome to the runner (any correction is queued and sent below).
    if (this.plans.isTask(sessionId)) await this.plans.onTurnEnd(sessionId, { status: result.status, error: result.error }).catch(() => undefined)

    // Inserted messages not yet merged into a turn run on their own (implicit turn, already or about to be open):
    // the queue restarts at the end of that turn.
    if (superseded || runtime.adapter.isRunning || runtime.exited) return
    // Restart requested mid-turn: now that the work is finished; the first queued message already starts with the new process.
    if (this.restartAfterTurn.has(sessionId) && this.runtimes.get(sessionId) === runtime && !this.agentBusy(sessionId, runtime, 1)) {
      this.restartAfterTurn.delete(sessionId)
      this.closeRuntime(sessionId)
      this.noticeInfo(sessionId, t('Agent restarted. The next message continues the conversation with settings and MCP servers loaded again.'))
      this.emitSummary(sessionId)
    }
    // Handoff succeeded: the origin queue stays there (the other agent works in the same folder) until the user delivers it.
    if (handoff && result.status === 'completed' && handoffSummary) return
    // Automatic plan-limit handoff: queued messages stay in the origin session, as after any handoff.
    if (switching) return
    const queue = JSON.parse(this.mustRow(sessionId).queue) as QueuedMessage[]
    const next = queue.shift()
    if (next && (result.status !== 'error' || wasInterrupting)) {
      // The session keeps its place for the messages you already queued.
      this.updateRow(sessionId, { queue: JSON.stringify(queue) })
      try {
        await this.startTurn(sessionId, next.text, next.attachments ?? [])
      } catch (error) {
        // The message did not start: it goes back to the head of the queue and the session does not stay "running".
        const current = JSON.parse(this.mustRow(sessionId).queue) as QueuedMessage[]
        current.unshift(next)
        // After a restart the turn started (or tried to) on a new runtime: that one is fixed, not the old closed one.
        const live = this.runtimes.get(sessionId) ?? runtime
        if (!live.adapter.isRunning) {
          live.turnId = null
          live.activity = null
        }
        this.updateRow(sessionId, { queue: JSON.stringify(current), ...(live.adapter.isRunning ? {} : { run_state: 'idle' }) })
        this.emitSummary(sessionId)
        this.noticeError(sessionId, (error as Error).message)
      }
    }
  }

  // ── Switch to… ────────────────────────────────────────────────────

  private handoffFromOf(row: SessionRow): SessionSummary['handoffFrom'] {
    try {
      return row.handoff_from ? (JSON.parse(row.handoff_from) as { sessionId: string; agent: AgentId }) : null
    } catch {
      return null
    }
  }

  /** Writes a new session to the database and memory (createSession and the destination session of a handoff). */
  private insertSession(row: SessionRow): void {
    this.db
      .prepare(
        `insert into sessions (id, project_id, title, agent, model, effort, permission, created_at, updated_at, mode, command, cwd, worktree, activity_at, source, title_source, profile_id, handoff_from, parent, origin)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.project_id, row.title, row.agent, row.model, row.effort, row.permission, row.created_at, row.updated_at, row.mode, row.command, row.cwd, row.worktree, row.activity_at, row.source, row.title_source, row.profile_id, row.handoff_from, row.parent, row.origin)
    this.rows.set(row.id, row)
  }

  /** The destination agent is allowed by the project ([agents] allowed), known and available. */
  private assertHandoffAgent(settings: ProjectSettings, agent: AgentId): void {
    if (settings.agents.allowed.length && !settings.agents.allowed.includes(agent)) {
      throw new Error(t('{agent} is not allowed in this project (.ladder/settings.toml, [agents] allowed).', { agent: this.agentName(agent) }))
    }
    const status = this.agents.get(agent)
    if (!status) throw new Error(t('Unknown agent: add it in Settings → Agents.'))
    if (!status.available) throw new Error(status.error ?? t('{agent} is not available.', { agent: status.name }))
  }

  /** Opens the turn in which the current agent writes the summary; the rest (delivery) happens at the end of the turn in finishHandoff. */
  private async startHandoff(command: Extract<HostCommand, { type: 'session.handoff' }>): Promise<void> {
    const { sessionId, agent } = command
    const row = this.mustRow(sessionId)
    const busy = () => new Error(t('Wait for the session to finish before handing it over.'))
    if (row.mode === 'terminal') throw new Error(t('A terminal session cannot be handed over.'))
    if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
    if (this.isBusy(sessionId) || row.handoff || this.handoffStarting.has(sessionId) || (row.run_state !== 'idle' && row.run_state !== 'error')) throw busy()
    if (agent === row.agent) throw new Error(t('The session already uses {agent}: pick a different agent.', { agent: this.agentName(agent) }))
    const project = this.mustProject(row.project_id)
    // Reserved synchronously: a second request arriving during the awaits below finds the handoff already in progress.
    this.handoffStarting.add(sessionId)
    try {
      this.assertHandoffAgent(await loadProjectSettings(project.path), agent)
      const note = command.note?.trim() || null
      const text = await renderHandoffPrompt(project.path, { agent: this.agentName(agent), note })
      // After the awaits the session may have started working or been archived.
      if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
      if (this.isBusy(sessionId) || this.mustRow(sessionId).handoff || this.mustRow(sessionId).run_state === 'running') throw busy()
      await this.startTurn(sessionId, text, [], null, {
        rows: (turnId) => {
          const run: HandoffRun = { itemId: `${turnId}:handoff-out`, turnId, agent, model: command.model ?? null, effort: command.effort ?? null, note }
          this.upsertItem(sessionId, { kind: 'handoff', id: run.itemId, turnId, at: Date.now(), direction: 'out', agent, peerSessionId: null, state: 'summarizing', note, summary: null, checkpoint: null, files: [], error: null })
          this.updateRow(sessionId, { handoff: JSON.stringify(run) })
          this.saveRun(run)
          return run
        }
      })
    } catch (error) {
      // The turn did not start: the 'out' row does not stay 'summarizing'.
      const run = this.mustRow(sessionId).handoff
      if (run) {
        const parsed = JSON.parse(run) as HandoffRun
        const runtime = this.runtimes.get(sessionId)
        if (runtime?.handoff?.itemId === parsed.itemId) runtime.handoff = null
        this.failHandoff(sessionId, parsed, 'error', (error as Error).message)
        this.restoreAfterFailedStart(sessionId)
      }
      throw error
    } finally {
      this.handoffStarting.delete(sessionId)
    }
  }

  /** Updates the 'out' row of a handoff (if still there). */
  private patchHandoffItem(sessionId: string, itemId: string, patch: Partial<Extract<ChatItem, { kind: 'handoff' }>>): void {
    if (!this.rows.has(sessionId)) return
    const item = this.loadItems(sessionId).find((i) => i.id === itemId)
    if (item?.kind !== 'handoff') return
    this.upsertItem(sessionId, { ...item, ...patch })
    this.flush()
  }

  /** Updates a limit card (if still there). */
  private patchLimitItem(sessionId: string, itemId: string, patch: Partial<LimitRow>): void {
    if (!this.rows.has(sessionId)) return
    const item = this.itemById(sessionId, itemId)
    if (item?.kind !== 'limit') return
    this.upsertItem(sessionId, { ...item, ...patch })
    this.flush()
  }

  /**
   * Handoff failed: the 'out' row goes to 'error' or 'interrupted' with the reason; no destination session.
   * The row is always 'resumable' (with a saved summary it is delivered again, without one it is requested); a limit card goes back to proposed.
   */
  private failHandoff(sessionId: string, run: HandoffRun, state: 'error' | 'interrupted', error: string): void {
    this.handoffStops.delete(run.itemId)
    this.returnLinks.delete(sessionId)
    this.patchHandoffItem(sessionId, run.itemId, { state, error, peerSessionId: null, resumable: true })
    if (run.limitItemId) this.patchLimitItem(sessionId, run.limitItemId, { state: 'proposed', automatic: false, peerSessionId: null, error })
    if (this.rows.has(sessionId)) {
      this.updateRow(sessionId, { handoff: null })
      this.emitSummary(sessionId)
    }
  }

  /** End of the summary turn: checks the outcome, gathers files and checkpoint and delivers to the other agent. Never throws. */
  private async finishHandoff(sessionId: string, run: HandoffRun, status: TurnResult['status'], error: string | null, summary: string, checkpoint: string | null): Promise<void> {
    const delivered = await this.deliverFinished(sessionId, run, status, error, summary, checkpoint)
    // Handoff failed: the queue the summary turn had held back restarts.
    if (!delivered && this.rows.has(sessionId) && !this.isGone(sessionId)) this.startFirstQueued(sessionId)
  }

  private async deliverFinished(sessionId: string, run: HandoffRun, status: TurnResult['status'], error: string | null, summary: string, checkpoint: string | null): Promise<boolean> {
    const fail = (state: 'error' | 'interrupted', text: string): false => (this.failHandoff(sessionId, run, state, text), false)
    if (status === 'interrupted') return fail('interrupted', t('The handoff was interrupted.'))
    if (status === 'error') return fail('error', error ?? t('The turn stopped because of an error.'))
    if (!summary) return fail('error', t('The agent wrote no summary. Nothing was handed over.'))
    if (!this.rows.has(sessionId) || this.isGone(sessionId)) return fail('interrupted', t('The handoff was interrupted.'))
    // The summary is saved right away, before files and delivery: a kill during delivery does not lose it.
    this.patchHandoffItem(sessionId, run.itemId, { summary, checkpoint })
    return this.deliverSaved(sessionId, run, summary, checkpoint)
  }

  /** Delivers a summary already saved on the 'out' row (end of the summary turn, resume, plan-limit handoff). Never throws. */
  private async deliverSaved(sessionId: string, run: HandoffRun, summary: string, checkpoint: string | null): Promise<boolean> {
    const fail = (state: 'error' | 'interrupted', text: string): false => (this.failHandoff(sessionId, run, state, text), false)
    try {
      const row = this.mustRow(sessionId)
      if (this.isGone(sessionId)) return fail('interrupted', t('The handoff was interrupted.'))
      const files = await this.sessionFiles(row, checkpoint)
      if (this.isGone(sessionId)) return fail('interrupted', t('The handoff was interrupted.'))
      if (this.handoffStops.delete(run.itemId)) return fail('interrupted', t('The handoff was stopped.'))
      this.patchHandoffItem(sessionId, run.itemId, { files })
      const peerId = await this.deliverHandoff(row, run, summary, files, checkpoint)
      this.patchHandoffItem(sessionId, run.itemId, { state: 'done', peerSessionId: peerId, error: null, resumable: false })
      this.updateRow(sessionId, { handoff: null })
      this.handoffStops.delete(run.itemId)
      this.db.prepare('delete from kv where key = ?').run(`handoff-run:${run.itemId}`)
      // Return requested by a reset card, or plan-limit handoff: the cards follow the outcome.
      const link = this.returnLinks.get(sessionId)
      if (link) {
        this.returnLinks.delete(sessionId)
        this.patchLimitItem(sessionId, link, { state: 'returned', peerSessionId: peerId })
      }
      if (run.limitItemId) {
        this.patchLimitItem(sessionId, run.limitItemId, { state: 'switched', peerSessionId: peerId, error: null })
        this.watchLimit(sessionId, run.limitItemId, peerId)
      }
      this.emitSummary(sessionId)
      return true
    } catch (e) {
      if (!this.rows.has(sessionId)) return false
      // Stopped by the user or archived during delivery: it is an interruption, not an error.
      if (this.handoffStops.delete(run.itemId)) return fail('interrupted', t('The handoff was stopped.'))
      if (this.isGone(sessionId)) return fail('interrupted', t('The handoff was interrupted.'))
      const message = e instanceof Error ? e.message : String(e)
      // The summary existed and the end-of-turn notification was skipped: the delivery failure still goes to whoever is not watching.
      this.errorAttention(sessionId, run.itemId, message)
      return fail('error', message)
    }
  }

  /** startTurn failed after opening the turn: the session does not stay 'running' (as at end of turn). */
  private restoreAfterFailedStart(sessionId: string): void {
    const live = this.runtimes.get(sessionId)
    if (live && !live.adapter.isRunning) {
      live.turnId = null
      live.activity = null
      live.handoff = null
    }
    if (this.rows.get(sessionId)?.run_state === 'running' && !live?.adapter.isRunning) this.updateRow(sessionId, { run_state: 'idle' })
    this.emitSummary(sessionId)
  }

  /**
   * Files changed by the session since its first checkpoint (the same starting point as the diff 'session' scope) up to the
   * handoff checkpoint. If the session was born from a handoff, it starts from the first session of the chain in the same
   * folder: the receiver sees all the work, not just the last stretch.
   */
  private async sessionFiles(row: SessionRow, checkpoint: string | null): Promise<Extract<ChatItem, { kind: 'handoff' }>['files']> {
    const project = this.projects.get(row.project_id)
    if (!project?.isGit || !checkpoint) return []
    const cwd = this.cwdOf(row)
    const chain = [row.id]
    for (let current: SessionRow | undefined = row; current; ) {
      const from = this.handoffFromOf(current)
      const next: SessionRow | undefined = from ? this.rows.get(from.sessionId) : undefined
      if (!next || chain.includes(next.id) || this.cwdOf(next) !== cwd) break
      chain.push(next.id)
      current = next
    }
    const first = this.db
      .prepare(`select sha from checkpoints where session_id in (${chain.map(() => '?').join(',')}) and kind = 'start' order by at limit 1`)
      .get(...chain) as { sha: string } | undefined
    if (!first) return []
    return changedFiles(cwd, first.sha, checkpoint).catch(() => [])
  }

  /** The origin session to go back to: born from a handoff, has the requested agent, is not archived or working. */
  private returnTarget(row: SessionRow, agent: AgentId): SessionRow | null {
    const from = this.handoffFromOf(row)
    const target = from ? this.rows.get(from.sessionId) : undefined
    if (!target || target.agent !== agent || target.mode !== 'chat' || target.project_id !== row.project_id || this.cwdOf(target) !== this.cwdOf(row)) return null
    if (target.archived || this.isGone(target.id) || this.isBusy(target.id) || (target.run_state !== 'idle' && target.run_state !== 'error')) return null
    return target
  }

  /** New destination session: same folder and worktree as the origin (no new worktree or setup). */
  private async createLinkedSession(from: SessionRow, run: HandoffRun, settings: ProjectSettings): Promise<SessionRow> {
    const row = this.derivedRow(from, {
      agent: run.agent,
      model: run.model,
      effort: run.effort,
      permission: clampPermission((run.permission ?? from.permission) as PermissionLevel, settings.agents.permissionsMax),
      title: from.title,
      // The title is the origin's: no automatic generation changes it.
      titleSource: from.title_source === 'provisional' ? 'generated' : from.title_source,
      handoffFrom: JSON.stringify({ sessionId: from.id, agent: from.agent }),
      parent: null
    })
    this.insertSession(row)
    this.emitSummary(row.id)
    return row
  }

  /** Delivers the summary: goes back to the origin session or creates a new one, and starts the turn there with the 'in' row. Returns the destination session. */
  private async deliverHandoff(from: SessionRow, run: HandoffRun, summary: string, files: Extract<ChatItem, { kind: 'handoff' }>['files'], checkpoint: string | null): Promise<string> {
    const project = this.mustProject(from.project_id)
    const settings = await loadProjectSettings(project.path)
    this.assertHandoffAgent(settings, run.agent)
    const text = run.prompt ?? (await renderHandoffReceive(project.path, { fromAgent: this.agentName(from.agent), summary, note: run.note, files, checkpoint, branch: this.branchOf(from), report: run.reason === 'agent', ...(run.request ? { request: run.request } : {}) }))
    // After the awaits the origin session may have been archived or removed, or the handoff stopped by the user.
    if (this.isGone(from.id)) throw new Error(t('The handoff was interrupted.'))
    if (this.handoffStops.has(run.itemId)) throw new Error(t('The handoff was stopped.'))
    const existing = this.returnTarget(from, run.agent)
    const target = existing ?? (await this.createLinkedSession(from, run, settings))
    try {
      // "Implement with…": going back to a session idle in Plan, the level goes up as in session.permission.set.
      if (existing && run.permission && existing.permission === 'plan') await this.setPermission(existing.id, run.permission)
      await this.startTurn(target.id, text, [], null, {
        rows: (turnId) => {
          // The destination session has its own turn: from here the 'out' row knows it.
          this.patchHandoffItem(from.id, run.itemId, { peerSessionId: target.id })
          this.upsertItem(target.id, { kind: 'handoff', id: `${run.itemId}:in`, turnId, at: Date.now(), direction: 'in', ...(run.reason ? { reason: run.reason } : {}), agent: from.agent as AgentId, peerSessionId: from.id, state: 'done', note: run.note, summary, checkpoint, files, error: null })
        }
      })
    } catch (error) {
      // A new session left without a turn is useless: it is archived (the worktree belongs to the origin, not touched).
      if (!existing) await this.archive(target.id, { cleanup: false }).catch(() => undefined)
      else {
        // The 'in' row was already written: consistent with the 'out' row, it becomes 'error'.
        this.patchHandoffItem(target.id, `${run.itemId}:in`, { state: 'error', error: error instanceof Error ? error.message : String(error) })
        this.restoreAfterFailedStart(target.id)
      }
      throw error
    }
    return target.id
  }

  // ── Stop, resume, reassign ──────────────────────────────────────

  /** The handoff as it started (permission, model, effort, prompt): needed for a faithful resume after an error or a restart. */
  private saveRun(run: HandoffRun): void {
    this.kvSet(`handoff-run:${run.itemId}`, JSON.stringify(run))
  }

  private savedRun(itemId: string): HandoffRun | null {
    try {
      const raw = this.kvGet(`handoff-run:${itemId}`)
      return raw ? (JSON.parse(raw) as HandoffRun) : null
    } catch {
      return null
    }
  }

  /**
   * Stops a handoff: 'pending' requested by the agent (cancelled, the turn continues), 'summarizing' with the summary turn
   * (interrupts it), or the delivery already in progress (stops before starting the destination session).
   */
  private async stopHandoff(sessionId: string, itemId: string): Promise<void> {
    this.mustRow(sessionId)
    const item = this.itemById(sessionId, itemId)
    if (item?.kind !== 'handoff' || item.direction !== 'out') throw new Error(t('Handoff not found.'))
    if (item.state !== 'summarizing' && item.state !== 'pending') return
    const runtime = this.runtimes.get(sessionId)
    const run = runtime?.handoff?.itemId === itemId ? runtime.handoff : null
    if (run && runtime && item.state === 'pending') {
      // Requested by the agent and not started yet: cancelled, the turn no longer delivers it.
      runtime.handoff = null
      this.failHandoff(sessionId, run, 'interrupted', t('The handoff was stopped.'))
      return
    }
    if (run) {
      // Summary turn in progress: the interruption closes it and finishHandoff marks it 'interrupted'; if the turn closes 'completed' anyway, the delivery stops.
      this.handoffStops.add(itemId)
      await this.interrupt(sessionId)
      return
    }
    // Delivery in progress: it stops at the checks before starting the destination session.
    this.handoffStops.add(itemId)
  }

  /**
   * Resumes a resumable 'out' row, even with another agent (reassign). Saved summary: delivers right away, without
   * asking for it again; otherwise reopens the summary turn. The summary turn is text only: no command is repeated.
   */
  private async resumeHandoff(command: Extract<HostCommand, { type: 'session.handoff.resume' }>): Promise<void> {
    const { sessionId, itemId } = command
    const row = this.mustRow(sessionId)
    const item = this.itemById(sessionId, itemId)
    if (item?.kind !== 'handoff' || item.direction !== 'out' || !item.resumable || (item.state !== 'interrupted' && item.state !== 'error')) throw new Error(t('This handoff cannot be resumed.'))
    if (row.mode === 'terminal') throw new Error(t('A terminal session cannot be handed over.'))
    if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
    const agent = command.agent ?? item.agent
    const summary = item.summary?.trim() ?? ''
    if (!summary) {
      // No saved summary: new summary turn (the old row stays in the history, no longer resumable).
      this.patchHandoffItem(sessionId, itemId, { resumable: false })
      try {
        await this.startHandoff({ type: 'session.handoff', sessionId, agent, model: command.model ?? null, effort: command.effort ?? null, note: item.note })
      } catch (error) {
        this.patchHandoffItem(sessionId, itemId, { resumable: true })
        throw error
      }
      return
    }
    const busy = () => new Error(t('Wait for the session to finish before handing it over.'))
    if (this.isBusy(sessionId) || row.handoff || this.handoffStarting.has(sessionId) || (row.run_state !== 'idle' && row.run_state !== 'error')) throw busy()
    if (agent === row.agent) throw new Error(t('The session already uses {agent}: pick a different agent.', { agent: this.agentName(agent) }))
    const project = this.mustProject(row.project_id)
    this.handoffStarting.add(sessionId)
    try {
      const settings = await loadProjectSettings(project.path)
      this.assertHandoffAgent(settings, agent)
      if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
      if (this.isBusy(sessionId) || this.mustRow(sessionId).handoff || this.mustRow(sessionId).run_state === 'running') throw busy()
      const reason = item.reason && item.reason !== 'handoff' ? item.reason : undefined
      // The handoff as it started: chosen permission, `implement` prompt, half-done request, model and effort (if the agent does not change).
      const saved = this.savedRun(itemId)
      const same = agent === (saved?.agent ?? item.agent)
      const run: HandoffRun = {
        itemId,
        turnId: item.turnId,
        agent,
        model: command.model ?? (same ? (saved?.model ?? null) : null),
        effort: command.effort ?? (same ? (saved?.effort ?? null) : null),
        note: item.note,
        ...(reason ? { reason } : {}),
        summary,
        ...(saved?.prompt ? { prompt: saved.prompt } : {}),
        ...(saved?.permission ? { permission: saved.permission } : reason === 'implement' ? { permission: clampPermission('edit', settings.agents.permissionsMax) } : {}),
        ...(saved?.request ? { request: saved.request } : {}),
        ...(reason === 'limit' && itemId.endsWith(':handoff') ? { limitItemId: itemId.slice(0, -':handoff'.length) } : {})
      }
      this.patchHandoffItem(sessionId, itemId, { agent, state: 'pending', error: null, resumable: false, peerSessionId: null })
      this.updateRow(sessionId, { handoff: JSON.stringify(run) })
      this.saveRun(run)
      this.emitSummary(sessionId)
      const delivered = await this.deliverSaved(sessionId, run, summary, item.checkpoint)
      if (!delivered) {
        const out = this.itemById(sessionId, itemId)
        throw new Error(out?.kind === 'handoff' && out.error ? out.error : t('The handoff was interrupted.'))
      }
    } finally {
      this.handoffStarting.delete(sessionId)
    }
  }

  // ── Plan limit and automatic handoff ─────────────────────────────

  /** Usage state of the agent for the profile the session works with. */
  private usageOf(row: SessionRow): { windows: UsageWindow[]; at: number } {
    const profileId = customProfileId(row.profile_id)
    const status = profileId ? this.profileAgents.get(profileId) : this.agents.get(row.agent)
    return { windows: status?.usage ?? [], at: status?.usageAt ?? 0 }
  }

  /** The agent is at its limit for the profile a new session of this project would use (windows reserved to a model excluded). */
  private agentLimited(agent: AgentId, projectId: string): boolean {
    const profileId = customProfileId(this.profiles.resolve(agent, projectId) ?? undefined)
    const status = profileId ? this.profileAgents.get(profileId) : this.agents.get(agent)
    return (status?.usage ?? []).some((w) => windowLimited(w) && !w.model)
  }

  /**
   * Is the finished turn a plan limit? Three ways: the dev simulation (LADDER_SIMULATE_LIMIT), a usage window
   * of the agent in 'limited' when the turn ended in error, or a Claude or Codex limit error (LIMIT_ERROR).
   * One report per window: until the reset passes no other is written.
   */
  private limitHit(row: SessionRow, result: TurnResult): { name: string; key: string; resetsAt: number | null } | null {
    let hit: { name: string; key: string; resetsAt: number | null } | null = null
    if (this.simulatedLimit.delete(row.agent)) {
      hit = { name: t('Simulated limit'), key: 'simulated', resetsAt: Math.round(Date.now() / 1000) + (Number(process.env.LADDER_SIMULATE_LIMIT_SECONDS) || 90) }
    } else if (result.status === 'error') {
      const model = row.model?.toLowerCase() ?? ''
      const limited = this.usageOf(row).windows.filter((w) => windowLimited(w) && (!w.model || model.includes(w.model.toLowerCase())))
      // The one that resets last is the window that really blocks.
      const binding = [...limited].sort((a, b) => (b.resetsAt ?? Infinity) - (a.resetsAt ?? Infinity))[0]
      if (binding) hit = { name: windowName(binding), key: binding.key, resetsAt: binding.resetsAt }
      else if (LIMIT_ERROR.test(result.error ?? '')) {
        const epoch = /\|(\d{10})\b/.exec(result.error ?? '')
        hit = { name: t('Usage limit'), key: 'error', resetsAt: epoch ? Number(epoch[1]) : null }
      }
    }
    if (!hit) return null
    const key = `${row.id}\0${row.agent}\0${hit.key}`
    if ((this.limitSeen.get(key) ?? 0) > Date.now()) return null
    this.limitSeen.set(key, hit.resetsAt ? hit.resetsAt * 1000 : Date.now() + 60 * 60_000)
    return hit
  }

  /**
   * Limit reached at end of turn: writes the 'reached' card with the proposed agent (the project's autoSwitch or the first allowed and
   * available one of another provider). With autoSwitch the handoff starts on its own (after a short pause to stop it), unless
   * the target is also at its limit: then only the proposal stays, with the reason. True if an automatic handoff starts.
   */
  private async onLimit(sessionId: string, turnId: string, hit: { name: string; resetsAt: number | null }): Promise<boolean> {
    const row = this.rows.get(sessionId)
    const project = row && this.projects.get(row.project_id)
    if (!row || !project || row.mode !== 'chat' || this.isGone(sessionId)) return false
    const settings = await loadProjectSettings(project.path)
    if (this.isGone(sessionId)) return false
    const preferred = settings.agents.autoSwitch && settings.agents.autoSwitch !== row.agent ? settings.agents.autoSwitch : null
    let target: AgentId | null = null
    let error: string | null = null
    if (preferred) {
      target = preferred
      try {
        this.assertHandoffAgent(settings, preferred)
        if (this.agentLimited(preferred, row.project_id)) error = t('{agent} has reached its limit too, so switching would not help. Wait for the reset or pick another agent.', { agent: this.agentName(preferred) })
      } catch (e) {
        error = (e as Error).message
      }
    } else {
      for (const status of this.agents.values()) {
        if (status.agent === row.agent || !status.available || (settings.agents.allowed.length && !settings.agents.allowed.includes(status.agent)) || this.agentLimited(status.agent, row.project_id)) continue
        target = status.agent
        break
      }
      if (!target) error = t('No other agent is available to continue.')
    }
    const automatic = !!settings.agents.autoSwitch && !!preferred && !error
    const itemId = `${turnId}:limit`
    this.upsertItem(sessionId, { kind: 'limit', id: itemId, turnId, at: Date.now(), phase: 'reached', agent: row.agent as AgentId, window: hit.name, resetsAt: hit.resetsAt, target, state: automatic ? 'switched' : 'proposed', peerSessionId: null, automatic, error })
    this.flush()
    if (!automatic || !target) return false
    // If it does not start (agent no longer available, session busy...) the card stays a proposal with the reason.
    void this.switchOnLimit(sessionId, itemId, target, true).catch((e: Error) => this.patchLimitItem(sessionId, itemId, { state: 'proposed', automatic: false, peerSessionId: null, error: e.message }))
    return true
  }

  /**
   * Summary of a plan-limit handoff, composed by Ladder (the agent at its limit cannot write it): the conversation.
   * The last unfinished request goes apart (`request`), delivered in its block as a user request to complete.
   */
  private limitSummary(row: SessionRow, items: ChatItem[], window: string): { summary: string; request: string } {
    const lastUser = [...items].reverse().find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && Boolean(i.text.trim()))
    const request = lastUser && items.some((i) => i.kind === 'turn-end' && i.turnId === lastUser.turnId && i.status !== 'completed') ? lastUser.text.trim().slice(0, 4_000) : ''
    const excerpt = conversationExcerpt(items)
    const summary = [t('{agent} reached its plan limit ({window}) and could not write a handoff summary, so Ladder composed this one from the conversation and the files.', { agent: this.agentName(row.agent), window }), excerpt ? `## ${t('Conversation so far')}\n\n${excerpt}` : '']
      .filter(Boolean)
      .join('\n\n')
    return { summary, request }
  }

  /** Plan-limit handoff (reason 'limit'): no summary turn, Ladder composes the summary. With `automatic` it waits a moment, so it can be stopped. */
  private async switchOnLimit(sessionId: string, limitItemId: string, agent: AgentId, automatic: boolean): Promise<void> {
    const row = this.mustRow(sessionId)
    const limit = this.itemById(sessionId, limitItemId)
    if (limit?.kind !== 'limit') throw new Error(t('Limit card not found.'))
    if (row.mode === 'terminal') throw new Error(t('A terminal session cannot be handed over.'))
    if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
    const busy = () => new Error(t('Wait for the session to finish before handing it over.'))
    // The automatic handoff starts from the end of the turn (still open for the host): the check applies after the pause.
    if ((!automatic && (this.isBusy(sessionId) || (row.run_state !== 'idle' && row.run_state !== 'error'))) || row.handoff || this.handoffStarting.has(sessionId)) throw busy()
    if (agent === row.agent) throw new Error(t('The session already uses {agent}: pick a different agent.', { agent: this.agentName(agent) }))
    const project = this.mustProject(row.project_id)
    this.handoffStarting.add(sessionId)
    try {
      this.assertHandoffAgent(await loadProjectSettings(project.path), agent)
      if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
      const checkpoint = (this.db.prepare(`select sha from checkpoints where session_id = ? and kind = 'end' order by at desc limit 1`).get(sessionId) as { sha: string } | undefined)?.sha ?? null
      const { summary, request } = this.limitSummary(row, this.loadItems(sessionId), limit.window)
      const itemId = `${limitItemId}:handoff`
      const run: HandoffRun = { itemId, turnId: 'system', agent, model: null, effort: null, note: null, reason: 'limit', summary, limitItemId, ...(request ? { request } : {}) }
      this.upsertItem(sessionId, { kind: 'handoff', id: itemId, turnId: 'system', at: Date.now(), reason: 'limit', direction: 'out', agent, peerSessionId: null, state: 'pending', note: null, summary, checkpoint, files: [], error: null })
      this.patchLimitItem(sessionId, limitItemId, { state: 'switched', target: agent, automatic, peerSessionId: null, error: null })
      this.updateRow(sessionId, { handoff: JSON.stringify(run) })
      this.saveRun(run)
      this.flush()
      this.emitSummary(sessionId)
      if (automatic) {
        await new Promise((r) => setTimeout(r, LIMIT_SWITCH_GRACE_MS))
        // Meanwhile the user started writing again: the handoff no longer makes sense.
        if (!this.handoffStops.has(itemId) && !this.isGone(sessionId) && (this.isBusy(sessionId) || this.mustRow(sessionId).run_state === 'running')) this.handoffStops.add(itemId)
      }
      const delivered = await this.deliverSaved(sessionId, run, summary, checkpoint)
      if (!delivered) {
        const out = this.itemById(sessionId, itemId)
        throw new Error(out?.kind === 'handoff' && out.error ? out.error : t('The handoff was interrupted.'))
      }
    } finally {
      this.handoffStarting.delete(sessionId)
    }
  }

  /** Answer to a limit card: hands off to another agent ('reached'), goes back to the previous one ('reset') or closes. */
  private async respondLimit(command: Extract<HostCommand, { type: 'session.limit.respond' }>): Promise<void> {
    const { sessionId, itemId, action } = command
    this.mustRow(sessionId)
    const item = this.itemById(sessionId, itemId)
    if (item?.kind !== 'limit') throw new Error(t('Limit card not found.'))
    if (item.state !== 'proposed' && item.state !== 'error') throw new Error(t('This card was already handled.'))
    if (action === 'dismiss') return this.patchLimitItem(sessionId, itemId, { state: 'dismissed', error: null })
    if (action === 'switch') {
      if (item.phase !== 'reached') throw new Error(t('Switching is only for a reached limit.'))
      const agent = command.agent ?? item.target
      if (!agent) throw new Error(t('Pick an agent to continue with.'))
      await this.switchOnLimit(sessionId, itemId, agent, false)
      return
    }
    if (item.phase !== 'reset' || !item.target) throw new Error(t('Going back is only for a limit that has reset.'))
    // Normal handoff (with summary) to the origin session: the card becomes 'returned' once delivered.
    this.returnLinks.set(sessionId, itemId)
    try {
      await this.startHandoff({ type: 'session.handoff', sessionId, agent: item.target })
    } catch (error) {
      this.returnLinks.delete(sessionId)
      throw error
    }
  }

  /** After a plan-limit handoff: watches the previous agent's window to propose going back. */
  private watchLimit(fromId: string, limitItemId: string, toId: string): void {
    const item = this.itemById(fromId, limitItemId)
    if (item?.kind !== 'limit') return
    this.limitWatches.set(limitItemId, { limitItemId, fromId, toId, agent: item.agent, window: item.window, resetsAt: item.resetsAt, at: Date.now(), checked: 0 })
    this.ensureLimitTimer()
  }

  private ensureLimitTimer(): void {
    if (this.limitTimer || this.stopped) return
    this.limitTimer = setInterval(() => this.checkLimitResets(), LIMIT_WATCH_EVERY_MS)
    this.limitTimer.unref?.()
  }

  /** After a restart: plan-limit handoffs without a reset card are watched again. */
  private restoreLimitWatches(): void {
    const rows = this.db.prepare(`select session_id, json from items where json like '%"kind":"limit"%' and json like '%"phase":"reached"%' and json like '%"state":"switched"%'`).all() as { session_id: string; json: string }[]
    for (const { session_id, json } of rows) {
      const item = JSON.parse(json) as ChatItem
      if (item.kind !== 'limit' || !item.peerSessionId || this.rows.get(item.peerSessionId)?.archived !== 0) continue
      if (this.db.prepare('select 1 from items where session_id = ? and id = ?').get(item.peerSessionId, `${item.id}:reset`)) continue
      this.limitWatches.set(item.id, { limitItemId: item.id, fromId: session_id, toId: item.peerSessionId, agent: item.agent, window: item.window, resetsAt: item.resetsAt, at: item.at, checked: 0 })
    }
    if (this.limitWatches.size) this.ensureLimitTimer()
  }

  /**
   * Reset: the window goes back to 'ok' (read after the handoff) or its resetsAt has passed → 'reset' card in the session
   * reached, proposing to go back. Without a known resetsAt usage is re-read every 10 minutes.
   */
  private checkLimitResets(): void {
    const now = Date.now()
    for (const [key, watch] of [...this.limitWatches]) {
      const to = this.rows.get(watch.toId)
      const from = this.rows.get(watch.fromId)
      // Destination or origin session archived: nothing to propose.
      if (!to || to.archived || !from || from.archived) {
        this.limitWatches.delete(key)
        continue
      }
      const passed = watch.resetsAt !== null && now >= watch.resetsAt * 1000
      const usage = this.usageOf(from)
      const same = usage.windows.find((w) => windowName(w) === watch.window)
      const back = !!same && same.state === 'ok' && usage.at > watch.at
      if (!passed && !back) {
        if (watch.resetsAt === null && now - Math.max(watch.checked, watch.at) > 10 * 60_000) {
          watch.checked = now
          void this.refreshUsage(from.agent, customProfileId(from.profile_id)).catch(() => undefined)
        }
        continue
      }
      this.limitWatches.delete(key)
      this.upsertItem(watch.toId, { kind: 'limit', id: `${watch.limitItemId}:reset`, turnId: 'system', at: now, phase: 'reset', agent: watch.agent, window: watch.window, resetsAt: watch.resetsAt, target: watch.agent, state: 'proposed', peerSessionId: watch.fromId, automatic: false, error: null })
      this.flush()
    }
    if (this.limitWatches.size === 0 && this.limitTimer) {
      clearInterval(this.limitTimer)
      this.limitTimer = null
    }
  }

  // ── Cross-review ──────────────────────────────────────────────

  /**
   * At the end of a turn with changes: if the project has `cross_review`, a read-only opinion (AdviceItem mode 'review')
   * from that agent on the diff. It does not start if the agent is the session's or if another review is still running.
   */
  private async startCrossReview(sessionId: string, files: Extract<ChatItem, { kind: 'handoff' }>['files']): Promise<void> {
    const row = this.rows.get(sessionId)
    const project = row && this.projects.get(row.project_id)
    if (!row || !project || row.mode !== 'chat' || this.isGone(sessionId)) return
    const settings = await loadProjectSettings(project.path)
    const agent = settings.agents.crossReview
    if (!agent || agent === row.agent) return
    try {
      this.assertHandoffAgent(settings, agent)
    } catch {
      return
    }
    const items = this.loadItems(sessionId)
    // A review still running: only one (the latest) waits, and starts when that one finishes.
    if (items.some((i) => i.kind === 'advice' && i.mode === 'review' && i.entries.some((e) => e.state === 'running'))) {
      this.reviewQueued.set(sessionId, files)
      return
    }
    const prompt = await renderReviewCrossPrompt(project.path, { title: row.title, branch: this.branchOf(row), files, conversation: conversationExcerpt(items) })
    // After the awaits the session may have been archived.
    if (this.isGone(sessionId)) return
    const itemId = randomUUID()
    this.upsertItem(sessionId, { kind: 'advice', id: itemId, turnId: 'system', at: Date.now(), mode: 'review', question: '', entries: [{ agent, model: null, sessionId: null, state: 'running', text: null, error: null }], forwarded: false, verdict: null })
    this.flush()
    await this.startAdvisor(row, itemId, 0, { agent }, prompt, settings, 'review')
  }

  /** Review with verdict 'serious': goes to the coordinator on its own, at most once per user message. */
  private async forwardReview(sessionId: string, itemId: string): Promise<void> {
    if (!this.rows.has(sessionId) || this.isGone(sessionId)) return
    const lastUser = [...this.loadItems(sessionId)].reverse().find((i) => i.kind === 'user')
    const key = `${sessionId}\0${lastUser?.id ?? ''}`
    if (this.reviewForwarded.has(key)) return
    this.reviewForwarded.add(key)
    await this.forwardAdvice(sessionId, itemId, null, true)
  }

  /** Project delegates for the system prompt: only if there are any and the session can delegate (same as tools, depth and read-only). */
  private async loadDelegateHint(sessionId: string): Promise<void> {
    const row = this.rows.get(sessionId)
    const project = row && this.projects.get(row.project_id)
    if (!row || !project || !this.ladderToolsFor(row)?.includes('delegate')) {
      this.delegateHints.delete(sessionId)
      return
    }
    const delegates = (await loadProjectSettings(project.path)).agents.delegates.filter((d) => this.agents.get(d.agent)?.available)
    this.delegateHints.set(sessionId, delegates.length ? delegatesHint(delegates) : null)
  }

  /** Last assistant text in the turn ('' if it wrote nothing). */
  private lastAssistantText(sessionId: string, turnId: string): string {
    let last: Extract<ChatItem, { kind: 'assistant' }> | null = null
    for (const item of this.liveItems.get(sessionId)?.values() ?? []) {
      if (item.kind === 'assistant' && item.turnId === turnId && (!last || item.seq > last.seq)) last = item
    }
    return last?.text.trim() ?? ''
  }

  // ── Ladder MCP server: handoff, delegate, report_result ─────────

  /** Read-only child session: advice and reviews always; delegations when they have the Plan level (read_only or parent in Plan). */
  private isReadOnlyRow(row: SessionRow): boolean {
    const parent = this.parentOf(row)
    return !!parent && (parent.role !== 'delegate' || row.permission === 'plan')
  }

  /** How many delegations are above the session (0 = normal session). */
  private delegationDepth(row: SessionRow): number {
    let depth = 0
    for (let cur: SessionRow | undefined = row; cur; ) {
      const parent = this.parentOf(cur)
      if (parent?.role !== 'delegate') break
      depth++
      cur = this.rows.get(parent.sessionId)
    }
    return depth
  }

  /**
   * Ladder server tools for the session, read on every request. A plan task only reports its result. Advice does not hand off or
   * delegate; a read-only delegation neither, but returns the outcome. A chat session where the user talks to the agent has them
   * all, plans and sessions started by agents included; child sessions (advice, delegations) never start plans or visible sessions.
   */
  private ladderToolsFor(row: SessionRow | undefined): LadderToolName[] | null {
    if (!row || row.mode === 'terminal' || row.archived) return null
    const parent = this.parentOf(row)
    return toolsForRole({
      planTask: this.plans.isTask(row.id),
      childRole: parent?.role ?? null,
      started: !!row.origin,
      handedOff: !!row.handoff_from,
      canDelegate: !this.isReadOnlyRow(row) && this.delegationDepth(row) < MAX_DELEGATION_DEPTH
    })
  }

  /** Agent id from what the model wrote: id, ACP id without prefix or display name. */
  private resolveAgent(input: string): AgentId | null {
    const id = input.trim()
    if (this.agents.has(id)) return id as AgentId
    const key = agentKey(id)
    if (this.agents.has(key)) return key as AgentId
    const lower = id.toLowerCase()
    for (const [agent, status] of this.agents) if (status.name.toLowerCase() === lower) return agent as AgentId
    return null
  }

  private async ladderListAgents(sessionId: string): Promise<ToolOutcome> {
    const row = this.mustRow(sessionId)
    const settings = await loadProjectSettings(this.mustProject(row.project_id).path)
    const agents = [...this.agents.values()]
      .filter((a) => a.available && (!settings.agents.allowed.length || settings.agents.allowed.includes(a.agent)))
      .map((a) => ({ id: a.agent, name: a.name, current: a.agent === row.agent, models: a.models.slice(0, 20).map((m) => ({ id: m.id, name: m.label, default: m.isDefault === true })) }))
    const delegates = settings.agents.delegates.map((d) => ({ name: d.name, agent: d.agent, model: d.model, effort: d.effort, permission: d.permission, note: d.note }))
    const text = JSON.stringify({ current: row.agent, agents, delegates, limits: { delegationsPerTurn: MAX_DELEGATIONS_PER_TURN, maxDepth: MAX_DELEGATION_DEPTH } })
    return { text }
  }

  /** handoff: 'out' row 'pending' and delivery at end of turn with the agent's summary (same path as "Switch to…", without a summary turn). */
  private async ladderHandoff(sessionId: string, args: HandoffArgs, _call: LadderCall, signal: AbortSignal): Promise<ToolOutcome> {
    const fail = (text: string): ToolOutcome => ({ text, isError: true })
    const row = this.rows.get(sessionId)
    const runtime = this.runtimes.get(sessionId)
    if (!row || !runtime?.turnId || this.isGone(sessionId)) return fail(t('The session is not working right now.'))
    if (row.parent || row.origin || row.mode !== 'chat') return fail(t('This session cannot hand its work over.'))
    if (runtime.handoff || row.handoff || this.handoffStarting.has(sessionId)) return fail(t('A handoff is already scheduled for this session.'))
    const agent = this.resolveAgent(args.agent)
    if (!agent) return fail(t('Unknown agent “{agent}”. Call list_agents to see which agents you can use.', { agent: stripControl(args.agent).slice(0, 40) }))
    if (agent === row.agent) return fail(t('The session already uses {agent}: pick a different agent.', { agent: this.agentName(agent) }))
    const turnId = runtime.turnId
    try {
      this.assertHandoffAgent(await loadProjectSettings(this.mustProject(row.project_id).path), agent)
    } catch (error) {
      return fail((error as Error).message)
    }
    const summary = stripControl(args.summary)
    const note = args.note ? stripControl(args.note) : null
    // Plan and Ask: the user confirms, with the same card as the other requests.
    if (row.permission === 'plan' || row.permission === 'ask') {
      const response = await this.openRequest(
        sessionId,
        {
          requestType: 'permission',
          toolName: 'ladder:handoff',
          title: t('Hand over to {agent}', { agent: this.agentName(agent) }),
          command: null,
          path: null,
          reason: `${t('{from} wants to continue this work with {agent} in a new session on the same folder. The handoff starts when this turn ends.', { from: this.agentName(row.agent), agent: this.agentName(agent) })} ${t('Summary written by the agent: {summary}', { summary: summary.replace(/\s+/g, ' ').slice(0, 400) })}`,
          options: [
            { id: 'allow', label: t('Approve'), kind: 'allow' },
            { id: 'deny', label: t('Deny'), kind: 'deny' }
          ],
          questions: null
        },
        signal
      )
      if (signal.aborted) return fail(t('The handoff was interrupted.'))
      if (!('optionId' in response) || response.optionId !== 'allow') return fail(t('The user declined the handoff. Keep working on the task here, or ask them what they prefer.'))
    }
    // After the wait the situation may have changed.
    const live = this.runtimes.get(sessionId)
    if (live !== runtime || live.turnId !== turnId || this.isGone(sessionId)) return fail(t('The handoff was interrupted.'))
    if (runtime.handoff || this.mustRow(sessionId).handoff) return fail(t('A handoff is already scheduled for this session.'))
    const run: HandoffRun = { itemId: `${turnId}:handoff-out`, turnId, agent, model: null, effort: null, note, reason: 'agent', summary }
    this.upsertItem(sessionId, { kind: 'handoff', id: run.itemId, turnId, at: Date.now(), reason: 'agent', direction: 'out', agent, peerSessionId: null, state: 'pending', note, summary, checkpoint: null, files: [], error: null })
    this.updateRow(sessionId, { handoff: JSON.stringify(run) })
    this.saveRun(run)
    runtime.handoff = run
    this.flush()
    this.emitSummary(sessionId)
    return { text: t('Handoff to {agent} scheduled: it starts when your turn ends, with the summary you wrote. Stop now: end your turn with one short sentence and no more tool calls.', { agent: this.agentName(agent) }) }
  }

  /** Id of the 'tool' row of the delegate MCP call in the parent (the UI links it to the child with parent.itemId). */
  private async delegateRowId(motherId: string, turnId: string, call: LadderCall): Promise<string> {
    const name = /ladder[._]{1,2}delegate$/i
    for (let attempt = 0; attempt < 5; attempt++) {
      // Claude gives the tool_use id: reliable. The others do not.
      const exact = call.toolUseId ? this.itemById(motherId, call.toolUseId) : undefined
      if (exact?.kind === 'tool' && !this.claimedToolRows.has(exact.id)) {
        this.claimedToolRows.add(exact.id)
        return exact.id
      }
      if (!call.toolUseId) {
        // Without an id: the only in-progress 'tool' row of this turn with the tool name and not already taken by another delegation.
        const open = this.loadItems(motherId).filter((i) => i.kind === 'tool' && i.turnId === turnId && i.status === 'running' && name.test(i.name) && !this.claimedToolRows.has(i.id))
        if (open.length === 1) {
          this.claimedToolRows.add(open[0].id)
          return open[0].id
        }
        if (open.length > 1) break
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    // With the tool_use id the row is that one even if it has not appeared yet (reliable: the agent says so).
    if (call.toolUseId && !this.claimedToolRows.has(call.toolUseId)) {
      this.claimedToolRows.add(call.toolUseId)
      return call.toolUseId
    }
    // Not reliable (parallel calls, agent that gives no id): the MCP request id, the 'tool' row is not linked.
    return `delegate:${call.requestId}`
  }

  private similarTask(a: string, b: string): boolean {
    const norm = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').trim()
    const [x, y] = [norm(a), norm(b)]
    if (x === y) return true
    const [short, long] = x.length <= y.length ? [x, y] : [y, x]
    return short.length >= 40 && long.includes(short)
  }

  /** delegate: child session (parent.role 'delegate') in the same folder; the call waits for the end of its first turn. */
  private async ladderDelegate(motherId: string, args: DelegateArgs, call: LadderCall, signal: AbortSignal): Promise<ToolOutcome> {
    const fail = (text: string): ToolOutcome => ({ text, isError: true })
    const mother = this.rows.get(motherId)
    const runtime = this.runtimes.get(motherId)
    if (!mother || !runtime?.turnId || this.isGone(motherId)) return fail(t('The session is not working right now.'))
    if (this.isReadOnlyRow(mother)) return fail(t('A read-only session cannot delegate.'))
    const turnId = runtime.turnId
    if (this.delegationDepth(mother) >= MAX_DELEGATION_DEPTH) return fail(t('Delegation is at most {n} levels deep: do this task yourself.', { n: MAX_DELEGATION_DEPTH }))
    const counted = this.delegateCounts.get(motherId)
    if ((counted?.turnId === turnId ? counted.n : 0) >= MAX_DELEGATIONS_PER_TURN) return fail(t('At most {n} delegations per turn: finish with the results you have or do the rest yourself.', { n: MAX_DELEGATIONS_PER_TURN }))
    const project = this.mustProject(mother.project_id)
    const settings = await loadProjectSettings(project.path)
    // The agent is an id or the name of a project delegate ([[agents.delegates]]), which carries model, effort and maximum permission.
    const preset = settings.agents.delegates.find((d) => d.name.toLowerCase() === args.agent.toLowerCase())
    const agent = preset ? preset.agent : this.resolveAgent(args.agent)
    if (!agent) return fail(t('Unknown agent “{agent}”. Call list_agents to see which agents you can use.', { agent: stripControl(args.agent).slice(0, 40) }))
    try {
      this.assertHandoffAgent(settings, agent)
    } catch (error) {
      return fail((error as Error).message)
    }
    // The same provider already has its own sub-agents: delegating to itself is pointless.
    if (agent === mother.agent) return fail(t('{agent} is your own agent: use your own subagent tool for that, and delegate only to a different agent.', { agent: this.agentName(agent) }))
    // Model: if the agent declares its models, the requested one must be among them.
    const wanted = args.model ?? preset?.model ?? null
    const known = this.agents.get(agent)?.models ?? []
    if (wanted && known.length && !known.some((m) => m.id === wanted || m.label.toLowerCase() === wanted.toLowerCase())) {
      return fail(t('{agent} has no model “{model}”. Available models: {models}.', { agent: this.agentName(agent), model: stripControl(wanted).slice(0, 60), models: known.slice(0, 12).map((m) => m.id).join(', ') }))
    }
    // No bouncing: along the chain, going back to the agent that delegated with the same task.
    for (let cur: SessionRow | undefined = mother; cur; ) {
      const parent = this.parentOf(cur)
      if (parent?.role !== 'delegate') break
      const up = this.rows.get(parent.sessionId)
      const task = this.delegations.get(cur.id)?.task
      if (up && task && up.agent === agent && this.similarTask(args.prompt, task)) return fail(t('{agent} delegated this same task to you: do it yourself instead of sending it back.', { agent: this.agentName(agent) }))
      cur = up
    }
    // After the awaits the turn may have ended or the session been archived.
    if (this.runtimes.get(motherId) !== runtime || runtime.turnId !== turnId || this.isGone(motherId) || signal.aborted) return fail(t('The delegation was stopped.'))
    // Permission: never higher than the parent's; read_only and the project delegate lower it.
    const lower = (a: PermissionLevel, b: PermissionLevel): PermissionLevel => (LEVELS.indexOf(a) <= LEVELS.indexOf(b) ? a : b)
    let level = mother.permission as PermissionLevel
    if (args.readOnly) level = lower(level, 'plan')
    if (preset) level = lower(level, preset.permission)
    level = clampPermission(level, settings.agents.permissionsMax)
    const readOnly = level === 'plan'
    // The worktree is for whoever writes; with read-only there is nothing to isolate.
    if (args.worktree && readOnly) return fail(t('A worktree is for a delegate that writes files: it cannot be combined with read-only.'))
    if (args.worktree && !project.isGit) return fail(t('A worktree requires a git repository.'))
    const itemId = await this.delegateRowId(motherId, turnId, call)
    let prompt: string
    try {
      prompt = await renderDelegatePrompt(project.path, { agent: this.agentName(mother.agent), task: args.prompt, readOnly })
    } catch (error) {
      this.claimedToolRows.delete(itemId)
      return fail((error as Error).message)
    }
    if (this.runtimes.get(motherId) !== runtime || runtime.turnId !== turnId || this.isGone(motherId) || signal.aborted) {
      this.claimedToolRows.delete(itemId)
      return fail(t('The delegation was stopped.'))
    }
    // The counter is consumed only now that the delegation starts (and checked again, for parallel calls).
    const again = this.delegateCounts.get(motherId)
    const used = again?.turnId === turnId ? again.n : 0
    if (used >= MAX_DELEGATIONS_PER_TURN) {
      this.claimedToolRows.delete(itemId)
      return fail(t('At most {n} delegations per turn: finish with the results you have or do the rest yourself.', { n: MAX_DELEGATIONS_PER_TURN }))
    }
    this.delegateCounts.set(motherId, { turnId, n: used + 1 })
    // New worktree from the real HEAD of the parent's folder (work not yet committed stays out), only now that the delegation starts.
    let worktree: WorktreeInfo | null = null
    if (args.worktree) {
      try {
        const title = t('Delegate · {title}', { title: mother.title })
        const created = await createWorktree(project, `${title} ${randomUUID().slice(0, 4)}`, settings.worktree.copy, null, { dir: this.prefs.worktreesDir, branchPrefix: this.prefs.branchPrefix, startCommit: (await resolveCommit(this.cwdOf(mother), 'HEAD')) ?? undefined })
        worktree = created.info
        await this.ports.reserve(worktree.path)
        void ensureExcluded(project.path, PERSONAL_PATTERNS).catch(() => undefined)
      } catch (error) {
        this.claimedToolRows.delete(itemId)
        // Created but without ports (or anything else): no orphan worktree is left.
        if (worktree) {
          await removeWorktree(project, worktree.path, { skipCleanup: true }).catch(() => undefined)
          this.ports.release(worktree.path)
        }
        const counter = this.delegateCounts.get(motherId)
        if (counter?.turnId === turnId && counter.n > 0) counter.n--
        return fail(t('Could not create the worktree for the delegate: {error}', { error: error instanceof Error ? error.message : String(error) }))
      }
      if (this.runtimes.get(motherId) !== runtime || runtime.turnId !== turnId || this.isGone(motherId) || signal.aborted) {
        this.claimedToolRows.delete(itemId)
        await removeWorktree(project, worktree.path, { skipCleanup: true }).catch(() => undefined)
        this.ports.release(worktree.path)
        return fail(t('The delegation was stopped.'))
      }
    }
    const child = this.derivedRow(mother, {
      agent,
      model: args.model ?? preset?.model ?? null,
      effort: args.effort ?? preset?.effort ?? null,
      permission: level,
      title: t('Delegate · {title}', { title: mother.title }),
      titleSource: 'generated',
      handoffFrom: null,
      parent: JSON.stringify({ sessionId: motherId, role: 'delegate', itemId })
    })
    if (worktree) {
      child.cwd = worktree.path
      child.worktree = JSON.stringify(worktree)
    }
    this.insertSession(child)
    let resolve!: (outcome: ToolOutcome) => void
    const done = new Promise<ToolOutcome>((r) => (resolve = r))
    this.delegations.set(child.id, { motherId, itemId, agent, task: args.prompt, ended: false, report: null, resolve, done, branch: worktree?.branch ?? null })
    // Sub-agent in the parent's map: kind = agent name, the rest is filled in when the delegation ends.
    this.subagents.update(motherId, { id: child.id, title: stripControl(args.prompt).split('\n')[0].slice(0, 80) || t('Delegated task'), kind: this.agentName(agent), model: child.model, effort: child.effort as Effort | null, toolId: itemId, status: 'running', background: false })
    runtime.turnAgents = (runtime.turnAgents ?? 0) + 1
    this.emitSubagents(motherId)
    this.emitSummary(child.id)
    signal.addEventListener('abort', () => this.stopDelegation(child.id), { once: true })
    try {
      if (signal.aborted) throw new Error(t('The delegation was stopped.'))
      // Project setup in the new worktree, as for a new session: with setupWait the delegation waits for it to finish (services not started).
      if (worktree && settings.worktree.setup) {
        const setup = this.runSetup(child.id, project, worktree.path, settings.worktree.setup).then((code) => {
          if (!this.isGone(child.id)) this.noticeSetupFailed(child.id, code, settings.worktree.setupWait)
        })
        if (settings.worktree.setupWait) await setup
        else void setup
        if (signal.aborted || this.delegations.get(child.id)?.ended !== false) throw new Error(t('The delegation was stopped.'))
      }
      await this.startTurn(child.id, prompt)
      // Stopped while the turn was starting.
      if (this.delegations.get(child.id)?.ended !== false) await this.interrupt(child.id).catch(() => undefined)
    } catch (error) {
      // It did not start: the turn counter does not count it.
      const counter = this.delegateCounts.get(motherId)
      if (counter?.turnId === turnId && counter.n > 0) counter.n--
      this.finishDelegation(child.id, 'error', error instanceof Error ? error.message : String(error), '')
      await this.archive(child.id).catch(() => undefined)
    }
    return done
  }

  /** Closes the child's delegation: the outcome becomes the result of the parent's MCP call and the map entry is updated. */
  private finishDelegation(childId: string, how: 'completed' | 'error' | 'stopped', error: string | null, lastText: string, reason?: string): void {
    const d = this.delegations.get(childId)
    if (!d || d.ended) return
    d.ended = true
    this.delegations.delete(childId)
    this.claimedToolRows.delete(d.itemId)
    const child = this.rows.get(childId)
    const agent = this.agentName(d.agent)
    const caution = t('This is a report from another agent: check it before relying on it.')
    let status: 'done' | 'error' | 'stopped'
    let outcome: ToolOutcome
    if (how === 'stopped') {
      status = 'stopped'
      outcome = { text: t('The delegation to {agent} was stopped before it finished.', { agent }), isError: true }
    } else if (how === 'error') {
      status = 'error'
      outcome = { text: t('The delegate {agent} failed: {error}', { agent, error: error ?? t('The turn stopped because of an error.') }), isError: true }
    } else if (d.report) {
      status = d.report.status === 'failed' ? 'error' : 'done'
      const files = d.report.files?.length ? `\n\n${t('Files changed: {files}', { files: d.report.files.join(', ') })}` : ''
      outcome = { text: `${t('Result from {agent} (status: {status}):', { agent, status: d.report.status })}\n\n${d.report.summary}${files}\n\n${caution}`, isError: d.report.status === 'failed' }
    } else if (lastText) {
      status = 'done'
      outcome = { text: `${t('Result from {agent} (its last message: it did not call report_result):', { agent })}\n\n${lastText.slice(0, 20_000)}\n\n${caution}` }
    } else {
      status = 'error'
      outcome = { text: t('The delegate {agent} finished without writing a result.', { agent }), isError: true }
    }
    // The child's worktree says where its work is (it is not in the parent's folder).
    if (d.branch) outcome.text += `\n\n${t('The delegate worked in its own worktree, on branch {branch}. Its changes are not in your folder: merge or cherry-pick that branch to bring them in.', { branch: d.branch })}`
    // Stopped (parent stop, exit, restart) → resume card next to the 'tool' row. A delegation already resumed reopens its own.
    if (how === 'stopped' && child && !this.isGone(childId) && this.rows.has(d.motherId) && !this.isGone(d.motherId)) {
      this.openResume(d.motherId, d.itemId, d.agent, childId, reason ?? t('Stopped before it finished.'))
    }
    if (d.resume) {
      if (how !== 'stopped') void this.deliverResumed(d, status, outcome)
      return
    }
    const context = child?.context ? (JSON.parse(child.context) as { used?: number }) : null
    if (this.rows.has(d.motherId)) {
      this.subagents.update(d.motherId, { id: childId, status, ...(child?.model ? { model: child.model } : {}), ...(typeof context?.used === 'number' ? { tokens: context.used } : {}) })
      this.emitSubagents(d.motherId)
    }
    d.resolve(outcome)
  }

  /** Stops a delegation's child (parent Stop, cancelled MCP call) and closes the call with an error. */
  private stopDelegation(childId: string): void {
    const d = this.delegations.get(childId)
    if (!d || d.ended) return
    this.finishDelegation(childId, 'stopped', null, '')
    // After the interruption (and the end of the turn) the child's process closes: onTurnEnd already does it, this is the safety net.
    const runtime = this.runtimes.get(childId)
    void this.interrupt(childId)
      .then(() => runtime?.ending)
      .then(() => {
        if (runtime && this.runtimes.get(childId) === runtime && !runtime.adapter.isRunning) this.closeRuntime(childId)
      })
      .catch(() => undefined)
  }

  private stopDelegations(motherId: string): void {
    // Delegations resumed by the user (d.resume) do not depend on a parent turn: its Stop does not stop them.
    for (const [childId, d] of [...this.delegations]) if (d.motherId === motherId && !d.resume) this.stopDelegation(childId)
  }

  // ── Interrupted delegations: resume or dismiss ─────────────────────────────

  /** The session has its own folder: a normal session with a worktree, or a delegated child with `worktree: true` (folder different from the parent's). */
  private ownsWorktree(row: SessionRow): boolean {
    if (!row.worktree) return false
    const parent = this.parentOf(row)
    if (!parent) return true
    const mother = this.rows.get(parent.sessionId)
    return !!mother && this.cwdOf(mother) !== this.cwdOf(row)
  }

  /** Resume card in the parent, with the same turn as the call's 'tool' row. */
  private openResume(motherId: string, toolItemId: string, agent: AgentId, childId: string, reason: string): void {
    const tool = this.itemById(motherId, toolItemId)
    this.upsertItem(motherId, { kind: 'resume', id: `${toolItemId}:resume`, turnId: tool?.turnId ?? 'system', at: Date.now(), toolItemId, agent, childSessionId: childId, reason, state: 'open', error: null })
    this.flush()
  }

  /** 'resume': restarts the child's turn with a resume message; at the end of the turn the result goes to the coordinator (deliverResumed). 'dismiss': closes the card. */
  private async resumeDelegation(sessionId: string, itemId: string, action: 'resume' | 'dismiss'): Promise<void> {
    this.mustRow(sessionId)
    const item = this.itemById(sessionId, itemId)
    if (item?.kind !== 'resume') throw new Error(t('Resume card not found.'))
    if (item.state !== 'open' && item.state !== 'error') throw new Error(t('This delegation was already handled.'))
    const patch = (change: Partial<ResumeRow>) => {
      this.upsertItem(sessionId, { ...item, ...change })
      this.flush()
    }
    if (action === 'dismiss') return patch({ state: 'dismissed', error: null })
    const child = item.childSessionId ? this.rows.get(item.childSessionId) : undefined
    if (!child || child.archived || this.isGone(child.id) || child.mode !== 'chat') {
      const message = t('The delegate session is gone: there is nothing to resume.')
      patch({ state: 'error', error: message })
      throw new Error(message)
    }
    if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
    if (this.isBusy(child.id) || (child.run_state !== 'idle' && child.run_state !== 'error')) throw new Error(t('Wait for the delegate to stop before resuming it.'))
    const project = this.mustProject(child.project_id)
    // Marked immediately, synchronously: a second click during the awaits finds the card already 'resumed' and does not open a second turn.
    let resolve!: (outcome: ToolOutcome) => void
    const done = new Promise<ToolOutcome>((r) => (resolve = r))
    this.delegations.set(child.id, { motherId: sessionId, itemId: item.toolItemId, agent: child.agent as AgentId, task: '', ended: false, report: null, resolve, done, resume: { itemId }, branch: this.ownsWorktree(child) ? (JSON.parse(child.worktree!) as WorktreeInfo).branch : null })
    patch({ state: 'resumed', error: null })
    try {
      // Agents that do not resume the conversation (ACP) start from scratch: the original task is in the child's first message.
      const first = RESTARTABLE_AGENTS.has(child.agent) ? null : this.loadItems(child.id).find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user')
      const text = await renderDelegateResume(project.path, { task: first?.text ?? null })
      if (this.isGone(child.id) || this.isGone(sessionId)) throw new Error(t('The session is archived.'))
      await this.startTurn(child.id, text)
    } catch (error) {
      this.delegations.delete(child.id)
      patch({ state: 'open', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  /** Resumed delegation finished: the result goes to the coordinator as a user message (session.send rules), the card becomes 'done' or 'error'. */
  private async deliverResumed(d: Delegation, status: 'done' | 'error' | 'stopped', outcome: ToolOutcome): Promise<void> {
    const itemId = d.resume!.itemId
    const settle = (state: 'done' | 'error', error: string | null) => {
      const item = this.itemById(d.motherId, itemId)
      if (item?.kind !== 'resume') return
      this.upsertItem(d.motherId, { ...item, state, error })
      this.flush()
    }
    try {
      if (!this.rows.has(d.motherId) || this.isGone(d.motherId)) throw new Error(t('The session is archived.'))
      const project = this.mustProject(this.mustRow(d.motherId).project_id)
      await this.send(d.motherId, await renderDelegateResumed(project.path, { agent: this.agentName(d.agent), result: outcome.text }))
      settle(status === 'error' ? 'error' : 'done', status === 'error' ? outcome.text : null)
    } catch (error) {
      settle('error', error instanceof Error ? error.message : String(error))
    }
  }

  /** report_result: a plan task reports to the plan runner; any other session reports to who delegated to it or handed off. */
  private async ladderReportAny(sessionId: string, raw: unknown): Promise<ToolOutcome> {
    if (this.plans.isTask(sessionId)) return this.plans.call(sessionId, 'report_result', raw)
    const parsed = parseReport(raw)
    return parsed.ok ? this.ladderReport(sessionId, parsed.args) : { text: parsed.error, isError: true }
  }

  /** report_result: for a delegation it is the result of the parent's call; for a session born from a handoff it updates the origin's 'out' row. */
  private async ladderReport(sessionId: string, args: ReportArgs): Promise<ToolOutcome> {
    const row = this.mustRow(sessionId)
    const result: AgentResult = { status: args.status, summary: stripControl(args.summary), files: args.files.map((f) => stripControl(f)).filter(Boolean), at: Date.now() }
    const delegation = this.delegations.get(sessionId)
    if (delegation && !delegation.ended) {
      if (delegation.report) return { text: t('You already reported a result.'), isError: true }
      delegation.report = result
      return { text: t('Result recorded: it goes back to {agent}. End your turn now.', { agent: this.agentName(this.mustRow(delegation.motherId).agent) }) }
    }
    // Handoff: the latest 'in' row says who it comes from and which 'out' row to update.
    let inRow: Extract<ChatItem, { kind: 'handoff' }> | null = null
    for (const item of this.loadItems(sessionId)) if (item.kind === 'handoff' && item.direction === 'in' && item.peerSessionId) inRow = item
    const fromId = inRow?.peerSessionId
    const from = fromId ? this.rows.get(fromId) : undefined
    if (!inRow || !from) return { text: t('Nobody is waiting for a result from this session: report_result is only for delegated tasks and handoffs. Write your answer in the chat.'), isError: true }
    const outId = inRow.id.replace(/:in$/, '')
    const out = this.itemById(from.id, outId)
    if (out?.kind !== 'handoff') return { text: t('The handoff this session came from is no longer there.'), isError: true }
    if (out.result) return { text: t('You already reported a result.'), isError: true }
    this.patchHandoffItem(from.id, outId, { result })
    // Light notification to the origin: reuses the finished sub-agents notice.
    const project = this.projects.get(from.project_id)
    if (project && !from.archived) {
      const ok = result.status === 'done'
      this.attention({ kind: 'agents', sessionId: from.id, projectId: project.id, projectName: project.name, itemId: outId, outcome: ok ? 'done' : 'failed', finished: 1, failed: ok ? 0 : 1, title: ok ? t('{project}: {agent} reported back', { project: project.name, agent: this.agentName(row.agent) }) : t('{project}: {agent} reported a problem', { project: project.name, agent: this.agentName(row.agent) }), body: from.title })
    }
    return { text: t('Result recorded: it is on the handoff in the original session. End your turn now.') }
  }

  // ── Advice from other agents and "Implement with…" ──────────────

  private parentOf(row: SessionRow): NonNullable<SessionSummary['parent']> | null {
    try {
      return row.parent ? (JSON.parse(row.parent) as NonNullable<SessionSummary['parent']>) : null
    } catch {
      return null
    }
  }

  /** Child sessions are read-only: handoffs, implementations and permission changes are refused. */
  private assertNotChild(sessionId: string, message: string): void {
    if (this.mustRow(sessionId).parent) throw new Error(message)
  }

  /** A row of the session (live or on disk) without loading the whole chat. */
  private itemById(sessionId: string, id: string): ChatItem | undefined {
    const live = this.liveItems.get(sessionId)
    if (live) return live.get(id)
    const saved = this.db.prepare('select json from items where session_id = ? and id = ?').get(sessionId, id) as { json: string } | undefined
    return saved ? (JSON.parse(saved.json) as ChatItem) : undefined
  }

  private adviceItem(sessionId: string, itemId: string): Extract<ChatItem, { kind: 'advice' }> {
    this.mustRow(sessionId)
    const item = this.itemById(sessionId, itemId)
    if (item?.kind !== 'advice') throw new Error(t('Advice not found.'))
    return item
  }

  /** New row for a session that starts from another: same folder and worktree (no new worktree or setup), project profile. */
  private derivedRow(from: SessionRow, init: { agent: AgentId; model: string | null; effort: Effort | null; permission: PermissionLevel; title: string; titleSource: string; handoffFrom: string | null; parent: string | null }): SessionRow {
    const profileId = this.profiles.resolve(init.agent, from.project_id)
    const defaults = init.model ? null : this.agentDefaults(init.agent, from.project_id, profileId ?? undefined)
    const now = Date.now()
    return {
      id: randomUUID(),
      project_id: from.project_id,
      title: init.title,
      agent: init.agent,
      model: init.model ?? defaults?.model ?? null,
      // Only the given model: the effort is decided by the agent (the default belongs to another model).
      effort: init.effort ?? defaults?.effort ?? null,
      permission: init.permission,
      created_at: now,
      updated_at: now,
      archived: 0,
      external_id: null,
      run_state: 'idle',
      last_seq: 0,
      last_activity_seq: 0,
      last_read_seq: 0,
      queue: '[]',
      context: null,
      mode: 'chat',
      command: null,
      cwd: from.cwd,
      worktree: from.worktree,
      estimated: 0,
      agent_ref: null,
      activity_at: now,
      source: null,
      title_source: init.titleSource,
      profile_id: profileId,
      permission_next: null,
      merged_via: null,
      merged_at: null,
      handoff_from: init.handoffFrom,
      handoff: null,
      parent: init.parent,
      origin: null
    }
  }

  /** Updates an entry of the parent's card (if still there) and sends it to the UI. */
  private writeAdvice(motherId: string, item: Extract<ChatItem, { kind: 'advice' }>, entries: AdviceItem['entries'], extra: Partial<AdviceItem> = {}): void {
    if (!this.rows.has(motherId)) return
    this.upsertItem(motherId, { ...item, ...extra, entries })
    this.flush()
  }

  /**
   * A child finished (or was stopped): updates its entry on the parent's card. Valid only if the entry is still
   * 'running' (the first turn counts; what happens afterwards does not touch it). When all entries are finished it notifies the parent.
   */
  private settleAdvice(childId: string, patch: Partial<AdviceItem['entries'][number]>): void {
    const child = this.rows.get(childId)
    const parent = child ? this.parentOf(child) : null
    if (!parent || (parent.role !== 'advisor' && parent.role !== 'review') || !this.rows.has(parent.sessionId)) return
    const item = this.itemById(parent.sessionId, parent.itemId)
    if (item?.kind !== 'advice') return
    const index = item.entries.findIndex((e) => e.sessionId === childId)
    if (index < 0 || item.entries[index].state !== 'running') return
    const entries = item.entries.map((e, i) => (i === index ? { ...e, ...patch } : e))
    // Cross-review: the verdict is in the first line of the advice.
    const verdict = item.mode === 'review' && patch.state === 'done' ? parseVerdict(patch.text ?? '') : undefined
    this.writeAdvice(parent.sessionId, item, entries, verdict !== undefined ? { verdict } : {})
    if (entries.every((e) => e.state !== 'running')) this.adviceReady(parent.sessionId, item.id, entries)
    if (verdict === 'serious') void this.forwardReview(parent.sessionId, item.id).catch(() => undefined)
    if (item.mode === 'review' && entries.every((e) => e.state !== 'running')) this.startQueuedReview(parent.sessionId)
  }

  /** All entries finished: a light notice for the parent (reuses 'agents'). If the user stopped them, nothing. */
  private adviceReady(motherId: string, itemId: string, entries: AdviceItem['entries']): void {
    const row = this.rows.get(motherId)
    const project = row ? this.projects.get(row.project_id) : undefined
    if (!row || !project || this.isGone(motherId)) return
    const done = entries.filter((e) => e.state === 'done').length
    const failed = entries.filter((e) => e.state === 'error').length
    if (done + failed === 0) return
    // An automatic review notifies only if it finds something serious.
    const advice = this.itemById(motherId, itemId)
    if (advice?.kind === 'advice' && advice.mode === 'review' && advice.verdict !== 'serious') return
    const title = done > 0 ? t('{project}: advice ready', { project: project.name }) : t('{project}: advice failed', { project: project.name })
    this.attention({ kind: 'agents', sessionId: motherId, projectId: project.id, projectName: project.name, itemId, outcome: done > 0 ? 'done' : 'failed', finished: entries.length, failed, title, body: row.title })
  }

  /** /advisor and /committee: a read-only child session per agent, with the advice card in the parent. */
  private async advise(command: Extract<HostCommand, { type: 'session.advise' }>): Promise<string> {
    const { sessionId, agents } = command
    const row = this.mustRow(sessionId)
    if (row.mode === 'terminal') throw new Error(t('A terminal session cannot ask for advice.'))
    if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
    if (row.parent) throw new Error(t('A child session (advice or delegation) cannot ask for advice.'))
    if (agents.length < 1 || agents.length > 4) throw new Error(t('Pick between one and four agents.'))
    if (new Set(agents.map((a) => a.agent)).size !== agents.length) throw new Error(t('Each agent can be picked only once.'))
    const project = this.mustProject(row.project_id)
    const settings = await loadProjectSettings(project.path)
    for (const spec of agents) this.assertHandoffAgent(settings, spec.agent)
    const question = command.question.trim()
    const prompt = await renderAdvisorPrompt(project.path, { title: row.title, branch: this.branchOf(row), question, conversation: conversationExcerpt(this.loadItems(sessionId)) })
    // After the awaits the session may have been archived.
    if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
    const itemId = randomUUID()
    this.upsertItem(sessionId, {
      kind: 'advice',
      id: itemId,
      turnId: 'system',
      at: Date.now(),
      mode: agents.length > 1 ? 'committee' : 'advisor',
      question,
      entries: agents.map((a) => ({ agent: a.agent, model: a.model ?? null, sessionId: null, state: 'running' as const, text: null, error: null })),
      forwarded: false
    })
    this.flush()
    await Promise.all(agents.map((spec, index) => this.startAdvisor(row, itemId, index, spec, prompt, settings)))
    return itemId
  }

  /** Creates the child session of an entry and starts its turn; a start error closes the entry, not the command. */
  private async startAdvisor(mother: SessionRow, itemId: string, index: number, spec: { agent: AgentId; model?: string | null; effort?: Effort | null }, prompt: string, settings: ProjectSettings, role: 'advisor' | 'review' = 'advisor'): Promise<void> {
    let child: SessionRow | null = null
    const entryState = () => {
      const item = this.itemById(mother.id, itemId)
      return item?.kind === 'advice' ? item : null
    }
    const patch = (change: Partial<AdviceItem['entries'][number]>) => {
      const item = entryState()
      if (item) this.writeAdvice(mother.id, item, item.entries.map((e, i) => (i === index ? { ...e, ...change } : e)))
    }
    try {
      child = this.derivedRow(mother, {
        agent: spec.agent,
        model: spec.model ?? null,
        effort: spec.effort ?? null,
        // Read-only: Codex has the read-only sandbox, Claude the Plan mode with write tools removed.
        permission: clampPermission('plan', settings.agents.permissionsMax),
        title: role === 'review' ? t('Review · {title}', { title: mother.title }) : t('Advice · {title}', { title: mother.title }),
        titleSource: 'generated',
        handoffFrom: null,
        parent: JSON.stringify({ sessionId: mother.id, role, itemId })
      })
      this.insertSession(child)
      patch({ sessionId: child.id, model: child.model })
      this.emitSummary(child.id)
      // Stopped (or parent archived) before the turn started: the child does not start.
      const current = entryState()
      if (!current || current.entries[index]?.state !== 'running' || this.isGone(mother.id)) throw new Error(t('The advice was stopped.'))
      await this.startTurn(child.id, prompt)
      // Stopped while the turn was starting: the child is interrupted right away.
      if (entryState()?.entries[index]?.state !== 'running') await this.interrupt(child.id).catch(() => undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (entryState()?.entries[index]?.state === 'running') patch({ state: 'error', error: message, sessionId: null })
      if (child) await this.archive(child.id).catch(() => undefined)
      const item = entryState()
      if (item && item.entries.every((e) => e.state !== 'running')) {
        this.adviceReady(mother.id, itemId, item.entries)
        if (item.mode === 'review') this.startQueuedReview(mother.id)
      }
    }
  }

  /** When a review finishes, the pending one starts (if any). */
  private startQueuedReview(sessionId: string): void {
    const files = this.reviewQueued.get(sessionId)
    if (!files) return
    this.reviewQueued.delete(sessionId)
    void this.startCrossReview(sessionId, files).catch(() => undefined)
  }

  /** Stops the entries still 'running': they become 'stopped' and the child sessions are interrupted (they stay open to be read). */
  private async stopAdvice(sessionId: string, itemId: string): Promise<void> {
    const item = this.adviceItem(sessionId, itemId)
    const running = item.entries.filter((e) => e.state === 'running')
    if (!running.length) return
    this.writeAdvice(sessionId, item, item.entries.map((e) => (e.state === 'running' ? { ...e, state: 'stopped' as const, error: null } : e)))
    await Promise.all(running.map((e) => (e.sessionId ? this.interrupt(e.sessionId).catch(() => undefined) : undefined)))
  }

  /** Sends the finished advice to the session's agent as a user message, with the session.send rules. */
  private async forwardAdvice(sessionId: string, itemId: string, note: string | null, auto = false): Promise<void> {
    const item = this.adviceItem(sessionId, itemId)
    const opinions = item.entries.flatMap((e) => (e.state === 'done' && e.text?.trim() ? [{ agent: this.agentName(e.agent), model: e.model, text: e.text }] : []))
    if (!opinions.length) throw new Error(t('There is no advice to send yet.'))
    const project = this.mustProject(this.mustRow(sessionId).project_id)
    const text = await renderAdviceForward(project.path, { opinions, note: note?.trim() || null })
    // Automatic review forward: the turn it creates is not reviewed (see startTurn).
    if (auto) this.reviewForwards.set(sessionId, text)
    try {
      await this.send(sessionId, text)
    } catch (error) {
      if (auto) this.reviewForwards.delete(sessionId)
      throw error
    }
    const current = this.itemById(sessionId, itemId)
    if (current?.kind === 'advice') {
      this.upsertItem(sessionId, { ...current, forwarded: true })
      this.flush()
    }
  }

  /** "Implement with…": same agent = one message with the plan; other agent = delivery to a linked session, without a summary. */
  private async implement(command: Extract<HostCommand, { type: 'session.implement' }>): Promise<string> {
    const { sessionId, agent } = command
    const row = this.mustRow(sessionId)
    this.assertNotChild(sessionId, t('A child session (advice or delegation) cannot implement a plan.'))
    if (row.mode === 'terminal') throw new Error(t('A terminal session cannot implement a plan.'))
    if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
    // Only the tail is cleaned: the start stays as it is, or the comments' line numbers would shift.
    const plan = command.plan.trimEnd()
    if (!plan.trim()) throw new Error(t('The plan is empty.'))
    const project = this.mustProject(row.project_id)
    const settings = await loadProjectSettings(project.path)
    const level = clampPermission(command.permission ?? 'edit', settings.agents.permissionsMax)
    const prompt = await renderImplementPrompt(project.path, { plan, comments: command.comments })
    if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
    if (agent === row.agent) {
      // As session.permission.set (Codex mid-turn: from the next one), then as session.send.
      if (row.permission === 'plan') await this.setPermission(sessionId, level)
      await this.send(sessionId, prompt)
      return sessionId
    }
    const busy = () => new Error(t('Wait for the session to finish before handing it over.'))
    if (this.isBusy(sessionId) || row.handoff || this.handoffStarting.has(sessionId) || (row.run_state !== 'idle' && row.run_state !== 'error')) throw busy()
    this.handoffStarting.add(sessionId)
    const itemId = `implement:${randomUUID()}`
    try {
      this.assertHandoffAgent(settings, agent)
      // Checkpoint at handoff time (as at end of turn): from there the files of the session chain are visible.
      let checkpoint: string | null = null
      const cwd = this.cwdOf(row)
      if (project.isGit) {
        checkpoint = await createCheckpoint(cwd, `refs/ladder/${sessionId}/${itemId.slice(10)}-implement`, 'ladder: implement handoff').catch(() => null)
        if (checkpoint) recordCheckpoint(this.db, { session_id: sessionId, turn_id: null, kind: 'end', sha: checkpoint, root: cwd, label: null, at: Date.now() })
      }
      const files = await this.sessionFiles(row, checkpoint)
      if (this.isGone(sessionId)) throw new Error(t('The handoff was interrupted.'))
      if (this.isBusy(sessionId) || this.mustRow(sessionId).run_state === 'running') throw busy()
      // The plan arrives with the comments, as the user wrote them.
      const notes = command.comments.filter((c) => c.text.trim()).map((c) => t('- line {line}: {text}', { line: c.line, text: c.text.trim().replace(/\n+/g, ' ') }))
      const summary = notes.length ? `${plan}\n\n## ${t('Comments on the plan')}\n\n${notes.join('\n')}` : plan
      const run: HandoffRun = { itemId, turnId: 'system', agent, model: command.model ?? null, effort: command.effort ?? null, note: null, reason: 'implement', prompt, permission: level }
      this.upsertItem(sessionId, { kind: 'handoff', id: itemId, turnId: 'system', at: Date.now(), reason: 'implement', direction: 'out', agent, peerSessionId: null, state: 'done', note: null, summary, checkpoint, files, error: null })
      this.saveRun(run)
      this.flush()
      try {
        const peerId = await this.deliverHandoff(row, run, summary, files, checkpoint)
        this.patchHandoffItem(sessionId, itemId, { peerSessionId: peerId })
        return peerId
      } catch (error) {
        this.patchHandoffItem(sessionId, itemId, { state: 'error', error: error instanceof Error ? error.message : String(error), peerSessionId: null, resumable: true })
        throw error
      }
    } finally {
      this.handoffStarting.delete(sessionId)
    }
  }

  /** `all`: Stop (also stops inserted messages not yet merged); false for "send now", which merges them with the new message. */
  private async interrupt(sessionId: string, all = true): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    for (const [requestId] of runtime.pending) this.expireRequest(sessionId, requestId)
    runtime.interrupting = true
    // Stop: also stops the action in progress in the agent's browser and revokes its tools until the next turn (implicit stop).
    this.browserAgent.stop(sessionId, 'interrupt')
    // The parent's delegations stop with it (the MCP call returns with an error).
    this.stopDelegations(sessionId)
    await runtime.adapter.interrupt(all)
  }

  private setPermission(sessionId: string, requested: PermissionLevel): Promise<{ permission: PermissionLevel; appliesFrom: 'now' | 'next-turn' }> {
    return this.withPermissionLock(sessionId, () => this.changePermission(sessionId, requested))
  }

  /** Level changes and applying the pending level run one at a time per session. */
  private withPermissionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.permissionLocks.get(sessionId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    this.permissionLocks.set(sessionId, run)
    const done = () => {
      if (this.permissionLocks.get(sessionId) === run) this.permissionLocks.delete(sessionId)
    }
    run.then(done, done)
    return run
  }

  private async changePermission(sessionId: string, requested: PermissionLevel): Promise<{ permission: PermissionLevel; appliesFrom: 'now' | 'next-turn' }> {
    const project = this.projects.get(this.mustRow(sessionId).project_id)
    const settings = project ? await loadProjectSettings(project.path) : null
    const permission = clampPermission(requested, settings?.agents.permissionsMax ?? null)
    // The agent first: if it refuses, the error propagates and the row stays as it was.
    await this.runtimes.get(sessionId)?.adapter.setPermission(permission)
    // After the awaits the state is the current one: row and runtime are re-read.
    const row = this.mustRow(sessionId)
    const runtime = this.runtimes.get(sessionId)
    // Codex reads the policy only when the turn starts: mid-turn the level applies from the next one.
    const appliesFrom = row.agent === 'codex' && runtime?.turnId ? 'next-turn' : 'now'
    if (appliesFrom === 'next-turn' && runtime) {
      this.updateRow(sessionId, { permission_next: permission === row.permission ? null : permission })
      runtime.approveAll = permission === 'full'
    } else {
      const before = row.permission
      this.updateRow(sessionId, { permission, permission_next: null })
      // Level changed at once: the agent browser's authorizations (Full access, "for the session") lapse now, not at the next navigation.
      if (permission !== before) this.browserAgent.permissionChanged(sessionId)
    }
    this.emitSummary(sessionId)
    // Open requests that the new level permits no longer have a reason to wait.
    if (runtime) {
      for (const requestId of [...runtime.pending.keys()]) {
        const item = this.liveItems.get(sessionId)?.get(requestId)
        if (item?.kind === 'request' && (await this.allows(sessionId, permission, item))) this.autoApprove(sessionId, requestId, permission)
      }
    }
    return { permission, appliesFrom }
  }

  // ── Items and summaries ────────────────────────────────────────────────

  private withSeq(sessionId: string, input: ItemInput): ChatItem {
    const row = this.mustRow(sessionId)
    const seq = row.last_seq + 1
    this.updateRow(sessionId, { last_seq: seq })
    return { ...input, seq } as ChatItem
  }

  /** Creates or updates an item. Saving and sending to the UI happen together, every 33 ms. */
  private upsertItem(sessionId: string, input: ItemInput | ChatItem): ChatItem {
    let live = this.liveItems.get(sessionId)
    if (!live) {
      live = new Map(this.loadItems(sessionId).map((i) => [i.id, i]))
      this.liveItems.set(sessionId, live)
    }
    const existing = live.get(input.id)
    const item = existing ? ({ ...input, seq: existing.seq } as ChatItem) : 'seq' in input ? (input as ChatItem) : this.withSeq(sessionId, input)
    live.set(item.id, item)
    let dirty = this.dirty.get(sessionId)
    if (!dirty) this.dirty.set(sessionId, (dirty = new Map()))
    dirty.set(item.id, item)
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS)
    return item
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.dirty.size === 0) return
    const batches = [...this.dirty.entries()]
    this.dirty.clear()
    tx(this.db, () => {
      for (const [sessionId, items] of batches) for (const item of items.values()) this.writeItem(sessionId, item)
    })
    for (const [sessionId, items] of batches) {
      this.broadcast({ type: 'session.items', sessionId, items: [...items.values()].sort((a, b) => a.seq - b.seq), replace: false })
    }
  }

  private writeItem(sessionId: string, item: ChatItem): void {
    this.db
      .prepare('insert into items (session_id, id, seq, json) values (?, ?, ?, ?) on conflict(session_id, id) do update set json = excluded.json')
      .run(sessionId, item.id, item.seq, JSON.stringify(item))
  }

  /** For the phone snapshot: each project's permission ceiling, send preference and new-session defaults. */
  async remoteExtras(): Promise<{ permissionsMax: Record<string, PermissionLevel | null>; busySend: 'steer' | 'queue'; defaults: Record<string, RemoteProjectDefaults> }> {
    const permissionsMax: Record<string, PermissionLevel | null> = {}
    const defaults: Record<string, RemoteProjectDefaults> = {}
    await Promise.all(
      [...this.projects.values()].map(async (p) => {
        const settings = await loadProjectSettings(p.path).catch(() => null)
        permissionsMax[p.id] = settings?.agents.permissionsMax ?? null
        const ui = this.uiStateOf(p.id)
        // State of each agent for the account assigned to the project: the same model list that checkCreate will use.
        const assigned = this.profiles.forProject(p.id)
        const agents = [...this.agents.values()].map((a) => (isProfileAgent(a.agent) && assigned?.[a.agent] ? (this.profileAgents.get(assigned[a.agent]!) ?? a) : a))
        defaults[p.id] = resolveRemoteDefaults({
          agents,
          project: ui?.defaults,
          global: this.prefs.defaults,
          tomlAgent: (settings?.agents.default as AgentId | null | undefined) ?? null,
          lastAgent: ui?.lastAgent ?? null,
          allowed: (settings?.agents.allowed ?? []) as AgentId[],
          maxPermission: permissionsMax[p.id],
          agentDefaults: (agent) => this.agentDefaults(agent, p.id, isProfileAgent(agent) ? assigned?.[agent] : undefined)
        })
      })
    )
    return { permissionsMax, busySend: this.prefs.busySend === 'queue' ? 'queue' : 'steer', defaults }
  }

  /** Verified agent and account of `agents.usage`; the default (missing or `default:*`) comes back without profileId. */
  usageTarget(agent: string, profileId?: string): { agent: string; profileId?: string } {
    if (!this.agents.has(agent)) throw new Error(t('Unknown agent: add it in Settings → Agents.'))
    const custom = isProfileAgent(agent) ? customProfileId(profileId) : undefined
    if (custom) {
      const profile = this.profiles.get(custom)
      if (!profile || profile.agent !== agent) throw new Error(t('Account not found.'))
    }
    return { agent, ...(custom ? { profileId: custom } : {}) }
  }

  private uiStateOf(projectId: string): ProjectUiState | null {
    const row = this.db.prepare('select json from ui_state where project_id = ?').get(projectId) as { json: string } | undefined
    try {
      return row ? (JSON.parse(row.json) as ProjectUiState) : null
    } catch {
      return null
    }
  }

  /**
   * Checks for `session.create` from the phone that need host state (project, allowed and available agent, account,
   * known model and effort). No side effects: throws a translated error, or returns the agent and project names for the log.
   * The permission level is then reduced by createSession (project ceiling); "Allow Full" is checked by the gateway.
   */
  async checkCreate(command: RemoteSessionCreate): Promise<{ agent: string; project: string }> {
    const project = this.mustProject(command.projectId)
    const settings = await loadProjectSettings(project.path)
    if (settings.agents.allowed.length && !settings.agents.allowed.includes(command.agent)) {
      throw new Error(t('{agent} is not allowed in this project (.ladder/settings.toml, [agents] allowed).', { agent: this.agentName(command.agent) }))
    }
    const base = this.agents.get(command.agent)
    if (!base) throw new Error(t('Unknown agent: add it in Settings → Agents.'))
    if (!base.available) throw new Error(base.error ?? t('{agent} is not available.', { agent: base.name }))
    // Throws if the account does not exist or belongs to another agent.
    const custom = this.profiles.resolve(command.agent, project.id, command.profileId)
    const status = (custom ? this.profileAgents.get(custom) : null) ?? base
    if (command.model !== null && !isValidModel(status, command.model)) throw new Error(t('Unknown model for {agent}.', { agent: base.name }))
    if (command.effort !== null) {
      const model = command.model ?? status.models.find((m) => m.isDefault)?.id ?? null
      if (!isValidEffort(status, model, command.effort)) throw new Error(t('This model does not support that effort level.'))
    }
    return { agent: base.name, project: project.name }
  }

  /** Project files (relative paths, .gitignore respected); also used by the phone's `project.files.search`. */
  async projectFiles(projectId: string): Promise<string[]> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(t('Project not found.'))
    return project.isGit ? listFiles(project.path) : (await listTree(project.path)).files
  }

  /** Archived sessions of a project, paged (remote command project.sessions.archived). */
  archivedSessions(projectId: string, before?: number, limit?: number): SessionSummary[] {
    if (!this.projects.has(projectId)) throw new Error(t('Project not found.'))
    const size = Math.min(Math.max(Math.floor(limit ?? 30), 1), 100)
    return [...this.rows.values()]
      .filter((r) => r.project_id === projectId && r.archived && (before === undefined || r.updated_at < before))
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, size)
      .map((r) => this.summary(r.id))
  }

  /** Title and options of a request, for the remote action log; null if the request does not exist. */
  requestInfo(sessionId: string, requestId: string): { title: string; options: { id: string; kind: 'allow' | 'allow-always' | 'deny' }[] } | null {
    if (!this.rows.has(sessionId)) return null
    const item = this.liveItems.get(sessionId)?.get(requestId) ?? this.loadItems(sessionId).find((i) => i.id === requestId)
    return item?.kind === 'request' ? { title: item.title, options: item.options.map((o) => ({ id: o.id, kind: o.kind })) } : null
  }

  /** A page of chat for the remote client: see remote/paging.ts. */
  pageItems(sessionId: string, before?: number, limit?: number): RemotePage {
    this.mustRow(sessionId)
    return pageItemsOf(this.db, this.liveItems.get(sessionId), sessionId, before, limit)
  }

  private loadItems(sessionId: string): ChatItem[] {
    const live = this.liveItems.get(sessionId)
    if (live) return [...live.values()].sort((a, b) => a.seq - b.seq)
    return (this.db.prepare('select json from items where session_id = ? order by seq').all(sessionId) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as ChatItem
    )
  }

  private updateRow(sessionId: string, patch: Partial<SessionRow>): void {
    const row = this.mustRow(sessionId)
    Object.assign(row, patch, { updated_at: Date.now() })
    // End of turn: the agent may have committed or pushed, and the fetch can restart.
    if (patch.run_state === 'idle') this.gitStatus.refresh(this.cwdOf(row))
    const keys = Object.keys(patch).concat('updated_at')
    const sql = `update sessions set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`
    this.db.prepare(sql).run(...keys.map((k) => (row as unknown as Record<string, string | number | null>)[k]), sessionId)
  }

  private mustRow(sessionId: string): SessionRow {
    const row = this.rows.get(sessionId)
    if (!row) throw new Error(t('Session not found.'))
    return row
  }

  /** Open requests of a chat session, oldest first. */
  private openRequestItems(sessionId: string): RequestItemData[] {
    if (!this.runtimes.get(sessionId)?.pending.size) return []
    const items = this.liveItems.get(sessionId)
    return [...(items?.values() ?? [])]
      .filter((i): i is RequestItemData => i.kind === 'request' && i.state === 'open')
      .sort((a, b) => a.at - b.at)
  }

  private branchOf(row: SessionRow): string | null {
    if (row.worktree) return (JSON.parse(row.worktree) as WorktreeInfo).branch
    return this.projects.get(row.project_id)?.branch ?? null
  }

  private prOf(row: SessionRow): PrStatus | null {
    const branch = this.branchOf(row)
    return branch ? (this.prs.get(`${this.cwdOf(row)}\0${branch}`)?.status ?? null) : null
  }

  /** Agent defaults for a project (project settings included); the model list stays at user level. */
  private agentDefaults(agent: AgentId, projectId: string, profileId?: string): { model: string | null; effort: Effort | null; known: boolean } {
    const custom = customProfileId(profileId)
    const models = (custom ? this.profileAgents.get(custom) : this.agents.get(agent))?.models ?? []
    const configDir = this.profiles.configDir(profileId ?? null)
    if (agent === 'claude-code') return claudeProjectDefaults(models, configDir, this.projects.get(projectId)?.path ?? null)
    if (agent === 'codex') return codexDefaults(models, configDir)
    // ACP: the default is the model marked by the agent.
    const model = models.find((m) => m.isDefault)
    return { model: model?.id ?? null, effort: model?.defaultEffort ?? null, known: true }
  }

  /** The model as the UI sees it: 'default' (alias saved in the past) becomes null; Claude's wire id maps to the list id. */
  private modelOf(row: SessionRow): string | null {
    if (!row.model || row.model === 'default') return null
    return row.agent === 'claude-code' ? claudeListId(row.model) : row.model
  }

  /** Effort in use without a choice from Ladder: the one from the agent's init, otherwise the effective model's default. */
  private effectiveEffort(row: SessionRow): Effort | null {
    const fromInit = this.initEffort.get(row.id)
    if (fromInit) return fromInit
    const custom = customProfileId(row.profile_id)
    const models = (custom ? this.profileAgents.get(custom) : this.agents.get(row.agent))?.models ?? []
    const model = (this.modelOf(row) ? models.find((m) => m.id === this.modelOf(row)) : undefined) ?? models.find((m) => m.isDefault)
    if (row.agent === 'claude-code') {
      // Project settings count only for the session, not for the agent's model list.
      const project = readClaudeDefaults(this.profiles.configDir(row.profile_id), this.cwdOf(row))
      const names = [this.modelOf(row), model?.id].filter((n): n is string => !!n).flatMap(claudeModelNames)
      const hit = names.map((n) => project.modelEffort[n]).find(Boolean)
      if (hit ?? project.effort) return hit ?? project.effort
    }
    return model?.defaultEffort ?? null
  }

  private summary(sessionId: string): SessionSummary {
    const row = this.mustRow(sessionId)
    const runtime = this.runtimes.get(sessionId)
    const term = this.termStatus.get(sessionId)
    // A coordinator with a plan to approve or paused is waiting for you, like for a request.
    const planWait = row.run_state === 'idle' && row.archived === 0 ? this.plans.waitingFor(sessionId) : null
    const run = row.run_state as RunState
    const open = run === 'waiting' ? this.openRequestItems(sessionId) : []
    let waitingLabel: string | null = null
    if (run === 'waiting' && runtime) {
      waitingLabel = open[0]?.requestType === 'question' ? t('Question') : t('Approval')
    } else if (run === 'waiting') {
      waitingLabel = term?.label ?? t('Needs you')
    } else if (planWait) {
      // The run stays 'idle' (the session is not busy: you can write, stop, use commands): only the label says it is waiting for you.
      waitingLabel = planWait.label
    }
    const effortEffective = row.effort ? null : this.effectiveEffort(row)
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      titleSource: row.title_source as SessionSummary['titleSource'],
      ...(this.titling.has(row.id) ? { titleGenerating: true } : {}),
      agent: row.agent as SessionSummary['agent'],
      ...(row.profile_id ? { profileId: row.profile_id } : {}),
      model: this.modelOf(row),
      effort: row.effort as SessionSummary['effort'],
      ...(effortEffective ? { effortEffective } : {}),
      permission: row.permission as PermissionLevel,
      ...(row.permission_next ? { permissionNext: row.permission_next as PermissionLevel } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      run,
      waitingLabel,
      activity: runtime?.activity ?? term?.activity ?? null,
      unread: row.last_activity_seq > row.last_read_seq,
      lastReadSeq: row.last_read_seq,
      archived: row.archived === 1,
      // Without the attachments' base64 data: megabytes would travel on every session update.
      queue: (JSON.parse(row.queue) as QueuedMessage[]).map((q) =>
        q.attachments ? { ...q, attachments: q.attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, data: '' })) } : q
      ),
      context: row.context ? (JSON.parse(row.context) as SessionSummary['context']) : null,
      mode: (row.mode as SessionSummary['mode']) ?? 'chat',
      cwd: this.cwdOf(row),
      worktree: row.worktree ? (JSON.parse(row.worktree) as WorktreeInfo) : null,
      command: row.command,
      terminalId: this.terminals.bySession(row.id, 'agent')[0]?.id ?? null,
      estimated: row.estimated === 1,
      waitingSince: run === 'waiting' ? (open[0]?.at ?? term?.waitingSince ?? row.updated_at) : (planWait?.since ?? null),
      ...(planWait ? { planWaiting: true } : {}),
      request: open[0] ?? null,
      openRequests: run === 'waiting' ? Math.max(1, open.length) : 0,
      activityAt: row.activity_at || row.updated_at,
      canSteer: this.canSteer(row) && !runtime?.handoff,
      branch: this.branchOf(row),
      pr: this.prOf(row),
      source: row.source ? (JSON.parse(row.source) as SessionSource) : null,
      subagentCounts: this.subagents.counts(row.id, !!this.runtimes.get(row.id)?.turnId),
      ...(row.handoff_from ? { handoffFrom: this.handoffFromOf(row) } : {}),
      ...(row.parent ? { parent: this.parentOf(row) } : {}),
      agentsNotice: this.agentsNotices.get(row.id) ?? null,
      plan: this.plans.refFor(row.id),
      ...(row.origin ? { origin: JSON.parse(row.origin) as SessionSummary['origin'] } : {})
    }
  }

  /** One tool row by id: from the live rows or with a query, without loading the whole chat. */
  private toolRow(sessionId: string, id: string): Extract<ChatItem, { kind: 'tool' }> | null {
    const live = this.liveItems.get(sessionId)
    const item = live
      ? live.get(id)
      : (() => {
          const r = this.db.prepare('select json from items where session_id = ? and id = ?').get(sessionId, id) as { json: string } | undefined
          return r ? (JSON.parse(r.json) as ChatItem) : undefined
        })()
    return item?.kind === 'tool' && item.tool === 'agent' ? item : null
  }

  /** Subagent detail: from the board (or the finished cache), otherwise rebuilt from the chat's tool row. */
  private async subagentDetail(sessionId: string, id: string): Promise<SubagentDetail> {
    this.mustRow(sessionId)
    const found = this.subagents.find(sessionId, id)
    const row = this.toolRow(sessionId, found?.info.toolId ?? id)
    const extra = found?.extra
    let info = found?.info ?? null
    if (!info && row) {
      const meta = row.agent
      info = {
        id: row.id,
        parentId: null,
        title: row.title,
        kind: null,
        model: meta?.model ?? null,
        effort: meta?.effort ?? null,
        toolId: row.id,
        // An agent the board no longer knows is not alive: a row still "running" was left half done.
        status: row.status === 'done' ? 'done' : row.status === 'error' ? 'error' : 'stopped',
        startedAt: row.at,
        endedAt: row.endedAt ?? row.at,
        activity: null,
        tokens: null,
        toolUses: null,
        background: false
      }
    }
    const background = info?.background === true
    const rowOutput = row?.output?.trim() || null
    const file = extra?.outputFile && (background || !(extra.result || rowOutput || extra.report)) ? await readReportFile(extra.outputFile) : null
    return {
      info,
      prompt: extra?.prompt ?? row?.detail ?? null,
      // Foreground: the tool_result is the real report. Background: the summary, then the file (if text), then the row.
      report: background ? (extra?.report ?? file ?? extra?.result ?? rowOutput) : (extra?.result ?? rowOutput ?? extra?.report ?? file),
      tools: (extra?.tools ?? []).map(({ name, title, status, at }) => ({ name, title, status, at }))
    }
  }

  /** Subagents change often (one tool after another, in parallel): the renderer gets one update every 250 ms. */
  private emitSubagents(sessionId: string): void {
    if (this.subagentFlush.has(sessionId)) return
    this.subagentFlush.set(
      sessionId,
      setTimeout(() => {
        this.subagentFlush.delete(sessionId)
        this.emitSummary(sessionId)
        if (this.rows.has(sessionId)) this.broadcast({ type: 'session.subagents', sessionId, subagents: this.subagents.list(sessionId) ?? [] })
      }, 250)
    )
  }

  private emitSummary(sessionId: string): void {
    if (!this.rows.has(sessionId)) return
    this.broadcast({ type: 'session.upsert', session: this.summary(sessionId) })
    // Whoever waits on this session (session.wait) checks again.
    this.wakeWaiters(sessionId)
    // The session of a task waiting for an answer is mirrored in the plan.
    this.plans.sessionWaiting(sessionId, this.rows.get(sessionId)?.run_state === 'waiting')
    this.updateBadge()
    // State, title and archival are in the branch map.
    if (this.branchMapSubs.size > 0) this.branchMaps.touch(this.rows.get(sessionId)!.project_id)
  }

  // ── Notifications and Dock badge (shown by the main process) ──────────────────

  private attention(event: AttentionEvent): void {
    this.notify({ type: 'attention', event })
  }

  /** A background subagent has finished: outside a user turn even those that keep going (Codex) are background. */
  private trackAgentEnd(sessionId: string, id: string, before: SubagentInfo | undefined): void {
    const after = this.subagents.find(sessionId, id)?.info
    // Stopped (not finished): it does not count as finished, but if it was the last one with pending counts the session does not go silent.
    if (before?.status === 'running' && after?.status === 'stopped' && after.background) {
      if (this.agentsIdle.has(sessionId)) this.armAgentsFinished(sessionId)
      return
    }
    if (before?.status !== 'running' || !after || (after.status !== 'done' && after.status !== 'error')) return
    if (!after.background && this.runtimes.get(sessionId)?.turnId) return
    const failed = after.status === 'error'
    const rt = this.runtimes.get(sessionId)
    // Also a background that finished while the turn was closing: the coordinator is already stopped.
    const idle = !rt?.turnId || (rt.closing > 0 && after.background)
    if (idle) {
      this.agentsBeforeTurn.set(sessionId, (this.agentsBeforeTurn.get(sessionId) ?? 0) + 1)
      const run = this.agentsIdle.get(sessionId) ?? { finished: 0, failed: 0 }
      run.finished++
      if (failed) run.failed++
      this.agentsIdle.set(sessionId, run)
    }
    const notice = this.agentsNotices.get(sessionId) ?? { finished: 0, failed: 0, at: 0 }
    const pending = this.agentsPending.get(sessionId) ?? { finished: 0, failed: 0 }
    for (const entry of [notice, pending]) {
      entry.finished++
      if (failed) entry.failed++
    }
    notice.at = Date.now()
    this.agentsNotices.set(sessionId, notice)
    this.agentsPending.set(sessionId, pending)
    if (failed) this.announceAgents(sessionId, 'failed', after.title)
    else this.flushAgentsDone(sessionId)
    if (idle) this.armAgentsFinished(sessionId)
  }

  /**
   * Last background finished with the coordinator stopped: if within a few seconds no turn starts (implicit or the user's),
   * the chat gets the 'agents-finished' row in 'waiting' with "Continue". If the turn starts first the row is not created:
   * the 'agent-start' row is already there, and no "Continue" flashes.
   */
  private armAgentsFinished(sessionId: string): void {
    if ((this.subagents.list(sessionId) ?? []).some((a) => a.status === 'running')) return
    clearTimeout(this.agentsWait.get(sessionId))
    this.agentsWait.set(
      sessionId,
      setTimeout(() => {
        this.agentsWait.delete(sessionId)
        const runtime = this.runtimes.get(sessionId)
        const run = this.agentsIdle.get(sessionId)
        if (!runtime || !run || runtime.exited || this.isBusy(sessionId)) return
        if ((this.subagents.list(sessionId) ?? []).some((a) => a.status === 'running')) return
        this.agentsIdle.delete(sessionId)
        // A row still waiting is superseded by this one.
        this.settleAgentsFinished(sessionId, 'dismissed')
        const id = randomUUID()
        this.agentsRows.set(sessionId, id)
        this.upsertItem(sessionId, { kind: 'agents-finished', id, turnId: this.lastTurnId(sessionId), at: Date.now(), finished: run.finished, failed: run.failed, state: 'waiting' })
      }, AGENTS_WAIT_MS)
    )
  }

  /** Turn of the last closing (or, after a restart, of the last saved 'turn-end'); 'system' if the session has no turns. */
  private lastTurnId(sessionId: string): string {
    const known = this.lastTurnIds.get(sessionId)
    if (known) return known
    const last = this.loadItems(sessionId).findLast((i) => i.kind === 'turn-end')
    return last?.turnId ?? 'system'
  }

  /** Moves the waiting 'agents-finished' row to the given state (if there is one). */
  private settleAgentsFinished(sessionId: string, state: 'resumed' | 'continued' | 'dismissed'): void {
    const id = this.agentsRows.get(sessionId)
    if (!id) return
    this.agentsRows.delete(sessionId)
    const item = this.liveItems.get(sessionId)?.get(id) ?? this.loadItems(sessionId).find((i) => i.id === id)
    if (item?.kind === 'agents-finished' && item.state === 'waiting') this.upsertItem(sessionId, { ...item, state })
  }

  /** "Continue": the only way Ladder writes to the coordinator after the backgrounds, with a user click. */
  private async continueAgents(sessionId: string, itemId: string): Promise<void> {
    this.mustRow(sessionId)
    const item = this.liveItems.get(sessionId)?.get(itemId) ?? this.loadItems(sessionId).find((i) => i.id === itemId)
    if (item?.kind !== 'agents-finished' || item.state !== 'waiting') throw new Error(t('This session has already moved on.'))
    if (this.isBusy(sessionId)) throw new Error(t('The session is busy. Try again when it stops.'))
    // 'continued' at once: a second click does not send twice.
    this.agentsRows.delete(sessionId)
    this.upsertItem(sessionId, { ...item, state: 'continued' })
    try {
      await this.send(sessionId, t('Background agents finished. Continue.'))
    } catch (error) {
      this.agentsRows.set(sessionId, itemId)
      this.upsertItem(sessionId, item)
      throw error
    }
  }

  /** 'done' notice when no background agent remains; with a turn open it waits for its end and merges with its notification. True if it sent it. */
  private flushAgentsDone(sessionId: string, itemId: string | null = null): boolean {
    const pending = this.agentsPending.get(sessionId)
    if (!pending || pending.finished === 0) return false
    const runtime = this.runtimes.get(sessionId)
    if (runtime?.turnId) return false
    if ((this.subagents.list(sessionId) ?? []).some((a) => a.status === 'running')) return false
    return this.announceAgents(sessionId, 'done', null, itemId)
  }

  private announceAgents(sessionId: string, outcome: 'done' | 'failed', agentTitle: string | null, itemId: string | null = null): boolean {
    const pending = this.agentsPending.get(sessionId)
    const row = this.rows.get(sessionId)
    const project = row ? this.projects.get(row.project_id) : undefined
    if (!pending || !row || !project) return false
    this.agentsPending.delete(sessionId)
    // A child does not notify any of its sub-agents.
    if (row.parent) return false
    const { finished, failed } = pending
    const title =
      outcome === 'failed'
        ? t('{project}: subagent failed', { project: project.name })
        : plural(finished, '{project}: {n} subagent finished', '{project}: {n} subagents finished', { project: project.name })
    const body =
      outcome === 'failed'
        ? `${row.title} · ${agentTitle ?? t('Subagent')}`
        : failed > 0
          ? plural(failed, '{title} · {n} subagent failed', '{title} · {n} subagents failed', { title: row.title })
          : row.title
    this.attention({ kind: 'agents', sessionId, projectId: project.id, projectName: project.name, itemId, outcome, finished, failed, title, body })
    return true
  }

  /** Opening or reading the session clears the notice: the summary comes back without it and the badge drops. */
  private clearAgentsNotice(sessionId: string): void {
    if (!this.agentsNotices.delete(sessionId)) return
    this.emitSummary(sessionId)
  }

  private errorAttention(sessionId: string, itemId: string, text: string): void {
    const row = this.rows.get(sessionId)
    const project = row ? this.projects.get(row.project_id) : undefined
    // A child reports the error on the parent's card, not with a notification.
    if (row && project && !row.parent) this.attention({ kind: 'error', sessionId, projectId: project.id, itemId, title: `${project.name} · ${row.title}`, body: text })
  }

  /** Badge: one per open request, plus sessions stopped by an error that you have not seen yet. */
  private updateBadge(): void {
    let count = 0
    for (const row of this.rows.values()) {
      if (row.archived || row.parent || !this.projects.has(row.project_id)) continue
      if (row.run_state === 'waiting') count += Math.max(1, this.runtimes.get(row.id)?.pending.size ?? 0)
      else if ((row.run_state === 'error' && row.last_activity_seq > row.last_read_seq) || this.agentsNotices.has(row.id)) count++
    }
    count += this.plans.waitingCount((id) => this.rows.get(id)?.run_state === 'idle' && this.rows.get(id)?.archived === 0)
    this.updateActivity()
    if (count === this.badge) return
    this.badge = count
    this.notify({ type: 'badge', count })
  }

  /** Sessions that are working: the main process keeps the Mac awake if the user asked for it. */
  private updateActivity(): void {
    let running = 0
    for (const row of this.rows.values()) if (!row.archived && (row.run_state === 'running' || row.run_state === 'starting')) running++
    if (running === this.running) return
    this.running = running
    this.notify({ type: 'activity', running })
  }

  // ── Issues, PRs and merge ────────────────────────────────────────────────────

  private defaultBranchOf(project: Project): Promise<string> {
    let cached = this.defaultBranches.get(project.path)
    if (!cached) {
      cached = defaultBranch(project.path)
      this.defaultBranches.set(project.path, cached)
    }
    return cached
  }

  private async listIssues(projectId: string, source: 'github-issue' | 'github-pr' | 'branch'): Promise<IssueList> {
    const project = this.mustProject(projectId)
    if (!project.isGit) return { items: [], problem: t('The project is not a git repository.') }
    if (source === 'branch') {
      const branches = await listBranches(project.path)
      return {
        items: branches.map((b) => ({
          source: 'branch',
          ref: b.name,
          title: b.subject || b.name,
          body: null,
          url: null,
          branch: b.name,
          state: b.name === project.branch ? t('checked out here') : b.remote ? t('on origin') : t('local'),
          updatedAt: b.at
        })),
        problem: null
      }
    }
    const state = await ghState(project.path)
    if (state !== 'ok') return { items: [], problem: ghProblem(state) }
    try {
      return { items: source === 'github-issue' ? await listGithubIssues(project.path) : await listGithubPrs(project.path), problem: null }
    } catch (error) {
      return { items: [], problem: `gh: ${(error as Error).message}` }
    }
  }

  /** State for the "Ready to merge" panel: local git, PR, CI and comments. `fetch` first updates branches from origin. */
  private async mergeInfo(root: string, fetch: boolean): Promise<MergeInfo> {
    const project = [...this.projects.values()].find((p) => p.path === root) ?? this.projects.get([...this.rows.values()].find((r) => this.cwdOf(r) === root)?.project_id ?? '')
    if (!project) throw new Error(t('Folder unknown to Ladder.'))
    const info = await repoInfo(root)
    if (!info.isGit) throw new Error(t('The folder is not a git repository.'))
    const gh = await ghState(root)
    const fallbackBase = await this.defaultBranchOf(project)
    const branch = info.branch
    let ghError: string | null = gh === 'error' ? ghProblem('error') : null
    let details: PrDetails | null = null
    if (gh === 'ok' && branch && branch !== fallbackBase) {
      try {
        details = await prForBranch(root, branch)
        this.storePr(root, branch, details)
      } catch (error) {
        ghError = (error as Error).message
      }
    }
    const base = details?.status.base ?? fallbackBase
    if (fetch) await fetchRef(root, base).catch(() => undefined)
    const baseRef = (await resolveCommit(root, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base
    const counts = branch && branch !== base ? await aheadBehind(root, 'HEAD', baseRef) : null
    // Same source as the header (git.status) for the common fields: the two views always match. If the tracker has a reading
    // with no changes since then (5 s at most) that one applies: `merge.info` fires on every `fs.changed` and does not redo ~7 git processes.
    const local = await this.gitStatus.recent(root)
    const unpushed = local?.hasUpstream ? local.ahead : null
    // Next step and blocks are computed here, in one place (merge-flow.ts), on the same data as the header.
    const hasRemote = (await gitRead(root, ['remote']).catch(() => '')).trim().length > 0
    const conflicts = counts && counts.behind > 0 ? await mergeConflicts(root, 'HEAD', baseRef) : []
    const blocks = mergeBlocks({ pr: details?.status ?? null, checks: details?.checks ?? [], mergeState: details?.mergeState ?? null, conflicts })
    const agentBusy = this.busySession(root) !== null
    const isWorktree = this.isWorktreeRoot(root)
    const next = nextAction({
      branch,
      isDefaultBranch: branch === base,
      isWorktree,
      dirty: local?.dirty ?? 0,
      ahead: counts?.ahead ?? 0,
      unpushed,
      behindUpstream: local?.behind ?? 0,
      hasUpstream: unpushed !== null,
      hasRemote,
      gh: ghError ? 'error' : gh,
      pr: details?.status ?? null,
      prMergedCoversHead: details?.status.state === 'merged' ? await this.mergedCoversHead(root, details.headOid) : false,
      blocks,
      agentBusy
    })
    return {
      root,
      branch,
      base,
      isDefaultBranch: branch === base,
      dirty: local?.dirty ?? 0,
      ahead: counts?.ahead ?? 0,
      behind: counts?.behind ?? 0,
      unpushed,
      hasUpstream: unpushed !== null,
      conflicts,
      gh: ghError ? 'error' : gh,
      ghError,
      pr: details?.status ?? null,
      checks: details?.checks ?? [],
      comments: details?.comments ?? [],
      behindUpstream: local?.behind ?? 0,
      added: local?.added ?? 0,
      removed: local?.removed ?? 0,
      hasRemote,
      upstream: local?.upstream ?? null,
      prHeadOid: details?.headOid ?? null,
      mergeState: details?.mergeState ?? null,
      agentBusy,
      blocks,
      nextAction: next
    }
  }

  /** The folder is the worktree of a non-archived session (same criterion for the header and for `merge.info`). */
  private isWorktreeRoot(root: string): boolean {
    return [...this.rows.values()].some((r) => !r.archived && !!r.worktree && this.cwdOf(r) === root)
  }

  /** Is HEAD the merged PR's head or an ancestor of it (no new commit after the merge)? If it cannot be told (object not fetched), yes. */
  private async mergedCoversHead(root: string, oid: string | null): Promise<boolean> {
    if (!oid || !/^[0-9a-f]{40,64}$/.test(oid)) return true
    try {
      await gitRead(root, ['cat-file', '-e', `${oid}^{commit}`])
    } catch {
      return true
    }
    try {
      await gitRead(root, ['merge-base', '--is-ancestor', 'HEAD', oid])
      return true
    } catch {
      return false
    }
  }

  private storePr(root: string, branch: string, details: PrDetails | null): void {
    const key = `${root}\0${branch}`
    const before = JSON.stringify(this.prs.get(key)?.status ?? null)
    this.prs.set(key, details)
    // A merged PR is remembered on the branch's sessions (created before the merge): the map shows them merged even when archived and after a restart.
    const mergedAt = details?.status.state === 'merged' ? (details.status.mergedAt ?? null) : null
    if (mergedAt !== null) for (const row of this.rows.values()) if (this.cwdOf(row) === root && this.branchOf(row) === branch && mergedAt >= row.created_at) this.rememberMerged(row, 'pr', mergedAt)
    if (JSON.stringify(details?.status ?? null) === before) return
    for (const row of this.rows.values()) {
      if (!row.archived && this.cwdOf(row) === root && this.branchOf(row) === branch) this.emitSummary(row.id)
    }
  }

  /** Re-reads the PRs of branches with open sessions. Sessions in a worktree are archived when their PR is merged. */
  private async pollPrs(): Promise<void> {
    this.prTimer = null
    try {
      await this.refreshPrs()
    } finally {
      this.prTimer ??= setTimeout(() => void this.pollPrs(), PR_POLL_MS)
    }
  }

  private async refreshPrs(): Promise<void> {
    const targets = new Map<string, { root: string; branch: string; project: Project }>()
    for (const row of this.rows.values()) {
      const project = this.projects.get(row.project_id)
      const branch = this.branchOf(row)
      if (row.archived || !project?.isGit || !branch) continue
      targets.set(`${this.cwdOf(row)}\0${branch}`, { root: this.cwdOf(row), branch, project })
    }
    for (const { root, branch, project } of targets.values()) {
      try {
        if (!existsSync(root) || branch === (await this.defaultBranchOf(project)) || (await ghState(root)) !== 'ok') continue
        this.storePr(root, branch, await prForBranch(root, branch))
      } catch {
        // gh unreachable: retried next round.
      }
    }
    for (const row of [...this.rows.values()]) {
      const pr = this.prOf(row)
      if (row.archived || row.parent || !row.worktree || pr?.state !== 'merged' || this.mergedHandled.has(row.id)) continue
      // The merge date counts, not the last update: a comment on an old PR does not make it the session's.
      if ((pr.mergedAt ?? 0) < row.created_at || this.busySession(this.cwdOf(row))?.id === row.id) continue
      this.mergedHandled.add(row.id)
      await this.archiveMerged(row, pr).catch(() => undefined)
    }
  }

  /** Remembers how and when the session's branch was merged (the map reads it after a restart). Does not change `updated_at`. */
  private rememberMerged(row: SessionRow, via: 'git' | 'pr', at: number): void {
    if (row.merged_via === via && row.merged_at === at) return
    row.merged_via = via
    row.merged_at = at
    this.db.prepare('update sessions set merged_via = ?, merged_at = ? where id = ?').run(via, at, row.id)
  }

  /** Another non-archived chat session (not archiving) in the same folder: whoever inherits the services; null if none. */
  private worktreeHeir(row: SessionRow): SessionRow | null {
    const cwd = this.cwdOf(row)
    return [...this.rows.values()].find((r) => r.id !== row.id && !r.archived && !r.parent && !this.archiving.has(r.id) && r.mode === 'chat' && this.cwdOf(r) === cwd) ?? null
  }

  /** Another non-archived session uses the same working folder. */
  private worktreeShared(row: SessionRow): boolean {
    const cwd = this.cwdOf(row)
    // The folder of a running plan (or its separate worktree) counts too, until a session uses it.
    return [...this.rows.values()].some((r) => r.id !== row.id && !r.archived && !r.parent && this.cwdOf(r) === cwd) || this.plans.usesFolder(cwd)
  }

  /** Archives the session of a merged PR (`pr`) or of a branch already in the base (null) and removes the worktree if it is clean and no other session uses it. */
  private async archiveMerged(row: SessionRow, pr: PrStatus | null): Promise<GitArchiveResult> {
    const project = this.projects.get(row.project_id)
    if (!row.worktree) {
      await this.archive(row.id)
      this.rememberMerged(row, pr ? 'pr' : 'git', pr?.mergedAt ?? Date.now())
      return { archived: true, worktreeRemoved: false, worktreeKept: 'none' }
    }
    await this.archive(row.id, { cleanup: false })
    this.rememberMerged(row, pr ? 'pr' : 'git', pr?.mergedAt ?? Date.now())
    const cwd = this.cwdOf(row)
    // A worktree used by another session is left alone (not even the cleanup script).
    if (!project || this.worktreeShared(row)) {
      this.upsertItem(row.id, { kind: 'notice', id: randomUUID(), turnId: 'system', at: Date.now(), tone: 'info', text: t('Session archived; the worktree stays because another session uses it.') })
      this.flush()
      return { archived: true, worktreeRemoved: false, worktreeKept: 'shared' }
    }
    // The worktree is removed only if it is clean: git refuses on its own if there are changes or untracked files. The branch stays.
    const { removed, cleanup, error } = await removeWorktree(project, cwd, { port: this.ports.allocate(cwd), stopServices: () => this.stopServices(cwd) })
    // The worktree's port block is freed again, but not if the cleanup script failed or timed out: what it started (for
    // example a container) may still hold the ports, and a new worktree would find them taken.
    if (removed && (!cleanup || (cleanup.code === 0 && !cleanup.timedOut))) this.ports.release(cwd)
    this.noticeCleanup(row.id, cleanup)
    // Not removed: with uncommitted files it is 'dirty'; if it is clean and git refused anyway (submodules, permissions, missing folder) it is 'failed'.
    const dirty = !removed && existsSync(cwd) ? ((await gitStatus(cwd, true, false).catch(() => null))?.dirty ?? 0) > 0 : false
    const kept: GitArchiveResult['worktreeKept'] = removed ? null : dirty ? 'dirty' : 'failed'
    const reason = error ?? t('the folder no longer exists')
    this.upsertItem(row.id, {
      kind: 'notice',
      id: randomUUID(),
      turnId: 'system',
      at: Date.now(),
      tone: 'info',
      text: pr
        ? removed
          ? t('PR #{number} was merged: session archived and worktree removed (the branch stays).', { number: pr.number })
          : kept === 'dirty'
            ? t('PR #{number} was merged: session archived; the worktree stays because it has uncommitted files.', { number: pr.number })
            : t('PR #{number} was merged: session archived; git could not remove the worktree: {reason}', { number: pr.number, reason })
        : removed
          ? t('Session archived and worktree removed (the branch stays).')
          : kept === 'dirty'
            ? t('Session archived; the worktree stays because it has uncommitted files.')
            : t('Session archived; git could not remove the worktree: {reason}', { reason })
    })
    this.flush()
    return { archived: true, worktreeRemoved: removed, worktreeKept: kept, ...(kept === 'failed' ? { worktreeError: error } : {}) }
  }

  /**
   * "Archive" after the merge (`git.archive`). Only if the PR is merged (and the branch is entirely inside) or the branch is already in the base;
   * for a worktree never with uncommitted changes or with commits that exist only there. Every check comes before touching
   * anything: if one fails nothing has been archived.
   */
  private async archiveAfterMerge(sessionId: string): Promise<GitArchiveResult> {
    const row = this.mustRow(sessionId)
    if (row.archived) throw new Error(t('The session is already archived.'))
    const root = this.mustCwd(row)
    // One operation at a time per repo (push, merge, archive) and the background fetch stops.
    return withRepoLock(root, () => this.archiveLocked(row, root))
  }

  private async archiveLocked(row: SessionRow, root: string): Promise<GitArchiveResult> {
    const busy = () => new Error(t('The agent is working in this folder: wait for it to finish before archiving.'))
    if (this.busySession(root)) throw busy()
    const project = this.mustProject(row.project_id)
    const info = await repoInfo(root)
    const branch = info.isGit ? info.branch : null
    if (!branch) throw new Error(t('HEAD is detached: switch to a branch before archiving.'))
    const base = await this.defaultBranchOf(project)
    if (branch === base) throw new Error(t('This is the default branch: there is nothing to archive after a merge.'))

    // Is the PR merged? Re-read from GitHub (the cache may be old); without gh the last known one is used.
    let pr: PrStatus | null = null
    let headOid: string | null = null
    if ((await ghState(root)) === 'ok') {
      const details = await prForBranch(root, branch).catch(() => null)
      if (details) this.storePr(root, branch, details)
      if (details?.status.state === 'merged') (pr = details.status), (headOid = details.headOid)
    } else if (this.prOf(row)?.state === 'merged') pr = this.prOf(row)
    if (pr && !(await this.mergedCoversHead(root, headOid))) pr = null
    const baseRef = (await resolveCommit(root, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base
    const integrated = await gitRead(root, ['merge-base', '--is-ancestor', 'HEAD', baseRef]).then(() => true, () => false)
    if (!pr && !integrated) throw new Error(t('The pull request is not merged yet: archive after the merge.'))

    if (row.worktree) {
      const status = await gitStatus(root, true, false)
      if (status && status.dirty > 0) throw new Error(t('The worktree has uncommitted changes: commit or discard them first. Nothing was archived.'))
      // Commits that are neither on the base nor on a remote (nor the PR's head): archiving would leave them only in a removed worktree.
      // If the count cannot be read it is NOT archived: an error here cannot mean "no commits only here".
      const counted = await gitRead(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes', baseRef]).catch(() => null)
      if (counted === null || !/^\d+$/.test(counted.trim())) throw new Error(t('Could not check whether commits exist only in this worktree: nothing was archived.'))
      const only = Number(counted.trim())
      const head = (await resolveCommit(root, 'HEAD')) ?? ''
      if (only > 0 && !(pr && headOid && head === headOid)) {
        throw new Error(plural(only, '{n} commit exists only in this worktree: push it first. Nothing was archived.', '{n} commits exist only in this worktree: push them first. Nothing was archived.'))
      }
    }
    // After the network calls to gh and the checks: the agent may have started working in the meantime.
    if (this.busySession(root)) throw busy()
    this.mergedHandled.add(row.id)
    const result = await this.archiveMerged(row, pr)
    this.notifyFsChanged(root)
    return result
  }

  shutdown(): void {
    this.stopped = true
    if (this.prTimer) clearTimeout(this.prTimer)
    if (this.archiveTimer) clearTimeout(this.archiveTimer)
    if (this.limitTimer) clearInterval(this.limitTimer)
    for (const timer of this.agentsWait.values()) clearTimeout(timer)
    this.agentsWait.clear()
    this.flush()
    for (const runtime of this.runtimes.values()) runtime.adapter.close()
    void this.browserAgent.shutdown()
    void this.ladderMcp.close()
    this.connections.shutdown()
    this.shortcuts.close()
    this.terminals.shutdown()
    this.prFiles.shutdown()
    this.gitStatus.shutdown()
    this.branchMaps.shutdown()
    this.watcher.close()
  }
}

/** Agent with profiles that a terminal command starts (claude, codex); other: none. */
function terminalAgent(command: string | null): string {
  const program = basename(splitCommand(command ?? 'claude')[0] ?? '')
  return program === 'claude' ? 'claude-code' : program === 'codex' ? 'codex' : ''
}

function emptyCounts() {
  return { commands: 0, edits: 0, reads: 0, searches: 0 }
}

/** 'New session' placeholder in English or in any of the languages: there is no rename flag. */
function isPlaceholderTitle(title: string): boolean {
  return translations('New session').includes(title)
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || t('New session')
}

/** Splits a command into words respecting single and double quotes. No shell expansions. */
export function splitCommand(command: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started || current) words.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started || current) words.push(current)
  return words
}

function ghProblem(state: Exclude<Awaited<ReturnType<typeof ghState>>, 'ok'>): string {
  if (state === 'missing') return t('The GitHub gh CLI is required: connect it in Settings → Subscriptions (Connect GitHub).')
  if (state === 'unauthenticated') return t('gh is not logged in: connect it in Settings → Subscriptions (Connect GitHub).')
  if (state === 'error') return t('Could not check the GitHub login. Check your connection.')
  return t('The repository has no GitHub remote.')
}

/** Text of a request's notification. */
function requestBody(request: UserRequest): string {
  if (request.requestType === 'question') return t('Claude asks you a question: {title}', { title: request.title })
  if (request.command) return t('Claude asks to run: {command}', { command: request.command })
  if (request.path) return t('Claude asks to edit {path}', { path: request.path })
  return t('Claude asks to use {tool}', { tool: request.toolName })
}

/** File edit tools: the Edit level approves them on its own (apply_patch is Codex's). */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'])

/** Requests that a level change never approves: approving the plan is a user choice. */
const NEVER_AUTO = new Set(['ExitPlanMode'])

/** Origin of commands that do not come from a port (no window): a single fictitious connection. */
const LOCAL_ORIGIN = {}
/** Origin of the commands coming from the CLI socket (host/index.ts). */
export const CLI_ORIGIN = {}

/** Is the path (even of a file not yet created) inside the folder, once symlinks are resolved? */
async function insideDir(dir: string, path: string): Promise<boolean> {
  try {
    const root = await realpath(dir)
    let current = resolve(dir, path)
    const rest: string[] = []
    for (;;) {
      try {
        current = await realpath(current)
        break
      } catch {
        const parent = dirname(current)
        if (parent === current) return false
        rest.unshift(basename(current))
        current = parent
      }
    }
    const real = join(current, ...rest)
    return real === root || real.startsWith(root + sep)
  } catch {
    return false
  }
}

function describeResponse(item: Extract<ChatItem, { kind: 'request' }>, response: RequestResponse): string {
  if ('answers' in response) return Object.values(response.answers).join(', ')
  const option = item.options.find((o) => o.id === response.optionId)
  if (option?.kind === 'deny') return response.message ? t('Denied: {message}', { message: response.message }) : t('Denied')
  return option?.kind === 'allow-always' ? t('Always allowed') : t('Approved')
}

const REPORT_FILE_MAX = 256 * 1024
const REPORT_TEXT_MAX = 60_000

/** Folders from which we accept a subagent's output: temporaries and ~/.claude (real paths). */
async function reportRoots(): Promise<string[]> {
  const roots: string[] = []
  for (const dir of [tmpdir(), '/tmp', join(homedir(), '.claude')]) {
    try {
      roots.push(await realpath(dir))
    } catch {
      // missing folder
    }
  }
  return roots
}

/**
 * Output of a background subagent: only a regular, small file, inside known folders, opened without
 * following symlinks and read from the descriptor. A JSONL transcript is not a report: null.
 */
async function readReportFile(path: string | null): Promise<string | null> {
  if (!path || !isAbsolute(path)) return null
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    const real = await realpath(path)
    if (!(await reportRoots()).some((root) => real === root || real.startsWith(root + sep))) return null
    handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size > REPORT_FILE_MAX) return null
    const buffer = Buffer.alloc(Math.min(info.size, REPORT_FILE_MAX))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8').trim()
    if (!text || looksLikeTranscript(text)) return null
    return text.slice(0, REPORT_TEXT_MAX)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** JSON lines with type/message/sessionId: it is the CLI's transcript, not the report text. */
function looksLikeTranscript(text: string): boolean {
  const first = text.split('\n', 1)[0].trim()
  if (!first.startsWith('{')) return false
  try {
    const parsed = JSON.parse(first) as Record<string, unknown>
    return 'type' in parsed || 'message' in parsed || 'sessionId' in parsed
  } catch {
    return false
  }
}

