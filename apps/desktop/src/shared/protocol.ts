import type { Locale } from './i18n'
// Tipi condivisi tra host delle sessioni, processo main e renderer.
// L'host è la fonte di verità: il renderer riceve progetti, sessioni ed elementi della chat già pronti.

/** Agenti in chat: i due nativi e quelli ACP, con l'id della loro voce (`acp:gemini`). */
export type AgentId = 'claude-code' | 'codex' | `acp:${string}`

/** Voce di un agente ACP: basta un comando. Dal registro ufficiale o scritta a mano. */
export interface AcpAgentSpec {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  source: 'registry' | 'custom'
  version?: string | null
  description?: string | null
  /** Icona dal registro, scaricata all'aggiunta e salvata come data URL (SVG). */
  icon?: string | null
}

/** Agente del registro ACP che Ladder sa avviare (npx o uvx). */
export interface RegistryAgent {
  id: string
  name: string
  version: string
  description: string
  command: string
  args: string[]
  added: boolean
}
/** Chat: l'agente parla con Ladder. Terminale: la CLI originale gira in un PTY. */
export type SessionMode = 'chat' | 'terminal'
export type PermissionLevel = 'plan' | 'ask' | 'edit' | 'full'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Project {
  id: string
  name: string
  path: string
  branch: string | null
  isGit: boolean
  addedAt: number
}

/** Stato dell'esecuzione: deriva dall'agente, non dalla UI. `queued`: il turno aspetta un posto libero (limite di sessioni attive). */
export type RunState = 'idle' | 'starting' | 'running' | 'waiting' | 'error' | 'queued'

/** Allegato inviato all'agente. Per ora solo immagini, in base64. */
export interface Attachment {
  name: string
  mediaType: string
  data: string
}

export interface QueuedMessage {
  id: string
  text: string
  attachments?: Attachment[]
}

export interface SessionSummary {
  id: string
  projectId: string
  title: string
  agent: AgentId
  model: string | null
  effort: Effort | null
  permission: PermissionLevel
  createdAt: number
  updatedAt: number
  run: RunState
  /** Etichetta breve quando la sessione aspetta l'utente: "Approvazione", "Domanda". */
  waitingLabel: string | null
  /** Testo dell'attività corrente mentre lavora: "Esegue pnpm test". */
  activity: string | null
  unread: boolean
  /** Ultimo elemento letto: il primo non letto è lastReadSeq + 1. */
  lastReadSeq: number
  archived: boolean
  queue: QueuedMessage[]
  context: { used: number; window: number } | null
  mode: SessionMode
  /** Cartella in cui lavora la sessione: il checkout principale o il suo worktree. */
  cwd: string
  worktree: WorktreeInfo | null
  /** Sessione terminale: comando avviato (claude, codex, …) e terminale che lo ospita. */
  command: string | null
  terminalId: string | null
  /** Lo stato viene da euristiche (output, campanello), non da segnali dell'agente. */
  estimated: boolean
  /** Da quando la sessione aspetta l'utente: ordina "In attesa" e ⌘⇧A per anzianità. */
  waitingSince: number | null
  /** Richiesta aperta più vecchia, per rispondere da "In attesa" senza aprire la sessione. */
  request: RequestItemData | null
  /** Richieste aperte (di solito una; più di una con strumenti in parallelo). */
  openRequests: number
  /** Ultima attività dell'agente (fine turno, errore): decide "Concluse" e "Mentre eri via". */
  activityAt: number
  /** Motivo dell'attesa in coda: "In coda: 3 sessioni Claude Code attive". */
  queuedReason: string | null
  /** Branch su cui lavora la sessione: quello del worktree o del checkout principale. */
  branch: string | null
  /** Stato della PR del branch, se c'è (da gh). */
  pr: PrStatus | null
  /** Da dove è nata la sessione: issue, PR o branch. */
  source: SessionSource | null
  /** Sotto-agenti dell'ultimo turno e quelli ancora vivi: la mappa degli agenti. */
  subagents?: SubagentInfo[]
}

