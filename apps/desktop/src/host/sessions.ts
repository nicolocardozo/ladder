// Cuore dell'host: progetti, sessioni, elementi della chat e collegamento con gli adapter.
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  AgentStatus,
  ChatItem,
  DraftKey,
  Effort,
  HostCommand,
  HostEvent,
  PermissionLevel,
  Project,
  ProjectUiState,
  QueuedMessage,
  RequestResponse,
  RunState,
  SessionSummary
} from '@shared/protocol'
import { tx, type Db, type ProjectRow, type SessionRow } from './db'
import { ClaudeSession, type AdapterEvents, type ToolUpdate, type TurnResult, type UserRequest } from './claude/adapter'
import { claudeVersion, findClaudeCli } from './claude/environment'
import { changedFiles, createCheckpoint, repoInfo } from './git'

type Broadcast = (event: HostEvent) => void
type ItemInput = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'seq'> : never) : never

interface PendingRequest {
  itemId: string
  resolve: (response: RequestResponse) => void
}

interface Runtime {
  adapter: ClaudeSession
  turnId: string | null
  turnStart: string | null
  turnCounts: { commands: number; edits: number; reads: number; searches: number }
  activity: string | null
  pending: Map<string, PendingRequest>
}

const FLUSH_MS = 33

export class Host {
  private projects = new Map<string, Project>()
  private rows = new Map<string, SessionRow>()
  private runtimes = new Map<string, Runtime>()
  /** Elementi in memoria delle sessioni attive, per aggiornare lo streaming senza rileggere il database. */
  private liveItems = new Map<string, Map<string, ChatItem>>()
  private dirty = new Map<string, Map<string, ChatItem>>()
  private flushTimer: NodeJS.Timeout | null = null
  private claudeCli: string | null = null
  private agent: AgentStatus = { agent: 'claude-code', available: false, version: null, account: null, models: [], error: null }

  constructor(
    private readonly db: Db,
    private readonly broadcast: Broadcast
  ) {}

