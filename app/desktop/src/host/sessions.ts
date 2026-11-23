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
  AgentId,
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
  ProjectUiState,
  QueuedMessage,
  Attachment,
  RequestResponse,
  RunState,
  SessionSummary,
  SubagentInfo,
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
import { agentCatalog, resolveAgentSpec, UNKNOWN_LOGIN } from './acp/catalog'
import { OtherAgents } from './acp/others'
import { agentDir, AgentInstaller, recoverInstalls } from './acp/install'
import { hasUnsafeArgs, iconData, registryEntry, registrySpec } from './acp/registry'
import { rm } from 'node:fs/promises'
import { whichInShell, type AgentSession, type SessionOptions } from './agents/common'
import { CodexSession, codexFixedCommands } from './codex/adapter'
import { codexVersion, findCodexCli, probeCodex } from './codex/environment'
import { patchText, reviewPrompt, ReviewRun } from './review'
import { claudeListId, claudeModelNames, claudeProjectDefaults, claudeVersion, findClaudeCli, probeClaude, readClaudeDefaults } from './claude/environment'
import { claudeText, claudeTitle } from './claude/title'
import { COMMIT_BODY_MAX, PR_BODY_MAX, isTextBlocked } from './text-safety'
import { codexDefaults } from './codex/environment'
import { codexText, codexTitle, smallCodexModel } from './codex/title'
import { clipTitle, inTitleQueue, issueRef, teamPrefixes, titlePrompt, withIssue } from './titles'
import { insideRoot, listTree, mediaInfo, readText, RootWatcher, writeText } from './files'
import { BranchMapService, type BranchMapRow, type BranchMapSource } from './branch-map'
import { FileRoots } from './file-roots'
import { aheadBehind, changedFiles, commitChanges, createCheckpoint, ensureExcluded, fetchRef, git, gitRead, gitStatus, listBranches, listFiles, mergeConflicts, repoInfo, resolveCommit } from './git'
import { GitStatusTracker } from './git-status'
import { pushBranch, pushPreview } from './git-push'
import { withRepoLock } from './repo-lock'
import { mergePullRequest } from './pr-merge'
import { mergeBlocks, nextAction } from './merge-flow'
import { Connections } from './connections'
import { customProfileId, isDefaultProfileId, isProfileAgent, Profiles } from './profiles'
import { defaultBranch, ghState, listGithubIssues, listGithubPrs, prForBranch, type PrDetails } from './github'
import { PrFiles } from './pr-files'
import { renderPrPrompt, renderPrompt } from './prompts'
import { searchItems } from './search'
import { SubagentBoard } from './subagents'
import { clampPermission, loadProjectSettings, PERSONAL_PATTERNS, saveWorktreeSettings } from './project-settings'
import { TerminalManager, type AgentKind, type AgentSignal, type SpawnOptions } from './terminals'
import { diffFile, diffFiles, historyList, recordCheckpoint, restore } from './workspace'
import { ProjectGroups } from './project-groups'
import { Shortcuts } from './keybindings'
import { cleanBranchPrefix, DEFAULT_BRANCH_PREFIX } from '@shared/worktree-prefs'
import { backupDatabase, dataInfo } from './data'
import { createWorktree, freePort, portIsFree, Ports, removeWorktree, runCleanupScript, worktreeIncludeFiles, type CleanupResult, type WorktreeBranch } from './worktrees'
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