/** Un sotto-agente avviato dalla sessione (Task di Claude Code, spawnAgent di Codex). */
export interface SubagentInfo {
  /** Id stabile: il tool_use di Claude Code o il thread del sotto-agente di Codex. */
  id: string
  /** Sotto-agente che l'ha avviato; null se l'ha avviato la sessione. */
  parentId: string | null
  /** Compito in breve: "Explore the auth module". */
  title: string
  /** Tipo di agente: "general-purpose", "Explore", "worker". */
  kind: string | null
  model: string | null
  status: 'running' | 'done' | 'error' | 'stopped'
  startedAt: number
  endedAt: number | null
  /** Cosa sta facendo adesso: l'ultimo strumento o il riassunto dell'agente. */
  activity: string | null
  tokens: number | null
  toolUses: number | null
  /** Continua in background mentre la sessione va avanti. */
  background: boolean
}

export interface SessionSource {
  kind: 'github-issue' | 'github-pr' | 'linear' | 'branch'
  /** "#12", "LIN-42", nome del branch. */
  ref: string
  title: string
  url: string | null
}

export interface PrStatus {
  number: number
  title: string
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  checks: 'none' | 'pending' | 'passing' | 'failing'
  /** conflicts: il branch non si unisce senza conflitti alla base. */
  mergeable: 'clean' | 'conflicts' | 'unknown'
  review: 'approved' | 'changes' | 'pending' | null
  base: string
  updatedAt: number
}

export interface WorktreeInfo {
  path: string
  branch: string
  /** Commit da cui è partito il worktree. */
  base: string
}

export interface FileChange {
  path: string
  /** Percorso prima della rinomina. */
  oldPath?: string
  added: number
  removed: number
  status: 'A' | 'M' | 'D' | 'R'
  binary?: boolean
}

export type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'plan' | 'other'

export interface RequestOption {
  id: string
  label: string
  kind: 'allow' | 'allow-always' | 'deny'
}

export interface Question {
  question: string
  header: string | null
  multiSelect: boolean
  options: { label: string; description: string | null }[]
}

interface ItemBase {
  id: string
  turnId: string
  /** Ordine stabile all'interno della sessione. */
  seq: number
  at: number
}

export type ChatItem =
  | (ItemBase & { kind: 'user'; text: string; attachments?: { name: string; mediaType: string }[] })
  | (ItemBase & { kind: 'assistant'; text: string; streaming: boolean })
  | (ItemBase & {
      kind: 'tool'
      tool: ToolKind
      /** Nome dello strumento dell'agente, per esempio Bash o Edit. */
      name: string
      /** Testo breve leggibile: "Esegue pnpm test", "Legge src/app.ts". */
      title: string
      /** Comando, percorso o pattern completo. */
      detail: string | null
      status: 'running' | 'done' | 'error' | 'denied'
      output: string | null
      endedAt: number | null
    })
  | (ItemBase & {
      kind: 'request'
      requestId: string
      requestType: 'permission' | 'question'
      toolName: string
      title: string
      command: string | null
      path: string | null
      reason: string | null
      options: RequestOption[]
      questions: Question[] | null
      state: 'open' | 'resolved' | 'expired'
      /** Testo che descrive la risposta data: "Approvato", "Rifiutato: usa pnpm". */
      resolution: string | null
      /** Modifica proposta per Edit e Write, come righe con - e +. */
      preview?: { text: string; lines: number; truncated: boolean } | null
      /** Dove hai risposto: nella chat, da "In attesa" o dalla notifica. */
      via?: ResponseVia
    })
  | (ItemBase & {
      kind: 'turn-end'
      status: 'completed' | 'interrupted' | 'error'
      durationMs: number
      counts: { commands: number; edits: number; reads: number; searches: number }
      files: FileChange[]
      error: string | null
      costUsd: number | null
      /** Checkpoint git di inizio e fine turno: servono al diff e al ripristino. */
      checkpoints?: { start: string; end: string } | null
    })
  | (ItemBase & { kind: 'notice'; tone: 'info' | 'error'; text: string })

