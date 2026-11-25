// Cuore dell'host: progetti, sessioni, elementi della chat e collegamento con adapter, terminali e git.
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
  SubagentInfo,
  UsageWindow,
  SlashCommand,
  TerminalInfo,
  WorktreeInfo,
  BrowserAgentResult
} from '@shared/protocol'
import { tx, type Db, type ProjectRow, type SessionRow } from './db'
import { plural, setLocale, t, translations } from '@shared/i18n'
import { ClaudeSession, type AdapterEvents, type ToolUpdate, type TurnResult, type UserRequest } from './claude/adapter'
import { acpAuthenticate, AcpSession } from './acp/adapter'
import { BrowserAgent } from './browser-agent'
import { LadderMcpServer, type DelegateArgs, type HandoffArgs, type LadderCall, type LadderToolName, type ReportArgs, type ToolOutcome } from './ladder-mcp'
import { isReadOnlyBash } from './claude/read-only'
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
/** Evento a una sola connessione (porta). */
type SendTo = (origin: object, event: HostEvent) => void
type Notify = (message: HostToMain) => void

/** Ogni quanto si rilegge lo stato delle PR dei branch con sessioni aperte. */
const PR_POLL_MS = Number(process.env.LADDER_PR_POLL_MS) || 90_000
/** Ogni quanto si cercano le sessioni da archiviare (AppPrefs.autoArchiveDays). */
const AUTO_ARCHIVE_EVERY_MS = 60 * 60_000
type ItemInput = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'seq'> : never) : never

interface PendingRequest {
  itemId: string
  resolve: (response: RequestResponse) => void
}

/** Agenti che dopo la chiusura del processo riprendono la stessa conversazione (Claude con resume, Codex con thread/resume). */
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
  /** Riga 'command' del turno avviato da un comando /: si chiude a fine turno. */
  command: { id: string; at: number; name: string; args: string } | null
  /** Handoff ("Switch to…") whose summary the current turn is writing; it closes at the end of the turn. */
  handoff?: HandoffRun | null
  /** L'utente ha chiesto l'interruzione del turno in corso. */
  interrupting: boolean
  /** Il turno in corso lo ha aperto l'agente da solo (risposta a un sotto-agente in background, messaggio inserito). */
  implicit?: boolean
  /** Sotto-agenti avviati e richieste aperte nel turno in corso: servono a turn-end.stalled. */
  turnAgents?: number
  turnRequests?: number
  /** Chiusure di turno in corso o in coda: onTurnEnd gira una alla volta per sessione. */
  closing: number
  /** L'agente è uscito: niente nuovi turni su questo runtime, la coda riparte con uno nuovo. */
  exited?: boolean
  /** Codex: passato a Full access a turno in corso, ogni nuova richiesta di questo turno si approva da sola. */
  approveAll?: boolean
  /** Nome del comando / eseguito dal turno in corso o dall'ultimo turno (null se era un messaggio). */
  lastCommand?: string | null
  startedAt: number
  ending: Promise<void>
}

/** Stato di una sessione terminale che non sta nel database: etichetta dell'attesa, attività e turno in corso. */
interface TerminalStatus {
  label: string | null
  activity: string | null
  turn: { id: string; start: Promise<string | null>; at: number } | null
  waitingSince: number | null
}

const FLUSH_MS = 33
/** Dopo l'ultimo background finito: se il coordinatore non riparte entro questo tempo, la chat offre "Continue". */
const AGENTS_WAIT_MS = 8_000
/** A turno chiuso, un sotto-agente "in corso" senza aggiornamenti da tanto (e che l'adapter non conosce) risulta fermato. */
const STALE_AGENT_MS = 10 * 60_000

