// Tipi condivisi tra host delle sessioni, processo main e renderer.
// L'host è la fonte di verità: il renderer riceve progetti, sessioni ed elementi della chat già pronti.

export type AgentId = 'claude-code' | 'codex'
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

/** Stato dell'esecuzione: deriva dall'agente, non dalla UI. */
export type RunState = 'idle' | 'starting' | 'running' | 'waiting' | 'error'

export interface QueuedMessage {
  id: string
  text: string
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
}

export interface FileChange {
  path: string
  added: number
  removed: number
  status: 'A' | 'M' | 'D' | 'R'
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
  | (ItemBase & { kind: 'user'; text: string })
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
    })
  | (ItemBase & {
      kind: 'turn-end'
      status: 'completed' | 'interrupted' | 'error'
      durationMs: number
      counts: { commands: number; edits: number; reads: number; searches: number }
      files: FileChange[]
      error: string | null
      costUsd: number | null
    })
  | (ItemBase & { kind: 'notice'; tone: 'info' | 'error'; text: string })

export type RequestResponse = { optionId: string; message?: string } | { answers: Record<string, string> }

export interface AgentStatus {
  agent: AgentId
  available: boolean
  version: string | null
  /** Account in uso, per esempio "Claude Ultra" o "API key". */
  account: string | null
  models: { id: string; label: string }[]
  error: string | null
}

export interface ProjectUiState {
  tabs: string[]
  activeTab: string | null
  /** Ancora di lettura per sessione: elemento in cima alla vista e scostamento in pixel. */
  scroll: Record<string, { itemId: string; offset: number }>
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
    }
  | { type: 'session.send'; sessionId: string; text: string }
  | { type: 'session.queue.set'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'session.interrupt'; sessionId: string }
  | { type: 'session.respond'; sessionId: string; requestId: string; response: RequestResponse }
  | { type: 'session.permission.set'; sessionId: string; permission: PermissionLevel }
  | { type: 'session.model.set'; sessionId: string; model: string }
  | { type: 'session.open'; sessionId: string }
  | { type: 'session.read'; sessionId: string }
  | { type: 'session.archive'; sessionId: string }
  | { type: 'draft.set'; key: DraftKey; text: string }
  | { type: 'ui.set'; projectId: string; state: ProjectUiState }

export type HostEvent =
  | {
      type: 'snapshot'
      projects: Project[]
      sessions: SessionSummary[]
      drafts: Record<DraftKey, string>
      ui: Record<string, ProjectUiState>
      agents: AgentStatus[]
    }
  | { type: 'project.upsert'; project: Project }
  | { type: 'project.removed'; projectId: string }
  | { type: 'session.upsert'; session: SessionSummary }
  | { type: 'session.items'; sessionId: string; items: ChatItem[]; replace: boolean }
  | { type: 'agent.status'; status: AgentStatus }

/** Messaggi sul canale renderer ↔ host. I comandi con `rid` ricevono una risposta con lo stesso id. */
export type ToHost = { rid?: string; command: HostCommand }
export type FromHost =
  | { kind: 'event'; event: HostEvent }
  | { kind: 'result'; rid: string; ok: true; data?: unknown }
  | { kind: 'result'; rid: string; ok: false; error: string }