export type RequestResponse = { optionId: string; message?: string } | { answers: Record<string, string> }
export type ResponseVia = 'chat' | 'inbox' | 'notification'
export type RequestItemData = Extract<ChatItem, { kind: 'request' }>

/** Una finestra dei limiti del piano: quanto ne hai usato e quando si azzera. */
export interface UsageWindow {
  key: string
  minutes: number
  /** Limite riservato a una famiglia di modelli, per esempio Opus. */
  model: string | null
  percent: number | null
  /** Secondi Unix. */
  resetsAt: number | null
  state: 'ok' | 'warning' | 'limited'
}

export interface AgentStatus {
  agent: AgentId
  name: string
  kind: 'native' | 'acp'
  available: boolean
  version: string | null
  /** Account in uso, per esempio "Claude Ultra" o "ChatGPT Plus". */
  account: string | null
  /** Email dell'account, quando l'agente la espone: si vede in basso nella sidebar. */
  email?: string | null
  /** `efforts`: livelli che il modello accetta; vuoto se non ne ha, assente se l'agente non lo dice. */
  models: { id: string; label: string; efforts?: Effort[] }[]
  error: string | null
  /** Finestre dei limiti, aggiornate da ogni sessione. */
  usage?: UsageWindow[]
  /** Limiti d'uso leggibili, quando l'agente li espone: "14% della finestra di 5 h · 11% settimanale". */
  limits?: string | null
  /** Percorso della CLI usata. */
  path?: string | null
  /** Icona dell'agente ACP (data URL); per i nativi la sceglie l'interfaccia. */
  icon?: string | null
}

export type InspectorTab = 'changes' | 'files' | 'history' | 'merge'
export type EditorId = 'cursor' | 'vscode'

export interface ProjectUiState {
  tabs: string[]
  activeTab: string | null
  /** Ancora di lettura per sessione: elemento in cima alla vista e scostamento in pixel. */
  scroll: Record<string, { itemId: string; offset: number }>
  /** Ispettore a destra (Modifiche, File, Cronologia) e pannello terminale in basso. */
  inspector?: { open: boolean; tab: InspectorTab }
  terminal?: { open: boolean; height: number; active: string | null; side?: 'bottom' | 'right'; width?: number }
  /** Editor esterno preferito per il progetto. */
  editor?: EditorId
  /** Ultima volta che hai guardato il progetto con la finestra attiva: serve a "Mentre eri via". */
  seenAt?: number
  /** File aperti come tab, nell'ordine di apertura. */
  fileTabs?: { root: string; path: string }[]
  /** Gruppi di chat creati da te, nell'ordine in cui si vedono nella sidebar. */
  groups?: { id: string; name: string; collapsed?: boolean }[]
  /** Gruppo di ogni sessione raggruppata. */
  groupOf?: Record<string, string>
  /** Ultimo agente usato in chat nel progetto: la nuova chat lo propone. */
  lastAgent?: AgentId
}

// ── File, diff e cronologia ──────────────────────────────────────────────

export type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'U'

export interface FileTree {
  root: string
  isGit: boolean
  /** Percorsi relativi: tracciati più non tracciati non ignorati. */
  files: string[]
  status: Record<string, GitStatusCode>
  truncated: boolean
}

export interface FileContent {
  path: string
  size: number
  binary: boolean
  tooLarge: boolean
  text: string | null
  /** Ora di modifica su disco: al salvataggio dice se nel frattempo qualcuno ha scritto il file. */
  mtimeMs: number
}

export type FileWriteResult = { ok: true; mtimeMs: number } | { ok: false; text: string; mtimeMs: number }

/** Ambito del pannello Modifiche. */
export type DiffScope =
  | { kind: 'turn'; sessionId: string; turnId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'uncommitted' }
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; from: string; to: string; label: string }

export interface DiffResult {
  root: string
  from: string
  to: string
  files: FileChange[]
  /** Il lato "dopo" è lo stato attuale dei file: cambia mentre lavori. */
  live: boolean
}

export interface FilePatch {
  path: string
  oldPath: string | null
  /** Diff unificato di git, con 3 righe di contesto. */
  patch: string
  oldText: string | null
  newText: string | null
  binary: boolean
  tooLarge: boolean
}