/** Errore di una generazione di testo: uno strumento tentato (LAD-59) arriva all'utente com'è, ogni altro errore è "non ha risposto". */
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
  /** Quando è arrivato l'ultimo evento context per sessione: il ripiego di un turnEnd più vecchio non lo sovrascrive. */
  private contextAt = new Map<string, number>()
  /** Livello chiesto a turno in corso che l'agente applica solo dal turno successivo (Codex). */
  /** Cambi di livello in corso per sessione: si eseguono uno alla volta. */
  private permissionLocks = new Map<string, Promise<unknown>>()
  /** Ultimo elenco dei comandi / di ogni sessione, mandato dall'agente. */
  private commandLists = new Map<string, SlashCommand[]>()
  /** Ultimo elenco noto per (agente, cartella di lavoro): serve a una sessione che non ha ancora un processo. */
  private lastCommands = new Map<string, SlashCommand[]>()
  /** Elementi in memoria delle sessioni attive, per aggiornare lo streaming senza rileggere il database. */
  private liveItems = new Map<string, Map<string, ChatItem>>()
  private dirty = new Map<string, Map<string, ChatItem>>()
  private flushTimer: NodeJS.Timeout | null = null
  private claudeCli: string | null = null
  private codexCli: string | null = null
  private codexVer: string | null = null
  /** Stato di ogni agente: Claude Code, Codex e le voci ACP aggiunte. */
  private agents = new Map<string, AgentStatus>()
  private acpSpecs = new Map<string, AcpAgentSpec>()
  /** Stato di Claude Code e Codex per ogni profilo non predefinito (id del profilo); il predefinito sta in `agents`. */
  private profileAgents = new Map<string, AgentStatus>()
  private readonly profiles: Profiles
  private reviews = new Map<string, ReviewRun>()
  /** Sotto-agenti per sessione, per la mappa degli agenti; gli aggiornamenti al renderer si raggruppano. */
  private subagents = new SubagentBoard()
  private subagentFlush = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly terminals: TerminalManager
  /** LAD-79: "Altri agenti" nelle Subscription (stato di accesso, login e logout con la loro CLI). */
  private readonly otherAgents: OtherAgents
  private readonly watcher: RootWatcher
  /** LAD-70: id delle root servite dal protocollo ladder-file del main. */
  private readonly fileRoots: FileRoots
  /** Stato git per l'intestazione (LAD-68) e le iscrizioni della UI. */
  private readonly gitStatus: GitStatusTracker
  /** Iscrizioni a `git.watch` per connessione (finestra): connessione -> sessione -> cartella. Chiusa la porta, si tolgono tutte. */
  private readonly gitSubs = new Map<object, Map<string, string>>()
  /** Mappa dei branch (LAD-80) e le sue iscrizioni per connessione: connessione -> progetto -> conteggio. */
  private readonly branchMaps: BranchMapService
  private readonly branchMapSubs = new Map<object, Map<string, number>>()
  /** `fs.watch` per connessione: connessione -> cartella -> iscrizioni (un `off` non toglie quelle di un'altra finestra). */
  private readonly fsSubs = new Map<object, Map<string, number>>()
  private readonly ports: Ports
  /** Avvio dei servizi in corso, per sessione: archive() lo aspetta. */
  private readonly servicesStarting = new Map<string, Promise<void>>()
  /** Sessioni in archiviazione: i servizi non devono più partire. */
  private readonly archiving = new Set<string>()
  /** Archiviazioni in corso, per sessione: un secondo archive() aspetta la stessa promessa e project.remove le aspetta tutte. */
  private readonly archiveRuns = new Map<string, Promise<void>>()
  private readonly restarting = new Set<string>()
  /** Sessioni con un riavvio dell'agente chiesto a turno in corso: avviene alla prima fine turno senza lavoro aperto. */
  private readonly restartAfterTurn = new Set<string>()
  private termStatus = new Map<string, TerminalStatus>()
  /** Sessioni che aspettano lo script di setup del worktree prima di partire. */
  private preparing = new Set<string>()
  /** Progetti con un cambio di branch in corso nel checkout principale: le loro sessioni lì mettono i messaggi in coda finché non finisce. */
  private switchingBranch = new Set<string>()
  private stopped = false
  private prefs: HostPrefs = { generatedTitles: true, generatedText: true, autonomyHint: true, stallHint: false, worktreesDir: null, branchPrefix: DEFAULT_BRANCH_PREFIX, autoArchiveDays: null }
  /** Sessioni con un titolo in generazione: un solo tentativo alla volta. */
  private titling = new Set<string>()
  /** LAD-57 parte 2: browser per l'agente (server MCP, stato, canale verso il main). */
  private readonly browserAgent = new BrowserAgent({
    send: (message) => this.notify(message),
    broadcast: (event) => this.broadcast(event),
    setting: (projectId) => this.agentBrowserEnabled(projectId),
    alive: (sessionId) => (this.runtimes.has(sessionId) ? (this.rows.get(sessionId)?.project_id ?? null) : null),
    level: (sessionId) => (this.rows.get(sessionId)?.permission ?? 'ask') as PermissionLevel,
    request: (sessionId, request, signal) => this.openRequest(sessionId, request, signal)
  })
  /** Ladder MCP server (list_agents, handoff, delegate, report_result), for every chat session. */
  private readonly ladderMcp = new LadderMcpServer({
    enabled: (sessionId) => this.runtimes.has(sessionId) && !this.isGone(sessionId),
    listAgents: (sessionId) => this.ladderListAgents(sessionId),
    handoff: (sessionId, args, call, signal) => this.ladderHandoff(sessionId, args, call, signal),
    delegate: (sessionId, args, call, signal) => this.ladderDelegate(sessionId, args, call, signal),
    report: (sessionId, args) => this.ladderReport(sessionId, args)
  })
  /** Delegations in progress per child session. */
  private readonly delegations = new Map<string, Delegation>()
  /** Delegations started in a parent's current turn (reset every turn). */
  private readonly delegateCounts = new Map<string, { turnId: string; n: number }>()
  /** 'tool' rows already taken by a delegation (another parallel call does not reuse them). */
  private readonly claimedToolRows = new Set<string>()
  /** Sessioni con un messaggio di commit o un testo di PR in scrittura. */
  /** Generazioni di commit/PR in corso per sessione; text.cancel le annulla. */
  private writing = new Map<string, AbortController>()
  private prFiles = new PrFiles()
  /** Effort che l'agente dichiara all'avvio della sessione (init di Claude), per quando Ladder non ne ha scelto uno. */
  private initEffort = new Map<string, Effort>()
  /** Sessioni per cui il tentativo automatico di titolo è già partito (in memoria: una volta per avvio). */
  private titleTried = new Set<string>()
  private badge = -1
  /** Ultimo numero di sessioni al lavoro comunicato al main. */
  private running = 0
  private archiveTimer: NodeJS.Timeout | null = null
  /** Sotto-agenti in background finiti dall'ultima lettura della sessione: vanno nel summary e nel badge. */
  private agentsNotices = new Map<string, { finished: number; failed: number; at: number }>()
  /** Finiti (e falliti) non ancora annunciati: li raccoglie l'avviso 'done' quando i background sono tutti finiti. Si svuota a ogni avviso, a un turno in errore e all'uscita dell'agente. */
  /** Background finiti a sessione ferma (nessun turno aperto) dall'ultimo turno: se l'agente riparte da solo, la riga 'agent-start' lo dichiara. */
  private agentsBeforeTurn = new Map<string, number>()
  /** Background finiti (e falliti) a coordinatore fermo dall'ultimo turno: alimentano la riga 'agents-finished'. */
  private agentsIdle = new Map<string, { finished: number; failed: number }>()
  /** Attesa dopo l'ultimo agente: se nessun turno parte, nasce la riga 'agents-finished'. */
  private agentsWait = new Map<string, NodeJS.Timeout>()
  /** Id della riga 'agents-finished' ancora 'waiting', per sessione. */
  private agentsRows = new Map<string, string>()
  /** Ultimo turno chiuso per sessione: la riga 'agents-finished' sta in fondo a quel turno. */
  private lastTurnIds = new Map<string, string>()
  private agentsPending = new Map<string, { finished: number; failed: number }>()
  /** PR per cartella e branch (`root\0branch`); null: il branch non ha PR. */
  private prs = new Map<string, PrDetails | null>()
  private prTimer: NodeJS.Timeout | null = null
  private defaultBranches = new Map<string, Promise<string>>()
  /** Sessioni archiviate perché la loro PR è stata unita: non si riprovano. */
  private mergedHandled = new Set<string>()
  /** GitHub, Claude Code e Codex: stato, download dello strumento e login dal browser. */
  private readonly connections: Connections
  /** Agenti ACP in rimozione: un'installazione che finisce nel frattempo non li registra di nuovo. */
  private removingAcp = new Set<string>()
  /** Agenti ACP con un accesso in corso (`agents.authenticate`): la promessa si riusa per una seconda richiesta, `abort` serve a `agents.authenticate.cancel`. */
  private authenticating = new Map<string, { methodId: string; abort: AbortController; promise: Promise<AgentLogin> }>()
  /** Download dei binari degli agenti ACP (LAD-56). */
  private readonly installer = new AgentInstaller({
    update: (install) => this.broadcast({ type: 'agent.install', install }),
    installed: async (spec, signature) => {
      // Rimosso mentre l'installazione finiva: non si registra di nuovo.
      if (this.removingAcp.has(spec.id)) return
      const previous = this.acpSpecs.get(spec.id)
      try {
        spec.icon = await iconData(spec.icon ?? null)
        await this.registerAcp(spec)
        this.saveAcpSpecs()
        this.kvSet(`acp-signature:${spec.id}`, JSON.stringify({ version: spec.version ?? null, signature }))
      } catch (error) {
        // L'installatore rimette la cartella precedente: anche lo stato in memoria torna a quello di prima.
        if (previous) this.acpSpecs.set(spec.id, previous)
        else this.acpSpecs.delete(spec.id)
        // Se `acp-agents` era già stato scritto con la voce nuova, torna anche nel database (la cartella è quella vecchia).
        try {
          this.saveAcpSpecs()
        } catch {
          // Il database non risponde: non c'è altro da fare qui.
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
    /** Senza, gli eventi per una connessione sola (mappa dei branch) vanno a tutte. */
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
    // I checkout principali prendono i primi blocchi di porte (4100, …), prima di qualunque worktree.
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
    // Installazioni di agenti interrotte (app chiusa a metà): si ripristina o si pulisce prima di leggere gli agenti.
    const storedAcp = this.db.prepare(`select value from kv where key = 'acp-agents'`).get() as { value: string } | undefined
    const registered = new Map<string, AcpAgentSpec>()
    try {
      for (const spec of storedAcp ? (JSON.parse(storedAcp.value) as AcpAgentSpec[]) : []) registered.set(spec.id, spec)
    } catch {
      // Elenco illeggibile: si cancella `.old` come se non ci fosse niente di registrato.
    }
    await recoverInstalls((id) => registered.get(id) ?? null).catch(() => undefined)
    await this.initAgents()
    // Sessioni che erano "In coda" prima di questa versione: il primo messaggio in coda parte, una volta sola.
    for (const id of resumeQueued) this.startFirstQueued(id)
    this.updateBadge()
    this.shortcuts.start()
    this.prTimer = setTimeout(() => void this.pollPrs(), 4000)
    void this.autoArchive()
    // Lo stato dei collegamenti si legge in background: arriva alla UI come eventi.
    void this.connections.list().catch(() => undefined)
  }

  // ── Agenti ─────────────────────────────────────────────────────────────────

  /** Account e modelli dell'ultima sessione: servono al composer prima che parta una nuova sessione. */
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
      name: 'Claude Code',
      kind: 'native',
      account: claude.account ?? null,
      email: claude.email ?? null,
      usage: claude.usage ?? [],
      usageAt: claude.usageAt ?? null,
      models: claude.models ?? [],
      available: Boolean(claudeCli),
      version: claudeVer,
      path: claudeCli,
      error: claudeCli ? null : t('Claude Code was not found. Reinstall Ladder or sign in with the Claude Code CLI.')
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
    // All'avvio: account, modelli e limiti di Claude Code, senza aspettare la prima sessione. Se non risponde lo saprà la sessione.
    if (claudeCli) {
      void probeClaude(claudeCli)
        .then((info) => this.updateAgent('claude-code', info))
        .catch(() => undefined)
    }
    // Un profilo non predefinito ha stato, account e limiti suoi: si legge in background come il predefinito.
    for (const profile of this.profiles.all()) {
      if (profile.isDefault) continue
      this.profileStatus(profile)
      this.probeProfile(profile)
    }
    // Account, modelli e limiti di Codex senza aspettare la prima sessione (nessun turno, nessuna quota).
    if (codexCli) {
      void probeCodex(codexCli, '0.0.0')
        .then((info) => this.updateAgent('codex', info))
        .catch((error: Error) => this.updateAgent('codex', { error: t('Codex is not responding: {message}', { message: error.message }) }))
    }
    const stored = this.db.prepare(`select value from kv where key = 'acp-agents'`).get() as { value: string } | undefined
    for (const spec of stored ? (JSON.parse(stored.value) as AcpAgentSpec[]) : []) await this.registerAcp(spec)
  }

  /** Stato di un profilo non predefinito: gli stessi dati dello strumento del predefinito, e account, modelli e limiti suoi. */
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
      // Finché il profilo non è letto, i modelli sono quelli del predefinito (di solito gli stessi).
      models: cached.models?.length ? cached.models : base.models,
      limits: cached.limits ?? null
    }
    this.profileAgents.set(profile.id, status)
    return status
  }

  /** Account, modelli e limiti del profilo senza aprire sessioni; in background. */
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
    // Un percorso assoluto (CLI rilevata, binario scaricato) deve esistere ancora.
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

  /** Firma registrata all'installazione di una versione (codesign), null se ignota. */
  private signatureOf(id: string, version: string): AgentSignature | null {
    try {
      const saved = JSON.parse(this.kvGet(`acp-signature:${id}`) ?? 'null') as { version: string | null; signature: AgentSignature } | null
      return saved && saved.version === version ? saved.signature : null
    } catch {
      return null
    }
  }

  /** Dipendenze del catalogo agenti (`agents.catalog` e `agents.detect`). */
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
   * Accesso con un metodo dell'agente (ACP `authenticate`): niente credenziali passano da Ladder. Una seconda richiesta con lo
   * stesso metodo mentre l'accesso è in corso riusa la stessa promessa (un solo processo); con un altro metodo è un errore.
   * Se l'accesso viene annullato (`agents.authenticate.cancel`) risponde il login com'era, senza errore.
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
    // La voce si libera solo se è ancora questa (un cancel seguito da una nuova richiesta non deve toglierne un'altra).
    void promise.then(
      () => undefined,
      () => undefined
    ).finally(() => {
      if (this.authenticating.get(id) === entry) this.authenticating.delete(id)
    })
    return promise
  }

  /** Ferma un accesso in corso: uccide il processo dell'agente e libera l'id subito. */
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
      // Binario già scaricato o CLI rilevata nel PATH, poi npx/uvx. Il solo binario da scaricare passa da `agents.install`.
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
      // Un'installazione o un aggiornamento in corso si ferma e ripulisce prima di toccare la cartella.
      const hadJob = await this.installer.cancelAndWait(id)
      const spec = this.acpSpecs.get(id)
      const registered = this.acpSpecs.delete(id)
      // Il binario scaricato da Ladder si toglie con l'agente (anche se l'installazione è finita senza registrarlo); una CLI dell'utente non si tocca.
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

  /** `reset`: dopo un logout account, email e limiti si azzerano (altrimenti un valore assente non cancella quello precedente). */
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
   * Dopo un download, un login o un logout: ricerca la CLI, aggiorna disponibilità e versione e rilegge
   * account, modelli e limiti dell'agente senza aprire sessioni. GitHub non è un agente: niente da fare qui.
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
      patch = { available: Boolean(cli), path: cli, version: cli ? await claudeVersion(cli) : null, error: cli ? null : t('Claude Code was not found. Reinstall Ladder or sign in with the Claude Code CLI.') }
    } else {
      const cli = await findCodexCli()
      this.codexCli = cli
      this.codexVer = cli ? await codexVersion(cli) : null
      patch = { available: Boolean(cli), path: cli, version: this.codexVer, error: cli ? null : t('Codex not found. Install the CLI (npm i -g @openai/codex, or the Codex app) and reopen Ladder.') }
    }
    // Lo strumento è uno solo: disponibilità e versione valgono per il predefinito e per ogni profilo; il reset solo per quello che è cambiato.
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

  /** Limiti d'uso letti di nuovo, con un processo di breve durata e nessun turno. Due clic ravvicinati condividono la stessa lettura. */
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

  /** L'adapter giusto per l'agente: le sessioni e le review lo usano allo stesso modo. */
  private createAdapter(agent: string, options: SessionOptions & { outputSchema?: unknown }, events: AdapterEvents, profileId: string | null = null): AgentSession {
    const status = this.agents.get(agent)
    if (!status) throw new Error(t('Unknown agent: add it in Settings → Agents.'))
    if (!status.available) throw new Error(status.error ?? t('{agent} is not available.', { agent: status.name }))
    // Le credenziali dell'account stanno nella cartella del profilo; senza, quelle della CLI.
    const configDir = this.profiles.configDir(profileId)
    if (agent === 'claude-code') return new ClaudeSession({ ...options, cli: this.claudeCli, configDir }, events)
    if (agent === 'codex') return new CodexSession({ ...options, cli: this.codexCli!, version: '0.0.0', configDir }, events)
    const spec = this.acpSpecs.get(agent.replace(/^acp:/, ''))
    if (!spec) throw new Error(t('Unknown ACP agent.'))
    return new AcpSession({ ...options, spec, onLogin: (login) => this.saveLogin(spec.id, login) }, events)
  }

  // ── Review con un altro agente ────────────────────────────────────────────

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

  /** LAD-57 parte 2: risposta del main a un'operazione sul browser dell'agente. */
  browserAgentResult(rid: string, result: BrowserAgentResult): void {
    this.browserAgent.onResult(rid, result)
  }

  /** LAD-57 parte 2: la vista dell'agente è stata chiusa dal main (tab o finestra chiusa). */
  browserAgentClosed(sessionId: string): void {
    this.browserAgent.onClosed(sessionId)
  }

  /** Preferenze dal processo main. */
  setPrefs(prefs: HostPrefs): void {
    if (prefs.locale) setLocale(prefs.locale)
    this.prefs = { generatedTitles: prefs.generatedTitles ?? this.prefs.generatedTitles, generatedText: prefs.generatedText ?? this.prefs.generatedText, autonomyHint: prefs.autonomyHint ?? this.prefs.autonomyHint, stallHint: prefs.stallHint ?? this.prefs.stallHint, worktreesDir: prefs.worktreesDir !== undefined ? prefs.worktreesDir : this.prefs.worktreesDir, branchPrefix: prefs.branchPrefix !== undefined ? cleanBranchPrefix(prefs.branchPrefix) : this.prefs.branchPrefix, autoArchiveDays: prefs.autoArchiveDays !== undefined ? prefs.autoArchiveDays : this.prefs.autoArchiveDays, agentBrowser: prefs.agentBrowser ?? this.prefs.agentBrowser }
    this.browserAgent.sync()
    void this.autoArchive()
  }

  /** Sessioni che lavoravano quando Ladder è stato chiuso: tornano ferme, con una nota e le richieste scadute. */
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
      // Stato 'queued' di versioni precedenti (limite di turni, ora tolto): torna ferma, i messaggi restano in coda e il primo riparte.
      if ((row.run_state as string) === 'queued') {
        this.updateRow(row.id, { run_state: 'idle' })
        if (!row.archived && (JSON.parse(row.queue) as QueuedMessage[]).length) resume.push({ id: row.id, at: row.updated_at })
        continue
      }
      if (row.run_state === 'idle' || row.run_state === 'error') continue
      if (row.mode === 'terminal') {
        // Il processo non c'è più: la vista della sessione offre "Riprendi".
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

  /** Fa partire il primo messaggio in coda di una sessione ferma (migrazione dallo stato 'queued'). */
  private startFirstQueued(sessionId: string): void {
    const row = this.rows.get(sessionId)
    if (!row || row.archived || row.run_state !== 'idle') return
    const queue = JSON.parse(row.queue) as QueuedMessage[]
    const next = queue.shift()
    if (!next) return
    this.updateRow(sessionId, { queue: JSON.stringify(queue) })
    void this.startTurn(sessionId, next.text, next.attachments ?? []).catch((e: Error) => {
      // Il messaggio torna in testa alla coda e il runtime si chiude, come nella ripartenza dopo exit.
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

  /** Righe 'agents-finished' rimaste 'waiting' da prima del riavvio: superate se la sessione ha avuto turni dopo, altrimenti restano (un turno futuro le chiude). */
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
    // I branch cambiano fuori da Ladder: li rileggiamo a ogni nuova connessione della UI.
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
      connections: this.connections.cached()
    }
  }

  // ── Comandi dalla UI ─────────────────────────────────────────────────────

  /** `origin`: la connessione (porta) da cui arriva il comando; serve alle iscrizioni, che spariscono con lei (`connectionClosed`). */
  async handle(command: HostCommand, origin: object = LOCAL_ORIGIN): Promise<unknown> {
    switch (command.type) {
      case 'hello':
        return this.snapshot()
      case 'project.add':
        return this.addProject(command.path)
      case 'project.remove':
        // Le archiviazioni in corso del progetto finiscono prima (script di pulizia compreso), poi il progetto sparisce.
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
        return this.createSession(command)
      case 'session.resume':
        return this.resumeTerminalSession(command.sessionId)
      case 'session.send':
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
          // Il titolo scelto a mano vince su ogni generazione automatica.
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
      case 'project.files': {
        const project = this.projects.get(command.projectId)
        if (!project) throw new Error(t('Project not found.'))
        return project.isGit ? listFiles(project.path) : (await listTree(project.path)).files
      }
      case 'session.queue.set': {
        // La UI riceve la coda senza i dati delle immagini: gli allegati restano quelli salvati qui.
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
        this.respond(command.sessionId, command.requestId, command.response, command.via ?? 'chat')
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
      // ── LAD-57 parte 2 ──
      case 'browser.agent.stop':
        return this.browserAgent.stop(command.sessionId)
      case 'browser.agent.resume':
        return this.browserAgent.resume(command.sessionId)
      case 'browser.agent.state':
        return this.browserAgent.snapshot(command.sessionId)
      // ── Fine LAD-57 parte 2 ──

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

      // File, diff e cronologia.
      case 'fs.tree':
        return listTree(this.knownRoot(command.root))
      case 'fs.read':
        return readText(this.knownRoot(command.root), command.path, this.fileRoots.idFor(this.knownRoot(command.root)))
      // ── LAD-70 ──
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
      // ── Fine LAD-70 ──
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
          // Si toglie solo ciò che questa connessione ha iscritto.
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

      // Configurazione del progetto e azioni di avvio.
      case 'project.settings':
        return loadProjectSettings(this.mustProject(command.projectId).path)
      case 'run.start':
        return this.startRun(command.projectId, command.sessionId ?? null, command.name)
      case 'project.worktree.set': {
        const project = this.mustProject(command.projectId)
        await saveWorktreeSettings(project.path, command.patch)
        // Il file personale non va in git.
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

      // Ricerca, issue, merge e prompt.
      case 'search':
        return searchItems(this.db, this.rows, command.query)
      case 'issues.list':
        return this.listIssues(command.projectId, command.source)
      case 'merge.info':
        return this.mergeInfo(this.knownRoot(command.root), command.fetch === true)
      case 'prompt.render':
        return renderPrompt(this.mustProject(command.projectId).path, command.name, command.vars)

      // Agenti ACP e review.
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
      // ── LAD-80 ──
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
          // Un `off` toglie solo un'iscrizione di questa finestra, mai quelle di un'altra.
          if (count === 1) subs.delete(projectId)
          else subs.set(projectId, count - 1)
          // Senza più iscrizioni la connessione esce dall'elenco (`touchBranchMapOf` si ferma subito con l'elenco vuoto).
          if (subs.size === 0) this.branchMapSubs.delete(origin)
          this.branchMaps.unwatch(projectId)
        }
        return null
      }
      // ── fine LAD-80 ──
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
      // ── LAD-69 ──
      case 'git.push.preview':
        return pushPreview(this.mustCwd(this.mustRow(command.sessionId)), { remote: command.remote })
      case 'git.push': {
        const root = this.mustCwd(this.mustRow(command.sessionId))
        try {
          return await pushBranch(root, { publish: command.publish === true, remote: command.remote, expectedHead: command.expectedHead }, () => this.busySession(root) !== null)
        } finally {
          // Riuscito o rifiutato, chip e pannello si rileggono subito.
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
          // Stato della PR riletto subito: la sessione e il pannello mostrano "unita" senza aspettare il giro periodico.
          const details = await prForBranch(root, info.branch).catch(() => null)
          if (details) this.storePr(root, info.branch, details)
          return { ...result, pr: details?.status ?? null }
        } catch (error) {
          // Anche dopo un errore (per esempio nessuna risposta di gh: GitHub potrebbe aver unito) lo stato della PR si rilegge.
          const details = await prForBranch(root, info.branch).catch(() => null)
          if (details) this.storePr(root, info.branch, details)
          throw error
        } finally {
          this.notifyFsChanged(root)
        }
      }
      case 'git.archive':
        return this.archiveAfterMerge(command.sessionId)
      // ── fine LAD-69 ──
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

  /** Cartella di lavoro della sessione: il worktree se c'è, altrimenti il progetto. */
  private cwdOf(row: SessionRow): string {
    return row.cwd ?? this.projects.get(row.project_id)?.path ?? ''
  }

  /** Cartella di lavoro della sessione, o errore se non c'è più (progetto rimosso): con '' git lavorerebbe nella cartella corrente dell'host. */
  private mustCwd(row: SessionRow): string {
    const cwd = this.cwdOf(row)
    if (!cwd) throw new Error(t('Folder unknown to Ladder.'))
    return cwd
  }

  /** Solo le cartelle di progetti e sessioni: la UI non può chiedere file da altre parti del disco. */
  private knownRoot(root: string): string {
    const normalized = root.replace(/\/+$/, '')
    // '/' diventa '' e combacerebbe con le sessioni senza cartella.
    if (!normalized) throw new Error(t('Folder unknown to Ladder.'))
    for (const project of this.projects.values()) if (project.path === normalized) return normalized
    for (const row of this.rows.values()) if (this.cwdOf(row) === normalized) return normalized
    throw new Error(t('Folder unknown to Ladder.'))
  }

  /** Cambio nella cartella: la UI rilegge albero e diff, e lo stato git dell'intestazione si aggiorna subito. */
  private notifyFsChanged(root: string): void {
    this.broadcast({ type: 'fs.changed', root })
    this.gitStatus.refresh(root)
    this.touchBranchMapOf(root)
  }

  /** Sessione non archiviata che lavora nel checkout principale del progetto (non in un worktree) con un turno, sotto-agenti o un'attesa in corso. */
  private mainCheckoutBusy(project: Project): SessionRow | null {
    for (const row of this.rows.values()) {
      if (row.archived || row.project_id !== project.id || row.worktree || this.cwdOf(row) !== project.path) continue
      const runtime = this.runtimes.get(row.id)
      if (this.isBusyNow(row.id) || row.run_state === 'running' || row.run_state === 'starting' || row.run_state === 'waiting' || (runtime && this.agentBusy(row.id, runtime))) return row
    }
    return null
  }

  /** Branch locali del progetto per il menu del branch e per il punto di partenza di un worktree. */
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
   * Cambio o creazione di branch nel checkout principale. Il rifiuto per la sessione al lavoro si rilegge dentro il lock, subito
   * prima di scrivere. Dopo, il progetto, le sessioni del checkout principale, lo stato git e la mappa si aggiornano come per un cambio fatto altrove.
   */
  private async changeBranch(projectId: string, run: (project: Project, assertIdle: () => void) => Promise<BranchSwitchResult>): Promise<BranchSwitchResult> {
    const project = this.mustProject(projectId)
    if (!project.path || !project.isGit || !existsSync(project.path)) throw new Error(t('The project is not a git repository.'))
    if (this.switchingBranch.has(projectId)) throw new Error(t('The branch is already being changed in this project. Wait a moment.'))
    // Da qui nessun turno nuovo parte nel checkout principale (i messaggi vanno in coda); quelli già in corso li vede `assertIdle`.
    this.switchingBranch.add(projectId)
    const assertIdle = () => {
      const busy = this.mainCheckoutBusy(project)
      if (busy) throw new Error(t('“{title}” has an agent at work in the main checkout. Wait for it to finish or stop it, then change branch.', { title: busy.title }))
    }
    try {
      return await run(project, assertIdle)
    } finally {
      this.switchingBranch.delete(projectId)
      // I messaggi arrivati durante il cambio ripartono ora, nel branch nuovo.
      for (const row of this.rows.values()) if (row.project_id === projectId && !row.worktree && !row.archived) this.startFirstQueued(row.id)
      // Riuscito o no, ciò che si vede si rilegge: git può aver cambiato HEAD anche prima di un errore tardivo.
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

  /** LAD-80: la mappa nuova va solo alle connessioni iscritte a quel progetto. */
  private emitBranchMap(projectId: string, map: BranchMap): void {
    const event: HostEvent = { type: 'project.branchMap', projectId, map }
    if (!this.sendTo) return this.broadcast(event)
    for (const [origin, subs] of this.branchMapSubs) if (subs.has(projectId)) this.sendTo(origin, event)
  }

  /** LAD-80: la cartella è cambiata (file, commit, fetch): se una finestra guarda la mappa del suo progetto, si rilegge. */
  private touchBranchMapOf(root: string): void {
    if (this.branchMapSubs.size === 0) return
    const row = [...this.rows.values()].find((r) => this.cwdOf(r) === root)
    const projectId = row?.project_id ?? [...this.projects.values()].find((p) => p.path === root)?.id
    // Solo un cambio nel checkout principale rende vecchio il conteggio dei suoi file non committati.
    if (projectId) this.branchMaps.touch(projectId, [...this.projects.values()].some((p) => p.id === projectId && p.path === root))
  }

  /** Righe e ramo principale per la mappa dei branch (LAD-80): dati dell'host e cache delle PR, nessuna chiamata a gh (nemmeno per la base). */
  private async branchMapSource(projectId: string): Promise<BranchMapSource> {
    const project = this.mustProject(projectId)
    // Con un percorso vuoto git lavorerebbe nella cartella corrente dell'host.
    if (!project.path) throw new Error(t('Folder unknown to Ladder.'))
    const usable = project.isGit && existsSync(project.path)
    // Base senza rete: se il pannello Merge l'ha già risolta (anche con gh) vale quella, altrimenti origin/HEAD, main o master.
    const base = usable ? await (this.defaultBranches.get(project.path) ?? defaultBranch(project.path, false)) : null
    const rows: BranchMapRow[] = []
    for (const row of this.rows.values()) {
      if (row.project_id !== projectId || !usable || row.parent) continue
      let worktree: WorktreeInfo | null = null
      try {
        worktree = row.worktree ? (JSON.parse(row.worktree) as WorktreeInfo) : null
      } catch {
        // Riga con JSON rovinato: non si sa dov'è né su quale branch, quindi non entra nella mappa (le altre sì).
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
        // Come in refreshPrs: una PR unita prima della nascita della sessione è di un branch omonimo precedente (conta mergedAt, non updatedAt).
        prMerged: mergedAt !== null && mergedAt >= row.created_at ? { at: mergedAt, oid: pr?.headOid ?? null } : null,
        saved: row.merged_via === 'git' || row.merged_via === 'pr' ? { via: row.merged_via, at: row.merged_at } : null
      })
    }
    return { root: project.path, base, rows }
  }

  /** Iscrive la connessione agli aggiornamenti git della cartella della sessione (una volta sola per connessione e sessione). */
  private subscribeGit(origin: object, sessionId: string, root: string): void {
    const subs = this.gitSubs.get(origin) ?? new Map<string, string>()
    if (subs.has(sessionId) || !root) return
    subs.set(sessionId, root)
    this.gitSubs.set(origin, subs)
    this.watcher.watch(root)
    this.gitStatus.track(root)
  }

  /** Toglie l'iscrizione di una connessione; senza `origin` (sessione archiviata, progetto rimosso) quelle di tutte. */
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

  /** Una connessione (finestra) si è chiusa: le sue iscrizioni a git e ai file spariscono con lei. */
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

  /** Iscrizioni attive (per i test): git e fs. */
  subscriptionCount(): { git: number; fs: number } {
    let git = 0
    let fs = 0
    for (const subs of this.gitSubs.values()) git += subs.size
    for (const subs of this.fsSubs.values()) for (const n of subs.values()) fs += n
    return { git, fs }
  }

  /** Una sessione che sta scrivendo in `root`, se c'è. */
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
    // Stato vuoto subito (nessun account finché non si fa il login): la UI ha già la riga da mostrare.
    this.broadcast({ type: 'agent.status', status: this.profileStatus(profile) })
    this.broadcast({ type: 'profile.upsert', profile })
    return profile
  }

  /**
   * Toglie un profilo. Con una sessione attiva che lo usa rifiuta; le sessioni ferme passano al predefinito (il loro processo
   * si chiude: il prossimo messaggio riparte senza la cartella del profilo). La cartella di configurazione resta: ci sono le credenziali.
   */
  private removeProfile(profileId: string): void {
    const profile = this.profiles.mustGet(profileId)
    if (profile.isDefault) throw new Error(t('The default account cannot be removed.'))
    // Anche le archiviate: tengono un profilo che non c'è più.
    const users = [...this.rows.values()].filter((r) => r.profile_id === profileId)
    const active = users.some((r) => !r.archived && (this.isBusy(r.id) || r.run_state === 'running' || r.run_state === 'starting'))
    if (active) throw new Error(t('A session is using this account. Wait for it to finish, then try again.'))
    // Un terminale vivo (anche un TUI fermo al prompt, run_state idle) ha la cartella del profilo nell'ambiente.
    if (users.some((r) => this.terminals.bySession(r.id, 'agent').some((term) => term.state === 'running'))) {
      throw new Error(t('A terminal is using this account. Close it, then try again.'))
    }
    this.connections.forget(profileId)
    this.profiles.remove(profileId)
    this.profileAgents.delete(profileId)
    this.db.prepare('delete from kv where key = ?').run(`agent:${profile.agent}:${profileId}`)
    for (const row of users) {
      // Prima la revoca: scioglie le conferme del browser dell'agente ancora aperte, finché il runtime le trova.
      this.revokeTools(row.id)
      this.runtimes.get(row.id)?.adapter.close()
      this.runtimes.delete(row.id)
      // La conversazione sta nella cartella del profilo: col predefinito il resume non la troverebbe, riparte una nuova.
      // La trascrizione in Ladder resta.
      // Per i terminali la conversazione da riprendere è agent_ref.
      this.updateRow(row.id, { profile_id: null, external_id: null, ...(row.mode === 'terminal' ? { agent_ref: null } : {}) })
      if (!row.archived) this.emitSummary(row.id)
    }
    // Anche i progetti che lo avevano scelto tornano al predefinito.
    for (const project of this.projects.values()) {
      if (!Object.values(project.profiles ?? {}).includes(profileId)) continue
      this.refreshProject(project.id)
    }
    this.broadcast({ type: 'profile.removed', profileId })
  }

  /** Il profilo con cui un progetto avvia le nuove sessioni di un agente; le sessioni esistenti tengono il loro. */
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
    // File personali di Ladder fuori da git, senza toccare il .gitignore del progetto.
    if (project.isGit) void ensureExcluded(project.path, PERSONAL_PATTERNS).catch(() => undefined)
    this.broadcast({ type: 'project.upsert', project })
    this.projectGroups.sync()
    return project
  }

  private async createSession(command: Extract<HostCommand, { type: 'session.create' }>): Promise<SessionSummary> {
    const project = this.mustProject(command.projectId)
    const mode = command.mode ?? 'chat'
    const now = Date.now()
    const shellCommand = mode === 'terminal' ? (command.command?.trim() || 'claude') : null
    const title = command.title?.trim() || (mode === 'terminal' && !command.text.trim() ? shellCommand! : titleFrom(command.text))

    // Worktree: cartella e branch nuovi, file da copiare, poi lo script di setup prima di partire.
    let worktree: WorktreeInfo | null = null
    const settings = await loadProjectSettings(project.path)
    // Regole del progetto ([agents] in .ladder/settings.toml): agenti ammessi e livello di permesso massimo.
    if (mode === 'chat') this.assertHandoffAgent(settings, command.agent)
    // Profilo (account) della sessione: scelto qui, poi non cambia più (nemmeno alla ripresa).
    // Una sessione terminale ha agente 'claude-code' per la UI: il profilo è quello del programma del comando.
    const programAgent = mode === 'terminal' ? terminalAgent(shellCommand) : command.agent
    const requested = mode === 'terminal' && command.profileId && !isDefaultProfileId(command.profileId) && this.profiles.get(command.profileId)?.agent !== programAgent ? null : command.profileId
    const profileId = this.profiles.resolve(programAgent, project.id, requested)
    command = { ...command, permission: clampPermission(command.permission, settings.agents.permissionsMax) }
    const notices: string[] = []
    // Un branch esistente già estratto nel checkout principale non può avere un worktree: si lavora lì.
    let wanted: WorktreeBranch | null = command.branch ?? null
    // Nome scelto nella nuova chat: usato così com'è. Un branch che esiste già non si riusa di nascosto (lo farebbe `wanted` come "esistente").
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
      // Il branch non si rinomina dopo la creazione: se il messaggio cita un'issue, il suo identificatore entra nel nome.
      // Il nome suggerito da Linear richiede la sua API con le credenziali dell'utente: non si usa.
      const ref = wanted ? null : issueRef(command.text, this.teamsOf(project.id))
      // Senza issue citata e con i titoli generati accesi, il nome del branch lo propone il modello piccolo (timeout breve: si ricade sul titolo).
      const named = !wanted && !ref && mode === 'chat' ? await this.branchName(project.id, command.agent, profileId, command.text) : null
      const created = await createWorktree(project, withIssue(named ?? title, ref, ' '), settings.worktree.copy, wanted, { dir: this.prefs.worktreesDir, branchPrefix: this.prefs.branchPrefix, startFrom: startFrom || undefined, strictName: Boolean(chosenName) })
      worktree = created.info
      // Lo slot di porte si sceglie ora, saltando i blocchi la cui base è occupata da qualcun altro.
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
      // Un titolo dato alla creazione è una scelta dell'utente.
      title_source: command.title?.trim() ? 'user' : 'provisional',
      profile_id: profileId,
      permission_next: null,
      merged_via: null,
      merged_at: null,
      handoff_from: null,
      handoff: null,
      parent: null
    }
    this.insertSession(row)
    for (const text of notices) this.upsertItem(row.id, { kind: 'notice', id: randomUUID(), turnId: 'system', at: now, tone: 'info', text })

    const begin = async () => {
      if (mode === 'terminal') this.startTerminalAgent(row.id, command.text.trim() || null)
      else await this.send(row.id, command.text, command.attachments ?? [])
    }

    if (worktree && settings.worktree.setup && (command.setupWait ?? settings.worktree.setupWait) === false) {
      // La sessione parte subito; lo script gira in parallelo nel terminale "setup" e un'uscita con errore si segnala.
      this.emitSummary(row.id)
      void this.runSetup(row.id, project, worktree.path, settings.worktree.setup).then((code) => {
        // Archiviata durante il setup: l'uscita è dovuta alla chiusura del terminale, niente note.
        if (this.isGone(row.id)) return
        this.noticeSetupFailed(row.id, code, false)
        return this.startServices(row.id, project, worktree.path, settings.worktree, code)
      })
      await begin()
    } else if (worktree && settings.worktree.setup) {
      // Il primo messaggio aspetta in coda che il setup finisca; nel frattempo la sessione è "in corso".
      this.preparing.add(row.id)
      if (mode === 'chat') {
        const queued: QueuedMessage = { id: randomUUID(), text: command.text, ...(command.attachments?.length ? { attachments: command.attachments } : {}) }
        this.updateRow(row.id, { queue: JSON.stringify([queued]) })
      }
      this.updateRow(row.id, { run_state: 'running' })
      this.termStatus.set(row.id, { label: null, activity: t('Preparing the worktree…'), turn: null, waitingSince: null })
      this.emitSummary(row.id)
      void this.runSetup(row.id, project, worktree.path, settings.worktree.setup).then(async (code) => {
        this.preparing.delete(row.id)
        this.termStatus.delete(row.id)
        // Archiviata durante il setup: niente note, servizi né messaggio in coda. Se l'archiviazione non è finita
        // (o è fallita) lo stato «in corso» del setup non deve restare.
        if (this.isGone(row.id)) {
          if (this.rows.get(row.id)?.run_state === 'running') this.updateRow(row.id, { run_state: 'idle' })
          return
        }
        this.updateRow(row.id, { run_state: 'idle' })
        this.noticeSetupFailed(row.id, code, true)
        await this.startServices(row.id, project, worktree.path, settings.worktree, code)
        // Archiviata mentre i servizi partivano: archive() aspetta la stessa promessa e riprende prima di noi.
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
      })
    } else {
      this.emitSummary(row.id)
      // Senza setup i servizi partono subito.
      if (worktree) void this.startServices(row.id, project, worktree.path, settings.worktree, 0)
      await begin()
    }
    return this.summary(row.id)
  }

  /**
   * Avvia i servizi del worktree (`[[worktree.services]]`, LAD-66), uno in un terminale `service`. `setupCode`: esito dello script di setup
   * (0 se non c'è); se è fallito i servizi non partono. Un servizio con `port` riceve LADDER_PORT: la prima porta libera del blocco del worktree
   * (bind di prova), così due worktree dello stesso progetto non si scontrano. Non lancia mai: un problema diventa una nota nella sessione.
   */
  private startServices(sessionId: string, project: Project, cwd: string, config: ProjectSettings['worktree'], setupCode: number | null): Promise<void> {
    const run = this.runServices(sessionId, project, cwd, config, setupCode)
    // La promessa si tiene per sessione: archive() la aspetta prima di fermare i servizi, così nessuno parte dopo.
    this.servicesStarting.set(sessionId, run)
    void run.then(() => {
      if (this.servicesStarting.get(sessionId) === run) this.servicesStarting.delete(sessionId)
    })
    return run
  }

  /** Sessione archiviata o in archiviazione: non si avviano più servizi né note di setup. */
  private isGone(sessionId: string): boolean {
    return this.rows.get(sessionId)?.archived !== 0 || this.archiving.has(sessionId)
  }

  private async runServices(sessionId: string, project: Project, cwd: string, config: ProjectSettings['worktree'], setupCode: number | null): Promise<void> {
    // I servizi disattivati (`disabled`) restano nell'elenco ma non partono.
    const services = config.services.filter((s) => !s.disabled && s.command.trim())
    if (!services.length) return
    const noticeError = (text: string) => {
      this.upsertItem(sessionId, { kind: 'notice', id: randomUUID(), turnId: 'system', at: Date.now(), tone: 'error', text })
      this.flush()
    }
    try {
      if (this.isGone(sessionId)) return
      if (setupCode !== 0) return noticeError(t('The worktree services were not started because the setup script failed.'))
      // La base resta a setup, shell e [[run]]: i servizi partono da base + 1, così un `[[run]] dev --port $LADDER_PORT` non li scontra.
      const base = this.ports.allocate(cwd) + 1
      const count = config.ports - 1
      const taken = new Set<number>()
      if (count < 1 && services.some((s) => s.port)) noticeError(t('The services with a port were not started: worktree.ports must be at least 2 (the first port is kept for setup and [[run]] actions).'))
      for (const service of services) {
        // La sessione può essere stata archiviata mentre si aspettava il setup.
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
          // freePort è asincrono: l'archiviazione può essere arrivata nel frattempo.
          if (this.isGone(sessionId)) return
        }
        this.terminals.spawn({ projectId: project.id, sessionId, kind: 'service', title: service.name, cwd, command: service.command, port })
      }
    } catch (error) {
      noticeError(t('Could not start the worktree services: {message}', { message: error instanceof Error ? error.message : String(error) }))
    }
  }

  /**
   * Riavviando un servizio (già fermato da restartTerminal) la sua porta può essere stata presa da altri: se è libera resta, altrimenti se ne assegna un'altra del blocco
   * (da base + 1, senza quelle degli altri servizi del worktree). Per gli altri terminali nessun cambio.
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
   * Riavvio di un terminale. Un servizio acceso si ferma davvero (processi usciti, porta libera) prima di ripartire; una sessione
   * archiviata o in archiviazione non riparte, nemmeno se l'archiviazione arriva mentre si aspetta lo stop.
   */
  private async restartTerminal(id: string): Promise<TerminalInfo> {
    // Il sessionId si legge una volta: se l'archiviazione chiude il terminale mentre si aspetta, l'errore resta «archiviata».
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

  /** Ferma i servizi di un worktree e aspetta che i loro processi siano usciti (porte libere). I terminali restano: li chiude chi archivia. */
  private async stopServices(cwd: string): Promise<void> {
    // Anche a shell uscita: un `cmd &` lasciato in background tiene la porta, e il suo gruppo di processi è ancora vivo.
    const alive = this.terminals.list().filter((term) => term.kind === 'service' && term.cwd === cwd && (term.state === 'running' || this.terminals.isAlive(term.id)))
    await Promise.all(alive.map((term) => this.terminals.stop(term.id)))
  }

  /** Lo script di setup è uscito con errore: una nota nella sessione. `waited`: la sessione partiva dopo di lui. */
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
   * Archivia le sessioni ferme da `autoArchiveDays` giorni: senza turno, richieste, coda, setup o terminale in corso (i servizi, sempre accesi, non contano: archive() li ferma).
   * Parte all'avvio, a ogni cambio della preferenza e ogni ora.
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
        // Una sessione che non si archivia non ferma le altre; si riprova al giro dopo.
      }
    }
    if (archived.length) this.broadcast({ type: 'sessions.autoArchived', sessionIds: archived })
  }

  /**
   * Riavvio dell'agente (per esempio dopo aver aggiunto un server MCP): la conversazione resta su disco e il prossimo turno
   * la riprende (resume) con un processo nuovo. Non interrompe niente: con un turno o sotto-agenti al lavoro aspetta la fine.
   * Si perdono solo le approvazioni "per questa sessione" date nel processo vecchio: l'agente le richiederà.
   */
  private restartAgent(sessionId: string): void {
    const row = this.mustRow(sessionId)
    if (this.isGone(sessionId)) return
    if (row.mode === 'terminal') throw new Error(t('Terminal sessions restart from their terminal.'))
    // Solo gli agenti che riprendono la conversazione da un processo nuovo: gli altri ripartirebbero da zero.
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
   * Il processo serve ancora: turno aperto o in chiusura, sotto-agenti o comandi in background vivi,
   * o un sotto-agente appena finito il cui risultato l'agente non ha ancora ricevuto (turno implicito in arrivo).
   * ownClosing: chiusure di turno da non contare (da onTurnEnd, la propria).
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

  /** Revokes the session's MCP server tokens (agent browser and Ladder): releases pending confirmations and delegations. */
  private revokeTools(sessionId: string): void {
    this.browserAgent.revoke(sessionId)
    this.ladderMcp.revoke(sessionId)
  }

  /** Chiude il processo dell'agente senza toccare la sessione: come l'archiviazione, prima la revoca del browser dell'agente. */
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

  /** `cleanup: false` quando il chiamante toglie il worktree: lo script di pulizia parte da removeWorktree. */
  private async archive(sessionId: string, options: { cleanup?: boolean } = {}): Promise<void> {
    // Doppio clic, archiviazione automatica e PR unita: chi arriva dopo aspetta la stessa archiviazione, lo script di pulizia parte una volta sola.
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
    // Progetto e script di pulizia si leggono ora, prima di ogni attesa: project.remove può togliere il progetto mentre i servizi si fermano.
    let project: Project | undefined
    let script: string | null = null
    // Child with its own worktree (delegate with worktree: true): at the end of archiving the worktree is removed if clean.
    const childWorktree = !!row.parent && this.ownsWorktree(row)
    try {
      // Child sessions (advice, delegations) are archived with the parent, before it.
      for (const child of [...this.rows.values()]) if (!child.archived && this.parentOf(child)?.sessionId === sessionId) await this.archive(child.id).catch(() => undefined)
      // The cleanup script closes the worktree: it does not run if another live session uses the same folder.
      if (this.ownsWorktree(row) && options.cleanup !== false && !this.worktreeHeir(row)) {
        project = this.projects.get(row.project_id)
        script = project ? (await loadProjectSettings(project.path)).worktree.archive : null
      }
      await this.archiveSession(sessionId, row)
    } finally {
      this.archiving.delete(sessionId)
    }
    this.emitSummary(sessionId)
    this.attention({ kind: 'resolved', sessionId, itemId: null })
    // Comando di chiusura del worktree (per esempio docker compose down), in processo e con timeout. Il worktree resta: lo toglie archiveMerged.
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
    // Prima la revoca: scioglie le conferme del browser dell'agente ancora aperte (expireRequest ha bisogno del runtime).
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
    // Prima si aspetta l'eventuale avvio dei servizi (che da ora non spawna più), poi i servizi del worktree (LAD-66) si fermano
    // davvero e liberano le porte, poi si chiudono tutti i terminali (i servizi con attesa).
    await this.servicesStarting.get(sessionId)
    // Folder also used by another live session (linked sessions): services do not stop, they pass to that session.
    const heir = this.worktreeHeir(row)
    // A child does not own the folder's services: archiving it does not stop them.
    if (!heir && (!row.parent || this.ownsWorktree(row))) await this.stopServices(this.cwdOf(row))
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

  /** Lo script di pulizia è fallito o scaduto: una nota nella sessione, che prosegue comunque. */
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

  // ── Azioni di avvio ([[run]] in .ladder/settings.toml) ────────────────────

  private async startRun(projectId: string, sessionId: string | null, name: string): Promise<TerminalInfo> {
    const project = this.mustProject(projectId)
    const settings = await loadProjectSettings(project.path)
    const action = settings.run.find((r) => r.name === name)
    if (!action) throw new Error(t('No action “{name}” in .ladder/settings.toml.', { name }))
    const row = sessionId ? this.rows.get(sessionId) : undefined
    const cwd = row ? this.cwdOf(row) : project.path
    const same = this.terminals.list().filter((t) => t.kind === 'run' && t.title === action.name && t.cwd === cwd)
    // Un'esecuzione alla volta: si riavvia quella che c'è. Con concurrent = true se ne apre un'altra solo se quella gira ancora.
    const reusable = action.concurrent ? same.find((t) => t.state !== 'running') : same[0]
    if (reusable) return this.terminals.restart(reusable.id, { command: action.command })
    return this.terminals.spawn({ projectId, sessionId, kind: 'run', title: action.name, cwd, command: action.command, port: this.ports.allocate(cwd) })
  }

  // ── Sessioni terminale ───────────────────────────────────────────────────

  /** Avvia la CLI della sessione nel suo terminale. `prompt` diventa il primo messaggio per claude e codex. */
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
      // Sempre assegnato, anche vuoto: restart() unisce le opzioni e terrebbe l'env di un profilo rimosso.
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
      // Le app GUI non vedono il PATH della shell: il comando si risolve con la shell di login.
      if (options.file && !resolved) options.file = (await whichInShell(options.file)) ?? options.file
      if (existing) this.terminals.restart(existing.id, options)
      else this.terminals.spawn(options)
      this.updateRow(sessionId, { run_state: kind === 'generic' ? 'running' : 'starting', estimated: kind === 'generic' ? 1 : 0 })
      this.termStatus.set(sessionId, { label: null, activity: null, turn: null, waitingSince: null })
      this.emitSummary(sessionId)
      // Checkpoint di inizio sessione: è il "prima" del diff della sessione.
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
        // Fine turno: la sessione diventa "da leggere" e il turno ha il suo checkpoint di fine.
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
      // Il turno può essere finito mentre aspettavamo l'agente: allora il messaggio parte, non resta in coda.
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

  /** La sessione non può avviare un turno adesso: sta lavorando, aspetta una risposta o il setup. */
  private isBusy(sessionId: string): boolean {
    const row = this.mustRow(sessionId)
    // Durante un cambio di branch del checkout principale nessun turno parte lì: il messaggio va in coda e riparte a cambio finito.
    if (!row.worktree && this.switchingBranch.has(row.project_id)) return true
    return this.isBusyNow(sessionId)
  }

  /** Come `isBusy`, senza il cambio di branch in corso (che è ciò che il controllo del cambio stesso deve ignorare). */
  private isBusyNow(sessionId: string): boolean {
    const row = this.mustRow(sessionId)
    const runtime = this.runtimes.get(sessionId)
    // Il turno host resta aperto finché onTurnEnd non ha finito: un invio in quel tempo va in coda e lo prende lo svuotamento finale.
    return !!runtime?.adapter.isRunning || !!runtime?.turnId || (runtime?.closing ?? 0) > 0 || !!runtime?.exited || row.run_state === 'waiting' || this.preparing.has(sessionId)
  }

  /** L'agente accetta messaggi dentro il turno in corso (Claude e Codex; gli agenti ACP no). */
  private canSteer(row: SessionRow): boolean {
    return row.mode !== 'terminal' && (row.agent === 'claude-code' || row.agent === 'codex')
  }

  /**
   * Inserisce il messaggio nel turno in corso, con la riga 'user' subito nel turno. False se non si può
   * (agente senza inserimento, turno di un comando /, richiesta aperta, interruzione in corso): il chiamante accoda.
   * Con una richiesta aperta si accoda per scelta: l'agente è fermo su una tua risposta e un messaggio in mezzo
   * cambierebbe il contesto di quella richiesta.
   */
  private async steerInto(sessionId: string, text: string, attachments: Attachment[]): Promise<boolean> {
    const row = this.mustRow(sessionId)
    const runtime = this.runtimes.get(sessionId)
    if (!runtime?.turnId || !runtime.adapter.steer || !runtime.adapter.isRunning) return false
    if (!this.canSteer(row) || row.run_state !== 'running' || runtime.command || runtime.handoff || runtime.interrupting || runtime.closing > 0 || this.preparing.has(sessionId)) return false
    const turnId = runtime.turnId
    // L'id della riga è anche l'uuid del messaggio nello stream: serve a ritrovarla se gira da solo.
    const id = randomUUID()
    if (!(await runtime.adapter.steer(text, attachments, id))) return false
    this.upsertItem(sessionId, this.userItem(turnId, text, attachments, { id, steered: true }))
    this.flush()
    return true
  }

  /**
   * Consegna un messaggio della coda. 'steer': entra nel turno in corso. 'now': interrompe il turno e parte
   * questo davanti al resto della coda. Da fermo parte come un messaggio normale.
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
      // Da fermo: nessun turno da cui entrare o da interrompere, parte come un messaggio normale.
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
      // Il turno è finito mentre inserivamo e la sessione è libera: il messaggio parte come uno normale.
      if (!this.isBusy(sessionId)) {
        this.emitSummary(sessionId)
        await this.startTurn(sessionId, message.text, attachments)
        return
      }
      // Il turno non accetta messaggi: il messaggio torna al suo posto.
      const current = JSON.parse(this.mustRow(sessionId).queue) as QueuedMessage[]
      current.splice(Math.min(index, current.length), 0, message)
      this.updateRow(sessionId, { queue: JSON.stringify(current) })
      this.emitSummary(sessionId)
      throw new Error(t('The message could not be added to the running turn.'))
    }
    // Con messaggi inseriti pendenti (Claude) il messaggio entra nello stream subito dopo la ricevuta dell'interruzione:
    // CLI e host aprono così un solo turno (quello implicito) con i pendenti e il messaggio.
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
    // 'now': in testa alla coda; alla fine dell'interruzione onTurnEnd fa partire il primo.
    queue.unshift(message)
    this.updateRow(sessionId, { queue: JSON.stringify(queue) })
    this.emitSummary(sessionId)
    if (working) await this.interrupt(sessionId, false)
  }

  /**
   * Comandi / di una sessione, senza avviare processi: l'elenco della sessione, poi i comandi fissi di Codex,
   * poi l'ultimo elenco noto per agente e cartella. L'elenco vero arriva con l'evento quando il runtime parte.
   */
  private commandsFor(sessionId: string): SlashCommand[] {
    const row = this.rows.get(sessionId)
    if (!row || row.mode === 'terminal' || row.archived) return []
    const own = this.commandLists.get(sessionId)
    if (own) return own
    if (row.agent === 'codex') return codexFixedCommands()
    return this.lastCommands.get(`${row.agent}\0${this.cwdOf(row)}`) ?? []
  }

  /** Esegue un comando / dell'agente: un turno come gli altri, ma con una riga 'command' al posto di quella dell'utente. */
  private async runCommand(sessionId: string, name: string, args: string): Promise<void> {
    const row = this.mustRow(sessionId)
    if (row.mode === 'terminal') throw new Error(t('A terminal session is used from its terminal.'))
    if (this.isBusy(sessionId) || (row.run_state !== 'idle' && row.run_state !== 'error')) throw new Error(t('Wait for the session to finish before running a command.'))
    if (!this.commandsFor(sessionId).some((c) => c.name === name)) throw new Error(t('Unknown command: /{name}', { name }))
    await this.startTurn(sessionId, `/${name} ${args}`.trim(), [], { name, args })
  }

  /** Il processo dell'agente della sessione: lo crea e lo avvia se non c'è. */
  private ensureRuntime(sessionId: string): Runtime {
    // Una sessione archiviata o in archiviazione non riavvia l'agente: nascerebbe un processo che nessuno chiude.
    if (this.isGone(sessionId)) throw new Error(t('The session is archived.'))
    const existing = this.runtimes.get(sessionId)
    if (existing) return existing
    const row = this.mustRow(sessionId)
    const owner: { adapter?: AgentSession } = {}
    const adapter = this.createAdapter(
      row.agent,
      { cwd: this.cwdOf(row), model: row.model, effort: row.effort as Effort | null, permission: row.permission as PermissionLevel, resume: row.external_id, autonomyHint: this.prefs.autonomyHint !== false, ...(this.isReadOnlyRow(row) ? { readOnly: true } : {}), ...(row.parent ? {} : { browserTools: this.browserAgent.register(sessionId, row.project_id) }), ladderTools: this.ladderMcp.register(sessionId, row.project_id, this.ladderToolsFor(row)), delegateHint: this.delegateHints.get(sessionId) ?? null },
      this.guardEvents(sessionId, owner, this.adapterEvents(sessionId)),
      row.profile_id
    )
    owner.adapter = adapter
    const runtime: Runtime = { adapter, turnId: null, turnStart: null, turnCounts: emptyCounts(), activity: null, pending: new Map(), command: null, interrupting: false, closing: 0, ending: Promise.resolve(), startedAt: Date.now() }
    this.runtimes.set(sessionId, runtime)
    adapter.start()
    return runtime
  }

  /** Gli eventi di un adapter che non è più quello della sessione (chiuso, sostituito) si ignorano. */
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

  /** Riga 'user' di un messaggio: la stessa per l'avvio di un turno e per l'inserimento in uno in corso. */
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
   * Apre un turno lato host: stato del runtime, riga 'running' della sessione e checkpoint di inizio.
   * `rows` scrive le righe del turno (messaggio dell'utente o comando) con il nuovo turnId.
   */
  private async beginTurn(sessionId: string, runtime: Runtime, opts: { title?: string; label: string | null; rows?: (turnId: string, backgroundDone: number) => void; implicit?: boolean; agentsState?: 'resumed' | 'continued' | 'dismissed' }): Promise<string> {
    const row = this.mustRow(sessionId)
    const project = this.mustProject(row.project_id)
    const cwd = this.cwdOf(row)
    const turnId = randomUUID()
    runtime.turnId = turnId
    runtime.implicit = !!opts.implicit
    runtime.approveAll = false
    // Un turno nuovo dell'utente riabilita gli strumenti del browser dell'agente fermati dall'interruzione del turno, non da uno stop esplicito.
    if (!opts.implicit) this.browserAgent.turnStarted(sessionId)
    // Il conteggio vale per il primo turno dopo la fine dei background, qualunque sia.
    const backgroundDone = this.agentsBeforeTurn.get(sessionId) ?? 0
    this.agentsBeforeTurn.delete(sessionId)
    // Un turno qualunque chiude l'attesa dei background: ripartito da solo (implicito) o per un messaggio dell'utente.
    this.agentsIdle.delete(sessionId)
    clearTimeout(this.agentsWait.get(sessionId))
    this.agentsWait.delete(sessionId)
    this.settleAgentsFinished(sessionId, opts.agentsState ?? 'continued')
    runtime.turnAgents = 0
    runtime.turnRequests = 0
    runtime.interrupting = false
    runtime.turnCounts = emptyCounts()
    // Il turno implicito lo apre l'agente per un messaggio inserito: non pota l'elenco.
    if (!opts.implicit && this.subagents.turnStarted(sessionId)) this.emitSubagents(sessionId)
    runtime.activity = t('Thinking…')
    opts.rows?.(turnId, backgroundDone)
    this.updateRow(sessionId, { run_state: 'running', ...(opts.title ? { title: opts.title } : {}) })
    this.emitSummary(sessionId)
    this.flush()
    // Turno già aperto (turnId assegnato): il livello rimasto in attesa vale da questo turno, prima che l'agente riceva il messaggio.
    await this.applyNextPermission(sessionId, runtime)
    runtime.turnStart = project.isGit ? await createCheckpoint(cwd, `refs/ladder/${sessionId}/${turnId}-start`, 'ladder: turn start').catch(() => null) : null
    if (runtime.turnStart) recordCheckpoint(this.db, { session_id: sessionId, turn_id: turnId, kind: 'start', sha: runtime.turnStart, root: cwd, label: opts.label, at: Date.now() })
    return turnId
  }

  private async startTurn(sessionId: string, text: string, attachments: Attachment[] = [], command: { name: string; args: string } | null = null, system: { rows: (turnId: string) => HandoffRun | void } | null = null): Promise<void> {
    const row = this.mustRow(sessionId)
    // Browser per l'agente: il server deve già ascoltare quando nasce il runtime (solo se l'interruttore è acceso).
    if (this.isGone(sessionId)) return
    // Riavvio rimandato che non ha trovato una fine turno libera (sotto-agenti in background finiti senza turno): avviene ora, prima del messaggio.
    const previous = this.runtimes.get(sessionId)
    // Senza processo il prossimo nasce già nuovo: un riavvio rimandato non serve più.
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
    // L'archiviazione può essere arrivata mentre si aspettava il browser.
    if (this.isGone(sessionId)) return
    const runtime = this.ensureRuntime(sessionId)
    // Il titolo nasce dal primo messaggio dell'utente: un comando iniziale non lo consuma.
    // Un titolo scelto (rinominato o dato alla creazione) non si tocca: si sostituisce solo il segnaposto.
    const firstMessage = !command && !system && isPlaceholderTitle(row.title) && !this.hasUserMessage(sessionId)
    runtime.lastCommand = command?.name ?? null
    await this.beginTurn(sessionId, runtime, {
      // Il titolo nasce dal primo messaggio, tranne per le sessioni da issue, PR o branch: lì resta il loro titolo.
      title: firstMessage && !row.source ? titleFrom(text) : undefined,
      label: titleFrom(text),
      // Un comando / non è la ripresa dei background.
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
   * Un messaggio inserito che ha superato un'interruzione gira come turno a sé: l'host lo apre qui, così l'output
   * non va perso. Le sue righe 'user' (già create all'inserimento, id = uuid) passano al nuovo turno senza "steered".
   */
  private async openImplicitTurn(sessionId: string, uuids: string[]): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    const row = this.rows.get(sessionId)
    if (!runtime || !row || !this.projects.has(row.project_id)) return
    // Il turno ha subito il suo turnId: l'output non finisce nel turno che si sta chiudendo (onTurnEnd ne ha una fotografia).
    await this.beginTurn(sessionId, runtime, {
      label: null,
      implicit: true,
      // Ripartito da solo dopo i background: 'resumed'. Nato da messaggi inseriti: non c'entra con la riga.
      agentsState: uuids.length === 0 ? 'resumed' : 'dismissed',
      rows: (turnId, backgroundDone) => {
        // In testa al turno: perché l'agente è ripartito da solo.
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

  /** Un solo tentativo automatico: quando il turno del primo messaggio è concluso, se il titolo non è dell'utente. Mai rumore verso l'utente. */
  private async autoTitle(sessionId: string): Promise<void> {
    const row = this.rows.get(sessionId)
    if (!row || !this.prefs.generatedTitles || row.mode !== 'chat' || row.title_source !== 'provisional' || this.titling.has(sessionId) || this.titleTried.has(sessionId)) return
    // Le sessioni da issue, PR o branch tengono il loro titolo.
    if (row.source) return
    // Senza messaggio e risposta del primo turno non si conta come tentativo: si riprova al turno dopo.
    if (!this.titleInputs(sessionId)) return
    this.titleTried.add(sessionId)
    await inTitleQueue(() => this.generateTitle(sessionId, false)).catch(() => undefined)
  }

  /** "Rigenera titolo": azione esplicita, vale anche per un titolo rinominato (la sorgente torna 'generated'). */
  private async regenerateTitle(sessionId: string): Promise<string> {
    const row = this.mustRow(sessionId)
    if (row.mode !== 'chat') throw new Error(t('Only chat sessions have a generated title.'))
    if (this.titling.has(sessionId)) throw new Error(t('A title is already being generated.'))
    const title = await this.generateTitle(sessionId, true)
    if (!title) throw new Error(t('Could not generate a title.'))
    return title
  }

  /** Primo messaggio dell'utente e inizio della risposta nello stesso turno, se quel turno è concluso. */
  private titleInputs(sessionId: string): { first: Extract<ChatItem, { kind: 'user' }>; reply: Extract<ChatItem, { kind: 'assistant' }> } | null {
    const items = this.loadItems(sessionId)
    const first = items.find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user')
    if (!first || !items.some((i) => i.kind === 'turn-end' && i.status === 'completed' && i.turnId === first.turnId)) return null
    const reply = items.find((i): i is Extract<ChatItem, { kind: 'assistant' }> => i.kind === 'assistant' && i.turnId === first.turnId && Boolean(i.text.trim()))
    return reply ? { first, reply } : null
  }

  /** Prefissi dei team (LAD, LIN…) delle issue da cui sono nate le sessioni del progetto. */
  private teamsOf(projectId: string): string[] {
    const refs: string[] = []
    for (const row of this.rows.values()) {
      if (row.project_id === projectId && row.source) refs.push((JSON.parse(row.source) as SessionSource).ref)
    }
    return teamPrefixes(refs)
  }

  /**
   * Primo messaggio e inizio della risposta al modello piccolo dell'agente; scrive solo se nel frattempo non è cambiato il titolo.
   * Restituisce il titolo scritto, o quello corrente se l'utente ha rinominato nel frattempo; null se il modello non ha dato un titolo.
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
    // L'utente può aver rinominato mentre il modello lavorava: vince lui, e non è un errore.
    if (current.title !== startTitle || (!force && current.title_source === 'user')) {
      this.emitSummary(sessionId)
      return current.title
    }
    if (!title) {
      this.emitSummary(sessionId)
      return null
    }
    const source = current.source ? (JSON.parse(current.source) as SessionSource) : null
    // Da issue, PR o Linear il prefisso è il loro riferimento; per un branch non c'è.
    const ref = source ? (source.kind === 'branch' ? null : source.ref) : issueRef(inputs.first.text, this.teamsOf(current.project_id))
    const final = clipTitle(withIssue(title, ref))
    this.updateRow(sessionId, { title: final, title_source: 'generated' })
    this.emitSummary(sessionId)
    return final
  }

  /** Generazione di branch, commit e PR accesa: interruttore globale e, se presente, quello del progetto. */
  private textEnabled(projectId: string): boolean {
    if (this.prefs.generatedText === false) return false
    const row = this.db.prepare('select json from ui_state where project_id = ?').get(projectId) as { json: string } | undefined
    try {
      return !row || (JSON.parse(row.json) as ProjectUiState).generatedText !== false
    } catch {
      return true
    }
  }

  /** LAD-57 parte 2: browser per l'agente acceso? Il progetto (true/false) scavalca l'interruttore globale; predefinito spento. */
  private agentBrowserEnabled(projectId: string): boolean {
    const row = this.db.prepare('select json from ui_state where project_id = ?').get(projectId) as { json: string } | undefined
    try {
      const own = row ? (JSON.parse(row.json) as ProjectUiState).agentBrowser : undefined
      return own ?? this.prefs.agentBrowser === true
    } catch {
      return this.prefs.agentBrowser === true
    }
  }

  /** Come titleModel, ma per testo libero con il suo timeout. */
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

  /** Nome del branch dalla richiesta, solo con i testi generati accesi (globale e progetto); null: si usa il nome da titolo. Mai errori. */
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

  /** Modello, cartella e conversazione di una richiesta di testo; gli errori sono già tradotti. */
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

  /** text.cancel: ferma la generazione in corso e libera la sessione subito, senza aspettare che il modello si fermi. */
  private cancelWriting(sessionId: string): void {
    this.writing.get(sessionId)?.abort()
    this.writing.delete(sessionId)
  }

  /** Riferimento dell'issue della sessione: dalla sorgente (issue GitHub, Linear) o citata nel primo messaggio. */
  private issueOf(row: SessionRow, items: ChatItem[]): { ref: string; url: string | null } | null {
    const source = row.source ? (JSON.parse(row.source) as SessionSource) : null
    if (source && (source.kind === 'github-issue' || source.kind === 'linear')) return { ref: source.ref, url: source.url }
    const first = items.find((i) => i.kind === 'user')
    const ref = first && first.kind === 'user' ? issueRef(first.text, this.teamsOf(row.project_id)) : null
    return ref ? { ref, url: null } : null
  }

  /** "Scrivi messaggio": proposta di messaggio di commit dal diff e dalla conversazione. Non committa. */
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
      // Dopo un annullamento la voce può essere già di una richiesta nuova: si libera solo la propria.
      if (this.writing.get(sessionId) === abort) this.writing.delete(sessionId)
    }
  }

  /** Titolo e descrizione della PR dai commit del branch rispetto alla base. Non crea la PR. */
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
      // Il collegamento lo aggiunge Ladder, in modo uguale ogni volta: "Closes #12" / "Closes LAD-59".
      const escaped = issue?.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const body = issue && !new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(parts.body) ? `${parts.body}\n\nCloses ${issue.ref}`.trim() : parts.body
      return { title: parts.first, body, issue, base, files: diff.files, truncated: diff.cut }
    } finally {
      // Dopo un annullamento la voce può essere già di una richiesta nuova: si libera solo la propria.
      if (this.writing.get(sessionId) === abort) this.writing.delete(sessionId)
    }
  }

  /** Il modello piccolo dello stesso fornitore della sessione: Claude (Haiku), Codex (un modello "mini"); gli altri agenti no. */
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
        // Fotografia del turno che si chiude: un turno implicito può aprirsi mentre onTurnEnd aspetta i checkpoint.
        // Senza un turno aperto non c'è nulla da chiudere (risultato in ritardo dopo un'interruzione).
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
        // L'effort effettivo dipende dai default del modello: se cambia con la nuova lista, il summary si riemette.
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
        // Chiusa dalla rete di sicurezza: se ora finisce davvero, conta come se fosse stata in corso.
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
        // Il contesto scende subito al valore dopo la compattazione.
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
        // Un comando / avviato dall'utente (es. /exit) può chiudere l'agente di proposito: la coda non riparte.
        const byCommand = !!runtime.lastCommand
        // Le chiusure di turno già in coda finiscono prima di togliere il runtime.
        void runtime.ending.then(() => {
          if (this.runtimes.get(sessionId) !== runtime) return
          for (const [requestId] of runtime.pending) this.expireRequest(sessionId, requestId)
          // Turno ancora aperto all'uscita: non è "fatto" (interrotto se l'hai chiesto tu, altrimenti errore).
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
          // Uscita senza errore (non un login fallito o simili): il primo messaggio in coda riparte con un runtime nuovo.
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

  /** Modello ed effort del sotto-agente anche sulla riga tool che l'ha lanciato: restano visibili dopo il riavvio. */
  private saveSubagentMeta(sessionId: string, id: string): void {
    const info = this.subagents.find(sessionId, id)?.info
    const item = info?.toolId ? this.liveItems.get(sessionId)?.get(info.toolId) : undefined
    if (!info || !item || item.kind !== 'tool') return
    const old = item.agent
    if (old?.model === info.model && old?.effort === (info.effort ?? null)) return
    this.upsertItem(sessionId, { ...item, agent: { model: info.model, effort: info.effort ?? null } })
  }

  /** Chiude la riga 'command' del turno, se il turno veniva da un comando /. */
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
    // La richiesta è "in sospeso" prima di comparire: il riepilogo della sessione la include già (per "In attesa").
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
    // Passato a Full access a turno in corso (Codex): le richieste di questo turno non aspettano nessuno.
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

  private respond(sessionId: string, requestId: string, response: RequestResponse, via: RequestItemData['via'] = 'chat', resolution?: string): void {
    const runtime = this.runtimes.get(sessionId)
    const pending = runtime?.pending.get(requestId)
    const item = this.liveItems.get(sessionId)?.get(requestId) ?? this.loadItems(sessionId).find((i) => i.id === requestId)
    if (!pending || !runtime || !item || item.kind !== 'request') {
      throw new Error(t('This request is no longer active.'))
    }
    runtime.pending.delete(requestId)
    this.upsertItem(sessionId, { ...item, state: 'resolved', resolution: resolution ?? describeResponse(item, response), via })
    if (runtime.pending.size === 0) this.updateRow(sessionId, { run_state: 'running' })
    this.emitSummary(sessionId)
    this.attention({ kind: 'resolved', sessionId, itemId: requestId })
    pending.resolve(response)
  }

  /** Approva una richiesta aperta con l'opzione allow (mai always), perché il nuovo livello la consente. */
  private autoApprove(sessionId: string, requestId: string, level: PermissionLevel): void {
    if (!this.runtimes.get(sessionId)?.pending.has(requestId)) return
    const item = this.liveItems.get(sessionId)?.get(requestId)
    const allow = item?.kind === 'request' ? item.options.find((o) => o.kind === 'allow') : null
    if (!allow) return
    this.respond(sessionId, requestId, { optionId: allow.id }, 'chat', level === 'full' ? t('Approved by switching to Full access') : t('Approved by switching to Edit'))
  }

  /** Il livello consente da solo questa richiesta? Edit solo per file dentro la cartella di lavoro. */
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

  /** Il livello rimasto in attesa del turno successivo diventa quello della sessione (con i limiti attuali del progetto). */
  private applyNextPermission(sessionId: string, runtime: Runtime | null): Promise<void> {
    return this.withPermissionLock(sessionId, () => this.applyNextNow(sessionId, runtime))
  }

  private async applyNextNow(sessionId: string, runtime: Runtime | null): Promise<void> {
    const pending = this.rows.get(sessionId)?.permission_next as PermissionLevel | null | undefined
    if (!pending) return
    const project = this.projects.get(this.mustRow(sessionId).project_id)
    const settings = project ? await loadProjectSettings(project.path) : null
    const level = clampPermission(pending, settings?.agents.permissionsMax ?? null)
    // L'agente ricreato nel frattempo parte dal livello vecchio: si allinea.
    let failure: Error | null = null
    if (runtime) await runtime.adapter.setPermission(level).catch((error: Error) => (failure = error))
    if (!this.rows.has(sessionId)) return
    // Rifiutato: la riga tiene il livello attuale, nessun livello falso.
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
    // Un'interruzione chiesta da noi vale anche se l'agente risponde con un errore (ACP al cancel).
    const wasInterrupting = snap.interrupting
    // Turn born from advice that the cross-review forwarded: it is not reviewed.
    const fromReview = this.reviewTurns.delete(snap.turnId)
    // Da leggere prima che expireRequest svuoti pending e che finishCommand chiuda il comando.
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
    // Interruzione o errore: i sotto-agenti in primo piano si fermano con il turno, quelli in background no.
    if (result.status !== 'completed' && this.subagents.stopRunning(sessionId, { foregroundOnly: true })) this.emitSubagents(sessionId)
    // Rete di sicurezza: le voci "in corso" senza aggiornamenti da un pezzo e fuori dall'insieme dei background vivi sono fantasmi.
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
    // Chiude eventuali messaggi rimasti in streaming (per esempio dopo un'interruzione).
    for (const item of this.liveItems.get(sessionId)?.values() ?? []) {
      if (item.kind === 'assistant' && item.streaming && item.turnId === turnId) this.upsertItem(sessionId, { ...item, streaming: false })
      if (item.kind === 'tool' && item.status === 'running' && item.turnId === turnId)
        this.upsertItem(sessionId, { ...item, status: result.status === 'completed' ? 'done' : 'error', endedAt: Date.now() })
    }
    // Turno fermo senza motivo: completato, senza comandi né modifiche, richieste, agenti in corso né domanda finale (solo Edit e Full access).
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
    // Se un turno implicito ha già preso il posto, è lui a tenere turnId, attività e stato "in corso".
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
    // Un background finito mentre il turno si chiudeva: ora che nessun turno è aperto parte l'attesa di "Continue".
    if (!superseded && this.agentsIdle.has(sessionId)) this.armAgentsFinished(sessionId)
    // Riga già a riposo: solo ora il livello chiesto a turno in corso diventa quello della sessione.
    if (!superseded) await this.applyNextPermission(sessionId, runtime)
    if (files.length > 0) this.notifyFsChanged(cwd)
    // L'avviso dei sotto-agenti rimandato a fine turno si unisce alla notifica del turno, senza doppioni.
    if (result.status === 'error') this.agentsPending.delete(sessionId)
    const merged = result.status !== 'error' && !superseded && this.flushAgentsDone(sessionId, end.id)
    if (result.status === 'error') this.errorAttention(sessionId, end.id, result.error ?? t('The turn stopped because of an error.'))
    else if (result.status === 'completed' && project && !merged && !child && !(handoff && handoffSummary)) {
      this.attention({ kind: 'turn', sessionId, projectId: project.id, projectName: project.name, itemId: end.id, durationMs: result.durationMs, title: row.title })
    }
    // Titolo da un modello piccolo, dopo il primo turno concluso: in background, senza aspettarlo.
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
    let switching = false
    if (!child && !handoff && !superseded && !wasInterrupting && result.status !== 'interrupted') {
      const hit = this.limitHit(row, result)
      if (hit) switching = await this.onLimit(sessionId, turnId, hit).catch(() => false)
    }
    // Cross-review: turn ended with changes, not a child's nor born from advice forwarded by the review.
    if (!child && !handoff && !superseded && !fromReview && !switching && result.status === 'completed' && files.length > 0) void this.startCrossReview(sessionId, files).catch(() => undefined)

    // Messaggi inseriti non ancora uniti a un turno girano da soli (turno implicito, già o a momenti aperto):
    // la coda riparte alla fine di quel turno.
    if (superseded || runtime.adapter.isRunning || runtime.exited) return
    // Riavvio chiesto a turno in corso: ora che il lavoro è finito; il primo messaggio in coda parte già col processo nuovo.
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
      // La sessione tiene il suo posto per i messaggi che le hai già messo in coda.
      this.updateRow(sessionId, { queue: JSON.stringify(queue) })
      try {
        await this.startTurn(sessionId, next.text, next.attachments ?? [])
      } catch (error) {
        // Il messaggio non è partito: torna in testa alla coda e la sessione non resta "in corso".
        const current = JSON.parse(this.mustRow(sessionId).queue) as QueuedMessage[]
        current.unshift(next)
        // Dopo un riavvio il turno è partito (o ha provato) su un runtime nuovo: si sistema quello, non il vecchio chiuso.
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
        `insert into sessions (id, project_id, title, agent, model, effort, permission, created_at, updated_at, mode, command, cwd, worktree, activity_at, source, title_source, profile_id, handoff_from, parent)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.project_id, row.title, row.agent, row.model, row.effort, row.permission, row.created_at, row.updated_at, row.mode, row.command, row.cwd, row.worktree, row.activity_at, row.source, row.title_source, row.profile_id, row.handoff_from, row.parent)
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
    if (!row || !project || !this.ladderToolsFor(row).includes('delegate')) {
      this.delegateHints.delete(sessionId)
      return
    }
    const delegates = (await loadProjectSettings(project.path)).agents.delegates.filter((d) => this.agents.get(d.agent)?.available)
    this.delegateHints.set(sessionId, delegates.length ? delegatesHint(delegates) : null)
  }

  /** Ultimo testo dell'assistente nel turno ('' se non ha scritto nulla). */
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

  /** Ladder server tools for the session: advice does not hand off or delegate; a read-only delegation neither, but returns the outcome. */
  private ladderToolsFor(row: SessionRow): LadderToolName[] {
    const parent = this.parentOf(row)
    if (!parent) return ['list_agents', 'handoff', 'delegate', 'report_result']
    if (parent.role !== 'delegate') return ['list_agents']
    return ['list_agents', 'report_result', ...(!this.isReadOnlyRow(row) && this.delegationDepth(row) < MAX_DELEGATION_DEPTH ? (['delegate'] as const) : [])]
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
    if (row.parent || row.mode !== 'chat') return fail(t('This session cannot hand its work over.'))
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
      parent: init.parent
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

  /** `all`: Stop (ferma anche i messaggi inseriti non ancora uniti); false per "invia ora", che li unisce al messaggio nuovo. */
  private async interrupt(sessionId: string, all = true): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    for (const [requestId] of runtime.pending) this.expireRequest(sessionId, requestId)
    runtime.interrupting = true
    // Stop: ferma anche l'azione in corso nel browser dell'agente e ne revoca gli strumenti fino al turno dopo (stop implicito).
    this.browserAgent.stop(sessionId, 'interrupt')
    // The parent's delegations stop with it (the MCP call returns with an error).
    this.stopDelegations(sessionId)
    await runtime.adapter.interrupt(all)
  }

  private setPermission(sessionId: string, requested: PermissionLevel): Promise<{ permission: PermissionLevel; appliesFrom: 'now' | 'next-turn' }> {
    return this.withPermissionLock(sessionId, () => this.changePermission(sessionId, requested))
  }

  /** Cambi di livello e applicazione del livello in attesa girano uno alla volta per sessione. */
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
    // Prima l'agente: se rifiuta l'errore risale e la riga resta com'era.
    await this.runtimes.get(sessionId)?.adapter.setPermission(permission)
    // Dopo gli await lo stato è quello di adesso: riga e runtime si rileggono.
    const row = this.mustRow(sessionId)
    const runtime = this.runtimes.get(sessionId)
    // Codex legge la policy solo all'avvio del turno: a turno in corso il livello vale dal prossimo.
    const appliesFrom = row.agent === 'codex' && runtime?.turnId ? 'next-turn' : 'now'
    if (appliesFrom === 'next-turn' && runtime) {
      this.updateRow(sessionId, { permission_next: permission === row.permission ? null : permission })
      runtime.approveAll = permission === 'full'
    } else {
      const before = row.permission
      this.updateRow(sessionId, { permission, permission_next: null })
      // Livello cambiato subito: le autorizzazioni del browser dell'agente (Full access, "per la sessione") decadono ora, non alla prossima navigazione.
      if (permission !== before) this.browserAgent.permissionChanged(sessionId)
    }
    this.emitSummary(sessionId)
    // Le richieste già aperte che il nuovo livello consente non hanno più motivo di aspettare.
    if (runtime) {
      for (const requestId of [...runtime.pending.keys()]) {
        const item = this.liveItems.get(sessionId)?.get(requestId)
        if (item?.kind === 'request' && (await this.allows(sessionId, permission, item))) this.autoApprove(sessionId, requestId, permission)
      }
    }
    return { permission, appliesFrom }
  }

  // ── Elementi e riepiloghi ────────────────────────────────────────────────

  private withSeq(sessionId: string, input: ItemInput): ChatItem {
    const row = this.mustRow(sessionId)
    const seq = row.last_seq + 1
    this.updateRow(sessionId, { last_seq: seq })
    return { ...input, seq } as ChatItem
  }

  /** Crea o aggiorna un elemento. Il salvataggio e l'invio alla UI avvengono insieme, ogni 33 ms. */
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
    // Fine turno: l'agente può aver fatto commit o push, e il fetch può ripartire.
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

  /** Richieste aperte di una sessione chat, la più vecchia prima. */
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

  /** Predefiniti dell'agente per un progetto (settings di progetto inclusi); l'elenco modelli resta quello a livello utente. */
  private agentDefaults(agent: AgentId, projectId: string, profileId?: string): { model: string | null; effort: Effort | null; known: boolean } {
    const custom = customProfileId(profileId)
    const models = (custom ? this.profileAgents.get(custom) : this.agents.get(agent))?.models ?? []
    const configDir = this.profiles.configDir(profileId ?? null)
    if (agent === 'claude-code') return claudeProjectDefaults(models, configDir, this.projects.get(projectId)?.path ?? null)
    if (agent === 'codex') return codexDefaults(models, configDir)
    // ACP: il default è il modello marcato dall'agente.
    const model = models.find((m) => m.isDefault)
    return { model: model?.id ?? null, effort: model?.defaultEffort ?? null, known: true }
  }

  /** Il modello come lo vede la UI: 'default' (alias salvato in passato) diventa null; l'id wire di Claude passa all'id dell'elenco. */
  private modelOf(row: SessionRow): string | null {
    if (!row.model || row.model === 'default') return null
    return row.agent === 'claude-code' ? claudeListId(row.model) : row.model
  }

  /** Effort in uso senza una scelta di Ladder: quello dell'init dell'agente, altrimenti il default del modello effettivo. */
  private effectiveEffort(row: SessionRow): Effort | null {
    const fromInit = this.initEffort.get(row.id)
    if (fromInit) return fromInit
    const custom = customProfileId(row.profile_id)
    const models = (custom ? this.profileAgents.get(custom) : this.agents.get(row.agent))?.models ?? []
    const model = (this.modelOf(row) ? models.find((m) => m.id === this.modelOf(row)) : undefined) ?? models.find((m) => m.isDefault)
    if (row.agent === 'claude-code') {
      // I settings di progetto contano solo per la sessione, non per l'elenco modelli dell'agente.
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
    const run = row.run_state as RunState
    const open = run === 'waiting' ? this.openRequestItems(sessionId) : []
    let waitingLabel: string | null = null
    if (run === 'waiting' && runtime) {
      waitingLabel = open[0]?.requestType === 'question' ? t('Question') : t('Approval')
    } else if (run === 'waiting') {
      waitingLabel = term?.label ?? t('Needs you')
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
      // Senza i dati base64 degli allegati: a ogni aggiornamento della sessione viaggerebbero megabyte.
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
      waitingSince: run === 'waiting' ? (open[0]?.at ?? term?.waitingSince ?? row.updated_at) : null,
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
      agentsNotice: this.agentsNotices.get(row.id) ?? null
    }
  }

  /** Una riga tool per id: dalle righe vive o con una query, senza caricare tutta la chat. */
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

  /** Dettaglio di un sotto-agente: dalla board (o dalla cache dei finiti), altrimenti ricostruito dalla riga tool della chat. */
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
        // Un agente che la board non conosce più non è vivo: una riga ancora "running" è rimasta a metà.
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
      // Primo piano: il tool_result è il report vero. Background: il riassunto, poi il file (se testo), poi la riga.
      report: background ? (extra?.report ?? file ?? extra?.result ?? rowOutput) : (extra?.result ?? rowOutput ?? extra?.report ?? file),
      tools: (extra?.tools ?? []).map(({ name, title, status, at }) => ({ name, title, status, at }))
    }
  }

  /** I sotto-agenti cambiano spesso (uno strumento dopo l'altro, in parallelo): al renderer va un aggiornamento ogni 250 ms. */
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
    this.updateBadge()
    // LAD-80: stato, titolo e archiviazione sono nella mappa dei branch.
    if (this.branchMapSubs.size > 0) this.branchMaps.touch(this.rows.get(sessionId)!.project_id)
  }

  // ── Notifiche e badge del Dock (li mostra il processo main) ──────────────────

  private attention(event: AttentionEvent): void {
    this.notify({ type: 'attention', event })
  }

  /** Un sotto-agente in background è finito: fuori da un turno dell'utente anche quelli che continuano (Codex) sono background. */
  private trackAgentEnd(sessionId: string, id: string, before: SubagentInfo | undefined): void {
    const after = this.subagents.find(sessionId, id)?.info
    // Fermato (non finito): non conta come finito, ma se era l'ultimo con conteggi in sospeso la sessione non resta muta.
    if (before?.status === 'running' && after?.status === 'stopped' && after.background) {
      if (this.agentsIdle.has(sessionId)) this.armAgentsFinished(sessionId)
      return
    }
    if (before?.status !== 'running' || !after || (after.status !== 'done' && after.status !== 'error')) return
    if (!after.background && this.runtimes.get(sessionId)?.turnId) return
    const failed = after.status === 'error'
    const rt = this.runtimes.get(sessionId)
    // Anche un background finito mentre il turno si sta chiudendo: il coordinatore è già fermo.
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
   * Ultimo background finito a coordinatore fermo: se entro qualche secondo non parte un turno (implicito o dell'utente),
   * la chat riceve la riga 'agents-finished' in 'waiting' con "Continue". Se il turno parte prima la riga non nasce:
   * c'è già la riga 'agent-start', e niente "Continue" che lampeggia.
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
        // Una riga ancora in attesa è superata da questa.
        this.settleAgentsFinished(sessionId, 'dismissed')
        const id = randomUUID()
        this.agentsRows.set(sessionId, id)
        this.upsertItem(sessionId, { kind: 'agents-finished', id, turnId: this.lastTurnId(sessionId), at: Date.now(), finished: run.finished, failed: run.failed, state: 'waiting' })
      }, AGENTS_WAIT_MS)
    )
  }

  /** Turno dell'ultima chiusura (o, dopo un riavvio, dell'ultimo 'turn-end' salvato); 'system' se la sessione non ha turni. */
  private lastTurnId(sessionId: string): string {
    const known = this.lastTurnIds.get(sessionId)
    if (known) return known
    const last = this.loadItems(sessionId).findLast((i) => i.kind === 'turn-end')
    return last?.turnId ?? 'system'
  }

  /** Porta la riga 'agents-finished' in attesa allo stato dato (se c'è). */
  private settleAgentsFinished(sessionId: string, state: 'resumed' | 'continued' | 'dismissed'): void {
    const id = this.agentsRows.get(sessionId)
    if (!id) return
    this.agentsRows.delete(sessionId)
    const item = this.liveItems.get(sessionId)?.get(id) ?? this.loadItems(sessionId).find((i) => i.id === id)
    if (item?.kind === 'agents-finished' && item.state === 'waiting') this.upsertItem(sessionId, { ...item, state })
  }

  /** "Continue": unico modo in cui Ladder scrive al coordinatore dopo i background, con un clic dell'utente. */
  private async continueAgents(sessionId: string, itemId: string): Promise<void> {
    this.mustRow(sessionId)
    const item = this.liveItems.get(sessionId)?.get(itemId) ?? this.loadItems(sessionId).find((i) => i.id === itemId)
    if (item?.kind !== 'agents-finished' || item.state !== 'waiting') throw new Error(t('This session has already moved on.'))
    if (this.isBusy(sessionId)) throw new Error(t('The session is busy. Try again when it stops.'))
    // Subito 'continued': un secondo clic non invia due volte.
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

  /** Avviso 'done' quando non resta nessun agente in background; con un turno aperto aspetta la sua fine e si unisce alla sua notifica. True se l'ha inviato. */
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

  /** Aprire o leggere la sessione azzera l'avviso: il summary torna senza e il badge cala. */
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

  /** Badge: una per richiesta aperta, più le sessioni ferme per errore che non hai ancora visto. */
  private updateBadge(): void {
    let count = 0
    for (const row of this.rows.values()) {
      if (row.archived || row.parent || !this.projects.has(row.project_id)) continue
      if (row.run_state === 'waiting') count += Math.max(1, this.runtimes.get(row.id)?.pending.size ?? 0)
      else if ((row.run_state === 'error' && row.last_activity_seq > row.last_read_seq) || this.agentsNotices.has(row.id)) count++
    }
    this.updateActivity()
    if (count === this.badge) return
    this.badge = count
    this.notify({ type: 'badge', count })
  }

  /** Sessioni che stanno lavorando: il main tiene il Mac sveglio se l'utente lo ha chiesto. */
  private updateActivity(): void {
    let running = 0
    for (const row of this.rows.values()) if (!row.archived && (row.run_state === 'running' || row.run_state === 'starting')) running++
    if (running === this.running) return
    this.running = running
    this.notify({ type: 'activity', running })
  }

  // ── Issue, PR e merge ────────────────────────────────────────────────────────

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

  /** Stato per il pannello "Pronto per il merge": git locale, PR, CI e commenti. `fetch` aggiorna prima i branch da origin. */
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
    // Stessa fonte dell'intestazione (git.status) per i campi comuni: le due viste coincidono sempre. Se il tracker ha una lettura
    // senza cambi da allora (al massimo 5 s) vale quella: `merge.info` parte a ogni `fs.changed` e non rifà ~7 processi git.
    const local = await this.gitStatus.recent(root)
    const unpushed = local?.hasUpstream ? local.ahead : null
    // LAD-69: passo successivo e blocchi si calcolano qui, in un punto solo (merge-flow.ts), sugli stessi dati dell'intestazione.
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

  /** La cartella è il worktree di una sessione non archiviata (stesso criterio per l'intestazione e per `merge.info`). */
  private isWorktreeRoot(root: string): boolean {
    return [...this.rows.values()].some((r) => !r.archived && !!r.worktree && this.cwdOf(r) === root)
  }

  /** HEAD è la testa della PR unita o un suo antenato (nessun commit nuovo dopo il merge)? Se non si può dire (oggetto non scaricato), sì. */
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
    // LAD-80: una PR unita si ricorda sulle sessioni del branch (nate prima dell'unione): la mappa le mostra unite anche archiviate e dopo un riavvio.
    const mergedAt = details?.status.state === 'merged' ? (details.status.mergedAt ?? null) : null
    if (mergedAt !== null) for (const row of this.rows.values()) if (this.cwdOf(row) === root && this.branchOf(row) === branch && mergedAt >= row.created_at) this.rememberMerged(row, 'pr', mergedAt)
    if (JSON.stringify(details?.status ?? null) === before) return
    for (const row of this.rows.values()) {
      if (!row.archived && this.cwdOf(row) === root && this.branchOf(row) === branch) this.emitSummary(row.id)
    }
  }

  /** Rilegge le PR dei branch con sessioni aperte. Le sessioni in un worktree si archiviano quando la loro PR è unita. */
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
        // gh non raggiungibile: si riprova al giro dopo.
      }
    }
    for (const row of [...this.rows.values()]) {
      const pr = this.prOf(row)
      if (row.archived || row.parent || !row.worktree || pr?.state !== 'merged' || this.mergedHandled.has(row.id)) continue
      // Conta la data dell'unione, non l'ultimo aggiornamento: un commento su una PR vecchia non la rende della sessione.
      if ((pr.mergedAt ?? 0) < row.created_at || this.busySession(this.cwdOf(row))?.id === row.id) continue
      this.mergedHandled.add(row.id)
      await this.archiveMerged(row, pr).catch(() => undefined)
    }
  }

  /** LAD-80: ricorda come e quando il branch della sessione è stato unito (la mappa lo legge dopo un riavvio). Non cambia `updated_at`. */
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

  /** Un'altra sessione non archiviata usa la stessa cartella di lavoro. */
  private worktreeShared(row: SessionRow): boolean {
    const cwd = this.cwdOf(row)
    return [...this.rows.values()].some((r) => r.id !== row.id && !r.archived && !r.parent && this.cwdOf(r) === cwd)
  }

  /** Archivia la sessione di una PR unita (`pr`) o di un branch già nella base (null) e toglie il worktree se è pulito e nessun'altra sessione lo usa. */
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
    // Un worktree usato da un'altra sessione non si tocca (nemmeno lo script di pulizia).
    if (!project || this.worktreeShared(row)) {
      this.upsertItem(row.id, { kind: 'notice', id: randomUUID(), turnId: 'system', at: Date.now(), tone: 'info', text: t('Session archived; the worktree stays because another session uses it.') })
      this.flush()
      return { archived: true, worktreeRemoved: false, worktreeKept: 'shared' }
    }
    // Il worktree si toglie solo se è pulito: git rifiuta da solo se ci sono modifiche o file non tracciati. Il branch resta.
    const { removed, cleanup, error } = await removeWorktree(project, cwd, { port: this.ports.allocate(cwd), stopServices: () => this.stopServices(cwd) })
    // Il blocco di porte del worktree tolto torna libero, ma non se lo script di pulizia è fallito o scaduto: quello che avviava (per
    // esempio un container) può tenere ancora le porte, e un worktree nuovo le troverebbe occupate.
    if (removed && (!cleanup || (cleanup.code === 0 && !cleanup.timedOut))) this.ports.release(cwd)
    this.noticeCleanup(row.id, cleanup)
    // Non tolto: con file non committati è 'dirty'; se è pulito e git l'ha rifiutato lo stesso (sottomoduli, permessi, cartella sparita) è 'failed'.
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
   * "Archivia" dopo il merge (`git.archive`, LAD-69). Solo se la PR è unita (e il branch è tutto dentro) o il branch è già nella base;
   * per un worktree mai con modifiche non committate né con commit che esistono solo lì. Ogni controllo viene prima di toccare
   * qualcosa: se fallisce non è stato archiviato nulla.
   */
  private async archiveAfterMerge(sessionId: string): Promise<GitArchiveResult> {
    const row = this.mustRow(sessionId)
    if (row.archived) throw new Error(t('The session is already archived.'))
    const root = this.mustCwd(row)
    // Un'operazione alla volta per repo (push, merge, archivia) e il fetch in background si ferma.
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

    // La PR è unita? Si rilegge da GitHub (la cache può essere vecchia); senza gh si usa l'ultima nota.
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
      // Commit che non stanno né sulla base né su un remote (né sono la testa della PR): archiviare li lascerebbe solo in un worktree tolto.
      // Se il conteggio non si legge NON si archivia: un errore qui non può valere "nessun commit solo qui".
      const counted = await gitRead(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes', baseRef]).catch(() => null)
      if (counted === null || !/^\d+$/.test(counted.trim())) throw new Error(t('Could not check whether commits exist only in this worktree: nothing was archived.'))
      const only = Number(counted.trim())
      const head = (await resolveCommit(root, 'HEAD')) ?? ''
      if (only > 0 && !(pr && headOid && head === headOid)) {
        throw new Error(plural(only, '{n} commit exists only in this worktree: push it first. Nothing was archived.', '{n} commits exist only in this worktree: push them first. Nothing was archived.'))
      }
    }
    // Dopo le chiamate di rete a gh e i controlli: l'agente può essersi messo al lavoro nel frattempo.
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

/** Agente con profili che un comando di terminale avvia (claude, codex); altro: nessuno. */
function terminalAgent(command: string | null): string {
  const program = basename(splitCommand(command ?? 'claude')[0] ?? '')
  return program === 'claude' ? 'claude-code' : program === 'codex' ? 'codex' : ''
}

function emptyCounts() {
  return { commands: 0, edits: 0, reads: 0, searches: 0 }
}

/** Segnaposto 'New session' in inglese o in una qualsiasi delle lingue: non c'è un flag di rinomina. */
function isPlaceholderTitle(title: string): boolean {
  return translations('New session').includes(title)
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || t('New session')
}

/** Divide un comando in parole rispettando virgolette semplici e doppie. Niente espansioni della shell. */
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

/** Testo della notifica di una richiesta. */
function requestBody(request: UserRequest): string {
  if (request.requestType === 'question') return t('Claude Code asks you a question: {title}', { title: request.title })
  if (request.command) return t('Claude Code asks to run: {command}', { command: request.command })
  if (request.path) return t('Claude Code asks to edit {path}', { path: request.path })
  return t('Claude Code asks to use {tool}', { tool: request.toolName })
}

/** Strumenti di modifica dei file: il livello Edit li approva da solo (apply_patch è quello di Codex). */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'])

/** Richieste che un cambio di livello non approva mai: l'approvazione del piano è una scelta dell'utente. */
const NEVER_AUTO = new Set(['ExitPlanMode'])

/** Origine dei comandi che non arrivano da una porta (nessuna finestra): un'unica connessione fittizia. */
const LOCAL_ORIGIN = {}

/** Il percorso (anche di un file non ancora creato) sta dentro la cartella, risolti i symlink? */
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

/** Cartelle da cui accettiamo l'output di un sotto-agente: i temporanei e ~/.claude (percorsi reali). */
async function reportRoots(): Promise<string[]> {
  const roots: string[] = []
  for (const dir of [tmpdir(), '/tmp', join(homedir(), '.claude')]) {
    try {
      roots.push(await realpath(dir))
    } catch {
      // cartella assente
    }
  }
  return roots
}

/**
 * Output di un sotto-agente in background: solo un file normale e piccolo, dentro cartelle note, aperto senza
 * seguire symlink e letto dal descrittore. Un transcript JSONL non è un report: null.
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

/** Righe JSON con type/message/sessionId: è il transcript della CLI, non il testo del report. */
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