interface Runtime {
  adapter: AgentSession
  turnId: string | null
  turnStart: string | null
  turnCounts: { commands: number; edits: number; reads: number; searches: number }
  activity: string | null
  pending: Map<string, PendingRequest>
  /** Riga 'command' del turno avviato da un comando /: si chiude a fine turno. */
  command: { id: string; at: number; name: string; args: string } | null
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
  private termStatus = new Map<string, TerminalStatus>()
  /** Sessioni che aspettano lo script di setup del worktree prima di partire. */
  private preparing = new Set<string>()
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
    this.dismissStaleAgentsRows()
    await this.terminals.init()
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
    for (const row of this.rows.values()) {
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
      this.browserAgent.revoke(sessionId)
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
        const sessionId = [...this.rows.values()].find((r) => this.cwdOf(r) === root && !r.archived)?.id ?? null
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
    if (projectId) this.branchMaps.touch(projectId)
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
      if (row.project_id !== projectId || !usable) continue
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
      if (row.archived || this.cwdOf(row) !== root) continue
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
      this.browserAgent.revoke(row.id)
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
    if (mode === 'chat') {
      if (settings.agents.allowed.length && !settings.agents.allowed.includes(command.agent)) {
        throw new Error(t('{agent} is not allowed in this project (.ladder/settings.toml, [agents] allowed).', { agent: this.agentName(command.agent) }))
      }
      const status = this.agents.get(command.agent)
      if (!status) throw new Error(t('Unknown agent: add it in Settings → Agents.'))
      if (!status.available) throw new Error(status.error ?? t('{agent} is not available.', { agent: status.name }))
    }
    // Profilo (account) della sessione: scelto qui, poi non cambia più (nemmeno alla ripresa).
    // Una sessione terminale ha agente 'claude-code' per la UI: il profilo è quello del programma del comando.
    const programAgent = mode === 'terminal' ? terminalAgent(shellCommand) : command.agent
    const requested = mode === 'terminal' && command.profileId && !isDefaultProfileId(command.profileId) && this.profiles.get(command.profileId)?.agent !== programAgent ? null : command.profileId
    const profileId = this.profiles.resolve(programAgent, project.id, requested)
    command = { ...command, permission: clampPermission(command.permission, settings.agents.permissionsMax) }
    const notices: string[] = []
    // Un branch esistente già estratto nel checkout principale non può avere un worktree: si lavora lì.
    const wanted: WorktreeBranch | null = command.branch ?? null
    const useWorktree = Boolean(command.worktree) && !(wanted?.existing && wanted.name === project.branch)
    if (command.worktree && !useWorktree) notices.push(t('Branch {branch} is already checked out in the main checkout: the session works there.', { branch: wanted!.name }))
    if (useWorktree) {
      if (!project.isGit) throw new Error(t('A worktree requires a git repository.'))
      // Il branch non si rinomina dopo la creazione: se il messaggio cita un'issue, il suo identificatore entra nel nome.
      // Il nome suggerito da Linear richiede la sua API con le credenziali dell'utente: non si usa.
      const ref = wanted ? null : issueRef(command.text, this.teamsOf(project.id))
      // Senza issue citata e con i titoli generati accesi, il nome del branch lo propone il modello piccolo (timeout breve: si ricade sul titolo).
      const named = !wanted && !ref && mode === 'chat' ? await this.branchName(project.id, command.agent, profileId, command.text) : null
      const created = await createWorktree(project, withIssue(named ?? title, ref, ' '), settings.worktree.copy, wanted, { dir: this.prefs.worktreesDir, branchPrefix: this.prefs.branchPrefix })
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
      merged_at: null
    }
    this.db
      .prepare(
        `insert into sessions (id, project_id, title, agent, model, effort, permission, created_at, updated_at, mode, command, cwd, worktree, activity_at, source, title_source, profile_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.project_id, row.title, row.agent, row.model, row.effort, row.permission, now, now, mode, shellCommand, row.cwd, row.worktree, now, row.source, row.title_source, row.profile_id)
    this.rows.set(row.id, row)
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
      if (row.archived || (row.run_state !== 'idle' && row.run_state !== 'error') || this.preparing.has(row.id)) continue
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
    // Da qui la sessione è «in archiviazione»: send, avvio turni, riavvii e servizi nuovi vengono rifiutati.
    this.archiving.add(sessionId)
    // Progetto e script di pulizia si leggono ora, prima di ogni attesa: project.remove può togliere il progetto mentre i servizi si fermano.
    let project: Project | undefined
    let script: string | null = null
    try {
      if (row.worktree && options.cleanup !== false) {
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
    if (project && script) {
      const cwd = this.cwdOf(row)
      if (existsSync(cwd)) this.noticeCleanup(sessionId, await runCleanupScript(cwd, script, this.ports.allocate(cwd)))
    }
  }

  private async archiveSession(sessionId: string, row: SessionRow): Promise<void> {
    // Prima la revoca: scioglie le conferme del browser dell'agente ancora aperte (expireRequest ha bisogno del runtime).
    this.browserAgent.revoke(sessionId)
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
    await this.stopServices(this.cwdOf(row))
    await Promise.all(this.terminals.bySession(sessionId).map((terminal) => this.terminals.close(terminal.id)))
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
    if (!this.canSteer(row) || row.run_state !== 'running' || runtime.command || runtime.interrupting || runtime.closing > 0 || this.preparing.has(sessionId)) return false
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
      { cwd: this.cwdOf(row), model: row.model, effort: row.effort as Effort | null, permission: row.permission as PermissionLevel, resume: row.external_id, autonomyHint: this.prefs.autonomyHint !== false, browserTools: this.browserAgent.register(sessionId, row.project_id) },
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

  private async startTurn(sessionId: string, text: string, attachments: Attachment[] = [], command: { name: string; args: string } | null = null): Promise<void> {
    const row = this.mustRow(sessionId)
    // Browser per l'agente: il server deve già ascoltare quando nasce il runtime (solo se l'interruttore è acceso).
    if (this.isGone(sessionId)) return
    const browserReady = this.runtimes.has(sessionId) ? null : this.browserAgent.prepare(row.project_id)
    if (browserReady) await browserReady
    // L'archiviazione può essere arrivata mentre si aspettava il browser.
    if (this.isGone(sessionId)) return
    const runtime = this.ensureRuntime(sessionId)
    // Il titolo nasce dal primo messaggio dell'utente: un comando iniziale non lo consuma.
    // Un titolo scelto (rinominato o dato alla creazione) non si tocca: si sostituisce solo il segnaposto.
    const firstMessage = !command && isPlaceholderTitle(row.title) && !this.hasUserMessage(sessionId)
    runtime.lastCommand = command?.name ?? null
    await this.beginTurn(sessionId, runtime, {
      // Il titolo nasce dal primo messaggio, tranne per le sessioni da issue, PR o branch: lì resta il loro titolo.
      title: firstMessage && !row.source ? titleFrom(text) : undefined,
      label: titleFrom(text),
      // Un comando / non è la ripresa dei background.
      agentsState: command ? 'dismissed' : 'continued',
      rows: (turnId) => {
        if (command) {
          runtime.command = { id: randomUUID(), at: Date.now(), ...command }
          this.upsertItem(sessionId, { kind: 'command', ...runtime.command, turnId, status: 'running', error: null })
        } else {
          this.upsertItem(sessionId, this.userItem(turnId, text, attachments))
        }
      }
    })
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
          this.runtimes.delete(sessionId)
          this.browserAgent.revoke(sessionId)
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
              this.browserAgent.revoke(sessionId)
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
    // Da leggere prima che expireRequest svuoti pending e che finishCommand chiuda il comando.
    const hadRequest = runtime.pending.size > 0
    const wasCommand = !!runtime.command
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
    else if (result.status === 'completed' && project && !merged) {
      this.attention({ kind: 'turn', sessionId, projectId: project.id, projectName: project.name, itemId: end.id, durationMs: result.durationMs, title: row.title })
    }
    // Titolo da un modello piccolo, dopo il primo turno concluso: in background, senza aspettarlo.
    if (result.status === 'completed' && !superseded) void this.autoTitle(sessionId)

    // Messaggi inseriti non ancora uniti a un turno girano da soli (turno implicito, già o a momenti aperto):
    // la coda riparte alla fine di quel turno.
    if (superseded || runtime.adapter.isRunning || runtime.exited) return
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
        if (!runtime.adapter.isRunning) {
          runtime.turnId = null
          runtime.activity = null
        }
        this.updateRow(sessionId, { queue: JSON.stringify(current), ...(runtime.adapter.isRunning ? {} : { run_state: 'idle' }) })
        this.emitSummary(sessionId)
        this.noticeError(sessionId, (error as Error).message)
      }
    }
  }

  /** Ultimo testo dell'assistente nel turno ('' se non ha scritto nulla). */
  private lastAssistantText(sessionId: string, turnId: string): string {
    let last: Extract<ChatItem, { kind: 'assistant' }> | null = null
    for (const item of this.liveItems.get(sessionId)?.values() ?? []) {
      if (item.kind === 'assistant' && item.turnId === turnId && (!last || item.seq > last.seq)) last = item
    }
    return last?.text.trim() ?? ''
  }

  /** `all`: Stop (ferma anche i messaggi inseriti non ancora uniti); false per "invia ora", che li unisce al messaggio nuovo. */
  private async interrupt(sessionId: string, all = true): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    for (const [requestId] of runtime.pending) this.expireRequest(sessionId, requestId)
    runtime.interrupting = true
    // Stop: ferma anche l'azione in corso nel browser dell'agente e ne revoca gli strumenti fino al turno dopo (stop implicito).
    this.browserAgent.stop(sessionId, 'interrupt')
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
      canSteer: this.canSteer(row),
      branch: this.branchOf(row),
      pr: this.prOf(row),
      source: row.source ? (JSON.parse(row.source) as SessionSource) : null,
      subagentCounts: this.subagents.counts(row.id, !!this.runtimes.get(row.id)?.turnId),
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
    if (row && project) this.attention({ kind: 'error', sessionId, projectId: project.id, itemId, title: `${project.name} · ${row.title}`, body: text })
  }

  /** Badge: una per richiesta aperta, più le sessioni ferme per errore che non hai ancora visto. */
  private updateBadge(): void {
    let count = 0
    for (const row of this.rows.values()) {
      if (row.archived || !this.projects.has(row.project_id)) continue
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
      if (row.archived || !row.worktree || pr?.state !== 'merged' || this.mergedHandled.has(row.id)) continue
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

  /** Un'altra sessione non archiviata usa la stessa cartella di lavoro. */
  private worktreeShared(row: SessionRow): boolean {
    const cwd = this.cwdOf(row)
    return [...this.rows.values()].some((r) => r.id !== row.id && !r.archived && this.cwdOf(r) === cwd)
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
    for (const timer of this.agentsWait.values()) clearTimeout(timer)
    this.agentsWait.clear()
    this.flush()
    for (const runtime of this.runtimes.values()) runtime.adapter.close()
    void this.browserAgent.shutdown()
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