export interface HistoryEntry {
  id: string
  kind: 'turn' | 'commit' | 'restore'
  at: number
  title: string
  /** Titolo della sessione o autore del commit. */
  detail: string | null
  sessionId: string | null
  turnId: string | null
  /** Stato a cui si può tornare con "Ripristina". */
  sha: string
  /** Modifiche di questo punto. */
  diff: { from: string; to: string } | null
  files: number | null
}

// ── Terminali e configurazione del progetto ──────────────────────────────

export interface TerminalInfo {
  id: string
  projectId: string
  /** Sessione a cui appartiene: la sessione terminale stessa, o quella da cui è partita un'azione. */
  sessionId: string | null
  /** shell: pannello in basso; run: azione di avvio o setup; agent: CLI di una sessione terminale. */
  kind: 'shell' | 'run' | 'agent'
  title: string
  cwd: string
  command: string | null
  /** stopped: ripristinato dopo un riavvio di Ladder, il processo non c'è più. */
  state: 'running' | 'exited' | 'stopped'
  exitCode: number | null
  createdAt: number
  /** LADDER_PORT passato al processo. */
  port: number | null
}

export interface RunAction {
  name: string
  command: string
  default: boolean
  concurrent: boolean
}

export interface ProjectSettings {
  worktree: { setup: string | null; copy: string[]; ports: number; archive: string | null }
  run: RunAction[]
  prompts: Record<string, string>
  /** [agents]: agenti ammessi (vuoto = tutti), agente proposto, livello di permesso massimo. */
  agents: { allowed: string[]; default: string | null; permissionsMax: PermissionLevel | null }
  /** File letti, relativi alla radice del progetto. */
  sources: string[]
  errors: string[]
}

// ── Review con un altro agente ───────────────────────────────────────────

export interface ReviewNote {
  path: string
  line: number
  body: string
}

export interface ReviewState {
  id: string
  sessionId: string
  agent: AgentId
  agentName: string
  /** Ambito rivisto, per collegare i commenti al diff giusto. */
  scope: DiffScope
  state: 'running' | 'done' | 'error' | 'cancelled'
  summary: string | null
  comments: ReviewNote[]
  error: string | null
  startedAt: number
}

// ── Ricerca, issue e merge ───────────────────────────────────────────────

export interface SearchHit {
  sessionId: string
  itemId: string
  /** Testo intorno alla corrispondenza. */
  snippet: string
  kind: 'message' | 'reply' | 'command' | 'file'
  at: number
}

/** Elemento da cui creare una sessione: issue o PR di GitHub, issue di Linear, branch. */
export interface IssueItem {
  source: SessionSource['kind']
  /** Numero della issue o PR, identificativo Linear o nome del branch. */
  ref: string
  title: string
  body: string | null
  url: string | null
  /** Branch da usare: quello della PR, quello suggerito da Linear, il branch scelto. */
  branch: string | null
  state: string | null
  updatedAt: number | null
}

export interface IssueList {
  items: IssueItem[]
  /** Perché la lista è vuota o parziale: gh mancante, nessun remote GitHub, chiave Linear assente. */
  problem: string | null
}

export interface MergeCheck {
  name: string
  state: 'pending' | 'passing' | 'failing' | 'skipped'
  url: string | null
}

export interface ReviewComment {
  author: string
  path: string | null
  line: number | null
  body: string
  url: string | null
  at: number
}

export interface MergeInfo {
  root: string
  branch: string | null
  /** Branch di destinazione: quello della PR o il predefinito del repository. */
  base: string | null
  isDefaultBranch: boolean
  /** File modificati e non committati. */
  dirty: number
  /** Commit del branch che la base non ha. */
  ahead: number
  behind: number
  /** Commit non ancora pubblicati sul remote; null se il branch non ha upstream. */
  unpushed: number | null
  hasUpstream: boolean
  /** File in conflitto se unisci la base, calcolato senza toccare la cartella. */
  conflicts: string[]
  gh: 'ok' | 'missing' | 'unauthenticated' | 'no-remote' | 'error'
  ghError: string | null
  pr: PrStatus | null
  checks: MergeCheck[]
  comments: ReviewComment[]
}