  // ── Avvio ────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    for (const row of this.db.prepare('select * from projects order by added_at').all() as unknown as ProjectRow[]) {
      this.projects.set(row.id, await this.projectFromRow(row))
    }
    for (const row of this.db.prepare('select * from sessions').all() as unknown as SessionRow[]) this.rows.set(row.id, row)
    this.recoverInterrupted()
    this.claudeCli = await findClaudeCli()
    const version = this.claudeCli ? await claudeVersion(this.claudeCli) : null
    // Account e modelli dell'ultima sessione: servono al composer prima che parta una nuova sessione.
    const cached = this.db.prepare(`select value from kv where key = 'agent:claude-code'`).get() as { value: string } | undefined
    const saved = cached ? (JSON.parse(cached.value) as Pick<AgentStatus, 'account' | 'models'>) : null
    this.agent = {
      ...this.agent,
      account: saved?.account ?? null,
      models: saved?.models ?? [],
      available: Boolean(this.claudeCli),
      version,
      error: this.claudeCli ? null : 'CLI di Claude Code non trovata. Installala e riapri Ladder.'
    }
  }

  /** Sessioni che lavoravano quando Ladder è stato chiuso: tornano ferme, con una nota e le richieste scadute. */
  private recoverInterrupted(): void {
    for (const row of this.rows.values()) {
      if (row.run_state === 'idle' || row.run_state === 'error') continue
      const open = this.db
        .prepare(`select id, json from items where session_id = ? and json like '%"state":"open"%'`)
        .all(row.id) as { id: string; json: string }[]
      tx(this.db, () => {
        for (const { json } of open) {
          const item = JSON.parse(json) as ChatItem
          if (item.kind === 'request') this.writeItem(row.id, { ...item, state: 'expired', resolution: 'Scaduta' })
        }
        this.writeItem(row.id, this.withSeq(row.id, {
          kind: 'notice',
          id: randomUUID(),
          turnId: 'recovery',
          at: Date.now(),
          tone: 'info',
          text: 'Ladder è stato chiuso mentre la sessione lavorava. Scrivi un messaggio per riprendere.'
        }))
        this.updateRow(row.id, { run_state: 'idle' })
      })
    }
  }

  private async projectFromRow(row: ProjectRow): Promise<Project> {
    const info = existsSync(row.path) ? await repoInfo(row.path) : { isGit: false, branch: null, hasHead: false }
    return { id: row.id, name: row.name, path: row.path, branch: info.branch, isGit: info.isGit, addedAt: row.added_at }
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
      agents: [this.agent]
    }
  }

  // ── Comandi dalla UI ─────────────────────────────────────────────────────

  async handle(command: HostCommand): Promise<unknown> {
    switch (command.type) {
      case 'hello':
        return this.snapshot()
      case 'project.add':
        return this.addProject(command.path)
      case 'project.remove':
        this.db.prepare('delete from projects where id = ?').run(command.projectId)
        this.projects.delete(command.projectId)
        this.broadcast({ type: 'project.removed', projectId: command.projectId })
        return null
      case 'session.create':
        return this.createSession(command)
      case 'session.send':
        await this.send(command.sessionId, command.text)
        return null
      case 'session.queue.set':
        this.updateRow(command.sessionId, { queue: JSON.stringify(command.queue) })
        this.emitSummary(command.sessionId)
        return null
      case 'session.interrupt':
        await this.interrupt(command.sessionId)
        return null
      case 'session.respond':
        this.respond(command.sessionId, command.requestId, command.response)
        return null
      case 'session.permission.set':
        await this.setPermission(command.sessionId, command.permission)
        return null
      case 'session.model.set':
        this.updateRow(command.sessionId, { model: command.model })
        await this.runtimes.get(command.sessionId)?.adapter.setModel(command.model)
        this.emitSummary(command.sessionId)
        return null
      case 'session.open':
        this.broadcast({ type: 'session.items', sessionId: command.sessionId, items: this.loadItems(command.sessionId), replace: true })
        return null
      case 'session.read': {
        const row = this.rows.get(command.sessionId)
        if (row && row.last_read_seq < row.last_seq) {
          this.updateRow(row.id, { last_read_seq: row.last_seq })
          this.emitSummary(row.id)
        }
        return null
      }
      case 'session.archive':
        this.runtimes.get(command.sessionId)?.adapter.close()
        this.runtimes.delete(command.sessionId)
        this.updateRow(command.sessionId, { archived: 1 })
        this.emitSummary(command.sessionId)
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
        return null
    }
  }

  private async addProject(path: string): Promise<Project> {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('La cartella non esiste.')
    const existing = [...this.projects.values()].find((p) => p.path === path)
    if (existing) return existing
    const row: ProjectRow = { id: randomUUID(), name: basename(path), path, added_at: Date.now() }
    this.db.prepare('insert into projects (id, name, path, added_at) values (?, ?, ?, ?)').run(row.id, row.name, row.path, row.added_at)
    const project = await this.projectFromRow(row)
    this.projects.set(project.id, project)
    this.broadcast({ type: 'project.upsert', project })
    return project
  }

  private async createSession(command: Extract<HostCommand, { type: 'session.create' }>): Promise<SessionSummary> {
    const project = this.projects.get(command.projectId)
    if (!project) throw new Error('Progetto non trovato.')
    const now = Date.now()
    const row: SessionRow = {
      id: randomUUID(),
      project_id: project.id,
      title: titleFrom(command.text),
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
      context: null
    }
    this.db
      .prepare(
        `insert into sessions (id, project_id, title, agent, model, effort, permission, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.project_id, row.title, row.agent, row.model, row.effort, row.permission, now, now)
    this.rows.set(row.id, row)
    this.emitSummary(row.id)
    await this.send(row.id, command.text)
    return this.summary(row.id)
  }

  // ── Turni ────────────────────────────────────────────────────────────────

  private async send(sessionId: string, text: string): Promise<void> {
    const row = this.mustRow(sessionId)
    const runtime = this.runtimes.get(sessionId)
    if (runtime?.adapter.isRunning || row.run_state === 'waiting') {
      const queue = JSON.parse(row.queue) as QueuedMessage[]
      queue.push({ id: randomUUID(), text })
      this.updateRow(sessionId, { queue: JSON.stringify(queue) })
      this.emitSummary(sessionId)
      return
    }
    await this.startTurn(sessionId, text)
  }

  private async startTurn(sessionId: string, text: string): Promise<void> {
    const row = this.mustRow(sessionId)
    const project = this.projects.get(row.project_id)
    if (!project) throw new Error('Progetto non trovato.')
    if (!this.claudeCli) throw new Error(this.agent.error ?? 'Claude Code non disponibile.')

    let runtime = this.runtimes.get(sessionId)
    if (!runtime) {
      const adapter = new ClaudeSession(
        {
          cwd: project.path,
          cli: this.claudeCli,
          model: row.model,
          effort: row.effort as Effort | null,
          permission: row.permission as PermissionLevel,
          resume: row.external_id
        },
        this.adapterEvents(sessionId)
      )
      runtime = { adapter, turnId: null, turnStart: null, turnCounts: emptyCounts(), activity: null, pending: new Map() }
      this.runtimes.set(sessionId, runtime)
      adapter.start()
    }

    const turnId = randomUUID()
    runtime.turnId = turnId
    runtime.turnCounts = emptyCounts()
    runtime.activity = 'Pensa…'
    this.upsertItem(sessionId, { kind: 'user', id: randomUUID(), turnId, at: Date.now(), text })
    this.updateRow(sessionId, { run_state: 'running', title: row.last_seq <= 1 ? titleFrom(text) : row.title })
    this.emitSummary(sessionId)
    this.flush()
    runtime.turnStart = project.isGit
      ? await createCheckpoint(project.path, `refs/ladder/${sessionId}/${turnId}-start`, 'ladder: inizio turno').catch(() => null)
      : null
    runtime.adapter.send(text)
  }

  private adapterEvents(sessionId: string): AdapterEvents {
    return {
      init: ({ externalId, model }) => {
        const row = this.rows.get(sessionId)
        if (!row) return
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
      turnEnd: (result) => void this.onTurnEnd(sessionId, result),
      notice: (tone, text) => {
        const runtime = this.runtimes.get(sessionId)
        this.upsertItem(sessionId, { kind: 'notice', id: randomUUID(), turnId: runtime?.turnId ?? 'system', at: Date.now(), tone, text })
      },
      account: ({ account, models }) => {
        this.agent = { ...this.agent, account: account ?? this.agent.account, models: models.length ? models : this.agent.models }
        this.db
          .prepare(`insert into kv (key, value) values ('agent:claude-code', ?) on conflict(key) do update set value = excluded.value`)
          .run(JSON.stringify({ account: this.agent.account, models: this.agent.models }))
        this.broadcast({ type: 'agent.status', status: this.agent })
      },
      exit: (error) => {
        const runtime = this.runtimes.get(sessionId)
        if (!runtime) return
        for (const [requestId] of runtime.pending) this.expireRequest(sessionId, requestId)
        this.runtimes.delete(sessionId)
        if (error) {
          this.upsertItem(sessionId, { kind: 'notice', id: randomUUID(), turnId: runtime.turnId ?? 'system', at: Date.now(), tone: 'error', text: `Claude Code si è chiuso: ${error}` })
          this.updateRow(sessionId, { run_state: 'error' })
        } else if (this.rows.get(sessionId)?.run_state !== 'idle') {
          this.updateRow(sessionId, { run_state: 'idle' })
        }
        this.emitSummary(sessionId)
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
      endedAt: update.status === 'running' ? null : Date.now()
    })
  }

  private openRequest(sessionId: string, request: UserRequest, signal: AbortSignal): Promise<RequestResponse> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime?.turnId) return Promise.resolve({ optionId: 'deny', message: 'Sessione non attiva.' })
    const requestId = randomUUID()
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
    return new Promise<RequestResponse>((resolve) => {
      runtime.pending.set(requestId, { itemId: requestId, resolve })
      signal.addEventListener('abort', () => this.expireRequest(sessionId, requestId), { once: true })
    })
  }

  private respond(sessionId: string, requestId: string, response: RequestResponse): void {
    const runtime = this.runtimes.get(sessionId)
    const pending = runtime?.pending.get(requestId)
    const item = this.liveItems.get(sessionId)?.get(requestId) ?? this.loadItems(sessionId).find((i) => i.id === requestId)
    if (!pending || !runtime || !item || item.kind !== 'request') {
      throw new Error('Questa richiesta non è più attiva.')
    }
    runtime.pending.delete(requestId)
    this.upsertItem(sessionId, { ...item, state: 'resolved', resolution: describeResponse(item, response) })
    if (runtime.pending.size === 0) this.updateRow(sessionId, { run_state: 'running' })
    this.emitSummary(sessionId)
    pending.resolve(response)
  }

  private expireRequest(sessionId: string, requestId: string): void {
    const runtime = this.runtimes.get(sessionId)
    const pending = runtime?.pending.get(requestId)
    runtime?.pending.delete(requestId)
    const item = this.liveItems.get(sessionId)?.get(requestId)
    if (item?.kind === 'request' && item.state === 'open') this.upsertItem(sessionId, { ...item, state: 'expired', resolution: 'Scaduta' })
    pending?.resolve({ optionId: 'deny', message: 'La richiesta è scaduta.' })
    if (runtime && runtime.pending.size === 0 && this.rows.get(sessionId)?.run_state === 'waiting') {
      this.updateRow(sessionId, { run_state: runtime.adapter.isRunning ? 'running' : 'idle' })
      this.emitSummary(sessionId)
    }
  }

  private async onTurnEnd(sessionId: string, result: TurnResult): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    const row = this.rows.get(sessionId)
    if (!runtime || !row) return
    const turnId = runtime.turnId ?? 'system'
    for (const [requestId] of runtime.pending) this.expireRequest(sessionId, requestId)
    const project = this.projects.get(row.project_id)
    let files: Extract<ChatItem, { kind: 'turn-end' }>['files'] = []
    if (project?.isGit && runtime.turnStart) {
      const end = await createCheckpoint(project.path, `refs/ladder/${sessionId}/${turnId}-end`, 'ladder: fine turno').catch(() => null)
      if (end) files = await changedFiles(project.path, runtime.turnStart, end).catch(() => [])
    }
    // Chiude eventuali messaggi rimasti in streaming (per esempio dopo un'interruzione).
    for (const item of this.liveItems.get(sessionId)?.values() ?? []) {
      if (item.kind === 'assistant' && item.streaming && item.turnId === turnId) this.upsertItem(sessionId, { ...item, streaming: false })
      if (item.kind === 'tool' && item.status === 'running' && item.turnId === turnId)
        this.upsertItem(sessionId, { ...item, status: result.status === 'completed' ? 'done' : 'error', endedAt: Date.now() })
    }
    const end = this.upsertItem(sessionId, {
      kind: 'turn-end',
      id: `${turnId}:end`,
      turnId,
      at: Date.now(),
      status: result.status,
      durationMs: result.durationMs,
      counts: runtime.turnCounts,
      files,
      error: result.error,
      costUsd: result.costUsd
    })
    runtime.turnId = null
    runtime.activity = null
    this.updateRow(sessionId, {
      run_state: result.status === 'error' ? 'error' : 'idle',
      last_activity_seq: end.seq,
      context: result.context ? JSON.stringify(result.context) : row.context
    })
    this.flush()
    this.emitSummary(sessionId)

    const queue = JSON.parse(this.mustRow(sessionId).queue) as QueuedMessage[]
    const next = queue.shift()
    if (next && result.status !== 'error') {
      this.updateRow(sessionId, { queue: JSON.stringify(queue) })
      await this.startTurn(sessionId, next.text)
    }
  }

  private async interrupt(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    for (const [requestId] of runtime.pending) this.expireRequest(sessionId, requestId)
    await runtime.adapter.interrupt()
  }

  private async setPermission(sessionId: string, permission: PermissionLevel): Promise<void> {
    this.updateRow(sessionId, { permission })
    await this.runtimes.get(sessionId)?.adapter.setPermission(permission)
    this.emitSummary(sessionId)
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
    const keys = Object.keys(patch).concat('updated_at')
    const sql = `update sessions set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`
    this.db.prepare(sql).run(...keys.map((k) => (row as unknown as Record<string, string | number | null>)[k]), sessionId)
  }

  private mustRow(sessionId: string): SessionRow {
    const row = this.rows.get(sessionId)
    if (!row) throw new Error('Sessione non trovata.')
    return row
  }

  private summary(sessionId: string): SessionSummary {
    const row = this.mustRow(sessionId)
    const runtime = this.runtimes.get(sessionId)
    const run = row.run_state as RunState
    let waitingLabel: string | null = null
    if (run === 'waiting' && runtime) {
      const items = this.liveItems.get(sessionId)
      const open = [...(items?.values() ?? [])].find((i) => i.kind === 'request' && i.state === 'open')
      waitingLabel = open?.kind === 'request' && open.requestType === 'question' ? 'Domanda' : 'Approvazione'
    }
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      agent: row.agent as SessionSummary['agent'],
      model: row.model,
      effort: row.effort as SessionSummary['effort'],
      permission: row.permission as PermissionLevel,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      run,
      waitingLabel,
      activity: runtime?.activity ?? null,
      unread: row.last_activity_seq > row.last_read_seq,
      lastReadSeq: row.last_read_seq,
      archived: row.archived === 1,
      queue: JSON.parse(row.queue) as QueuedMessage[],
      context: row.context ? (JSON.parse(row.context) as SessionSummary['context']) : null
    }
  }

  private emitSummary(sessionId: string): void {
    if (this.rows.has(sessionId)) this.broadcast({ type: 'session.upsert', session: this.summary(sessionId) })
  }

  shutdown(): void {
    this.flush()
    for (const runtime of this.runtimes.values()) runtime.adapter.close()
  }
}

function emptyCounts() {
  return { commands: 0, edits: 0, reads: 0, searches: 0 }
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || 'Nuova sessione'
}

function describeResponse(item: Extract<ChatItem, { kind: 'request' }>, response: RequestResponse): string {
  if ('answers' in response) return Object.values(response.answers).join(', ')
  const option = item.options.find((o) => o.id === response.optionId)
  if (option?.kind === 'deny') return response.message ? `Rifiutato: ${response.message}` : 'Rifiutato'
  return option?.kind === 'allow-always' ? 'Consentito sempre' : 'Approvato'
}