/** Chiave delle bozze: id della sessione oppure `new:<projectId>` per la nuova chat. */
export type DraftKey = string

export type HostCommand =
  | { type: 'hello' }
  | { type: 'project.add'; path: string }
  | { type: 'project.remove'; projectId: string }
  | {
      type: 'session.create'
      projectId: string
      agent: AgentId
      text: string
      model: string | null
      effort: Effort | null
      permission: PermissionLevel
      attachments?: Attachment[]
      /** Sessione terminale: comando da avviare al posto della chat. */
      mode?: SessionMode
      command?: string
      /** Lavora in un nuovo worktree invece che nel checkout principale. */
      worktree?: boolean
      /** Branch del worktree: nuovo (da HEAD) o esistente da estrarre (PR, branch scelto). */
      branch?: { name: string; existing: boolean; pr?: number } | null
      source?: SessionSource | null
      title?: string
    }
  /** Sessione terminale ferma (dopo un riavvio o un'uscita): riavvia la CLI, riprendendo la conversazione se può. */
  | { type: 'session.resume'; sessionId: string }
  | { type: 'session.send'; sessionId: string; text: string; attachments?: Attachment[] }
  | { type: 'session.rename'; sessionId: string; title: string }
  | { type: 'session.unread'; sessionId: string }
  /** File del progetto, percorsi relativi: tracciati e non tracciati non ignorati. */
  | { type: 'project.files'; projectId: string }
  | { type: 'session.queue.set'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'session.interrupt'; sessionId: string }
  | { type: 'session.respond'; sessionId: string; requestId: string; response: RequestResponse; via?: ResponseVia }
  | { type: 'session.permission.set'; sessionId: string; permission: PermissionLevel }
  | { type: 'session.model.set'; sessionId: string; model: string }
  | { type: 'session.effort.set'; sessionId: string; effort: Effort }
  | { type: 'session.open'; sessionId: string }
  | { type: 'session.read'; sessionId: string }
  | { type: 'session.archive'; sessionId: string }
  | { type: 'draft.set'; key: DraftKey; text: string }
  | { type: 'ui.set'; projectId: string; state: ProjectUiState }
  // File, diff e cronologia. `root` è la cartella di un progetto o di una sessione (worktree).
  | { type: 'fs.tree'; root: string }
  | { type: 'fs.read'; root: string; path: string }
  /** `baseMtime` null: scrive comunque. Altrimenti, se il file è cambiato, non scrive e rimanda il testo su disco. */
  | { type: 'fs.write'; root: string; path: string; text: string; baseMtime: number | null }
  | { type: 'fs.watch'; root: string; on: boolean }
  | { type: 'diff.files'; root: string; scope: DiffScope }
  | { type: 'diff.file'; root: string; from: string; to: string; path: string; oldPath?: string | null }
  /** Riporta i file allo stato di `to`. Restituisce il checkpoint per annullare. */
  | { type: 'git.restore'; root: string; to: string; paths?: string[]; label: string }
  | { type: 'history.list'; root: string; sessionId?: string | null }
  // Terminali.
  | { type: 'terminal.create'; projectId: string; sessionId?: string | null; cwd?: string }
  | { type: 'terminal.attach'; id: string; cols: number; rows: number }
  | { type: 'terminal.input'; id: string; data: string }
  | { type: 'terminal.resize'; id: string; cols: number; rows: number }
  | { type: 'terminal.close'; id: string }
  | { type: 'terminal.restart'; id: string }
  /** Ultime righe del terminale come testo semplice, per @terminal. */
  | { type: 'terminal.output'; id: string; lines?: number }
  // Configurazione del progetto (.ladder/settings.toml) e azioni di avvio.
  | { type: 'project.settings'; projectId: string }
  | { type: 'run.start'; projectId: string; sessionId?: string | null; name: string }
  // Ricerca nelle conversazioni (⌘K), issue e PR per nuove sessioni, pannello merge e prompt dei pulsanti.
  | { type: 'search'; query: string }
  | { type: 'issues.list'; projectId: string; source: 'github-issue' | 'github-pr' | 'branch' }
  | { type: 'merge.info'; root: string; fetch?: boolean }
  /** Testo del prompt dietro un pulsante (create_pr, fix, conflicts, review, issue), con le variabili già sostituite. */
  | { type: 'prompt.render'; projectId: string; name: string; vars: Record<string, string> }
  // Agenti ACP: catalogo del registro, aggiunta e rimozione.
  | { type: 'agents.registry' }
  | { type: 'agents.add'; spec: AcpAgentSpec }
  | { type: 'agents.remove'; id: string }
  /** Review in sola lettura delle modifiche di una sessione, chiesta a un altro agente. Torna come commenti. */
  | { type: 'review.start'; sessionId: string; agent: AgentId; scope: DiffScope }
  | { type: 'review.cancel'; reviewId: string }

export type HostEvent =
  | {
      type: 'snapshot'
      projects: Project[]
      sessions: SessionSummary[]
      drafts: Record<DraftKey, string>
      ui: Record<string, ProjectUiState>
      agents: AgentStatus[]
      terminals: TerminalInfo[]
    }
  | { type: 'project.upsert'; project: Project }
  | { type: 'project.removed'; projectId: string }
  | { type: 'session.upsert'; session: SessionSummary }
  | { type: 'session.items'; sessionId: string; items: ChatItem[]; replace: boolean }
  | { type: 'agent.status'; status: AgentStatus }
  | { type: 'agent.removed'; agent: AgentId }
  | { type: 'review.update'; review: ReviewState }
  | { type: 'terminal.upsert'; terminal: TerminalInfo }
  | { type: 'terminal.removed'; id: string }
  | { type: 'terminal.data'; id: string; data: string }
  /** Qualcosa è cambiato nella cartella: albero, stato git e diff "attuali" vanno riletti. */
  | { type: 'fs.changed'; root: string }

/** Messaggi sul canale renderer ↔ host. I comandi con `rid` ricevono una risposta con lo stesso id. */
export type ToHost = { rid?: string; command: HostCommand }
export type FromHost =
  | { kind: 'event'; event: HostEvent }
  | { kind: 'result'; rid: string; ok: true; data?: unknown }
  | { kind: 'result'; rid: string; ok: false; error: string }

// ── Host ↔ processo main: notifiche, badge del Dock e preferenze ─────────────

/** Eventi che possono diventare una notifica di macOS. Decide il main, che sa cosa stai guardando. */
export type AttentionEvent =
  | { kind: 'request'; sessionId: string; projectId: string; itemId: string | null; title: string; body: string }
  | { kind: 'resolved'; sessionId: string; itemId: string | null }
  | { kind: 'turn'; sessionId: string; projectId: string; projectName: string; itemId: string | null; durationMs: number; title: string }
  | { kind: 'error'; sessionId: string; projectId: string; itemId: string | null; title: string; body: string }

export type HostToMain = { type: 'attention'; event: AttentionEvent } | { type: 'badge'; count: number }

export interface HostPrefs {
  /** Turni attivi insieme per agente; gli altri aspettano "In coda". */
  maxActive: Record<AgentId, number>
  /** Lingua di avvisi, errori, notifiche e prompt predefiniti. */
  locale?: Locale
}

export type MainToHost = { type: 'connect' } | { type: 'prefs'; prefs: HostPrefs }

/** Preferenze dell'app salvate dal main in settings.json, insieme al tema. */
export interface AppPrefs {
  notifications: boolean
  /** Suono solo per approvazioni e domande. */
  sound: boolean
  /** "Non disturbare" fino a questo istante: niente notifiche; "In attesa" e badge restano. */
  dndUntil: number | null
  maxActive: number
  /** Lingua dell'interfaccia: inglese per default, italiano a scelta. */
  locale: Locale
}

/** Cosa sta guardando la finestra: il main non notifica una richiesta della sessione che hai davanti. */
export interface WindowView {
  projectId: string | null
  sessionId: string | null
}
