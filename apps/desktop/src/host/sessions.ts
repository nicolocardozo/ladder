// Cuore dell'host: progetti, sessioni, elementi della chat e collegamento con adapter, terminali e git.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { promisify } from 'node:util'
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
  Attachment,
  RequestResponse,
  RunState,
  SessionSummary,
  TerminalInfo,
  WorktreeInfo
} from '@shared/protocol'
import { tx, type Db, type ProjectRow, type SessionRow } from './db'
import { ClaudeSession, type AdapterEvents, type ToolUpdate, type TurnResult, type UserRequest } from './claude/adapter'
import { claudeVersion, findClaudeCli } from './claude/environment'
import { listTree, readText, RootWatcher } from './files'
import { changedFiles, createCheckpoint, ensureExcluded, listFiles, repoInfo } from './git'
import { loadProjectSettings, PERSONAL_PATTERNS } from './project-settings'
import { TerminalManager, type AgentKind, type AgentSignal, type SpawnOptions } from './terminals'
import { diffFile, diffFiles, historyList, recordCheckpoint, restore } from './workspace'
import { createWorktree, Ports } from './worktrees'

const run = promisify(execFile)

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

/** Stato di una sessione terminale che non sta nel database: etichetta dell'attesa, attività e turno in corso. */
interface TerminalStatus {
  label: string | null
  activity: string | null
  turn: { id: string; start: Promise<string | null> } | null
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
  private readonly terminals: TerminalManager
  private readonly watcher: RootWatcher
  private readonly ports: Ports
  private termStatus = new Map<string, TerminalStatus>()
  /** Sessioni che aspettano lo script di setup del worktree prima di partire. */
  private preparing = new Set<string>()

  constructor(
    private readonly db: Db,
    private readonly broadcast: Broadcast
  ) {
    this.terminals = new TerminalManager(db, {
      upsert: (terminal) => this.broadcast({ type: 'terminal.upsert', terminal }),
      removed: (id) => this.broadcast({ type: 'terminal.removed', id }),
      data: (id, data) => this.broadcast({ type: 'terminal.data', id, data }),
      agent: (terminal, signal) => this.onAgentSignal(terminal, signal)
    })
    this.watcher = new RootWatcher((root) => this.broadcast({ type: 'fs.changed', root }))
    this.ports = new Ports(db)
  }

  // ── Avvio ────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    for (const row of this.db.prepare('select * from projects order by added_at').all() as unknown as ProjectRow[]) {
      this.projects.set(row.id, await this.projectFromRow(row))
    }
    for (const row of this.db.prepare('select * from sessions').all() as unknown as SessionRow[]) this.rows.set(row.id, row)
    // I checkout principali prendono i primi blocchi di porte (4100, …), prima di qualunque worktree.
    for (const project of this.projects.values()) this.ports.allocate(project.path)
    this.recoverInterrupted()
    await this.terminals.init()
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
      agents: [this.agent],
      terminals: this.terminals.list()
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
        for (const terminal of this.terminals.list()) if (terminal.projectId === command.projectId) this.terminals.close(terminal.id)
        this.broadcast({ type: 'project.removed', projectId: command.projectId })
        return null
      case 'session.create':
        return this.createSession(command)
      case 'session.resume':
        return this.resumeTerminalSession(command.sessionId)
      case 'session.send':
        await this.send(command.sessionId, command.text, command.attachments ?? [])
        return null
      case 'session.rename': {
        const title = command.title.trim()
        if (title) {
          this.updateRow(command.sessionId, { title })
          this.emitSummary(command.sessionId)
        }
        return null
      }
      case 'session.unread': {
        const row = this.mustRow(command.sessionId)
        this.updateRow(row.id, { last_read_seq: Math.max(0, row.last_activity_seq - 1) })
        this.emitSummary(row.id)
        return null
      }
      case 'project.files': {
        const project = this.projects.get(command.projectId)
        if (!project) throw new Error('Progetto non trovato.')
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
        return null

      // File, diff e cronologia.
      case 'fs.tree':
        return listTree(this.knownRoot(command.root))
      case 'fs.read':
        return readText(this.knownRoot(command.root), command.path)
      case 'fs.watch':
        if (command.on) this.watcher.watch(this.knownRoot(command.root))
        else this.watcher.unwatch(command.root)
        return null
      case 'diff.files':
        return diffFiles(this.db, this.knownRoot(command.root), command.scope)
      case 'diff.file':
        return diffFile(this.knownRoot(command.root), command.from, command.to, command.path, command.oldPath ?? null)
      case 'git.restore': {
        const root = this.knownRoot(command.root)
        const busy = this.busySession(root)
        if (busy) throw new Error(`“${busy.title}” sta lavorando in questa cartella: fermala prima di ripristinare.`)
        const sessionId = [...this.rows.values()].find((r) => this.cwdOf(r) === root && !r.archived)?.id ?? null
        const result = await restore(this.db, root, command.to, command.paths, command.label, sessionId)
        this.broadcast({ type: 'fs.changed', root })
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
        if (terminal?.kind === 'agent') throw new Error('Il terminale di una sessione si chiude archiviando la sessione.')
        this.terminals.close(command.id)
        return null
      }
      case 'terminal.restart':
        return this.terminals.restart(command.id)
      case 'terminal.output':
        return this.terminals.output(command.id, command.lines ?? 200)

      // Configurazione del progetto e azioni di avvio.
      case 'project.settings':
        return loadProjectSettings(this.mustProject(command.projectId).path)
      case 'run.start':
        return this.startRun(command.projectId, command.sessionId ?? null, command.name)
    }
  }

  private mustProject(projectId: string): Project {
    const project = this.projects.get(projectId)
    if (!project) throw new Error('Progetto non trovato.')
    return project
  }

  /** Cartella di lavoro della sessione: il worktree se c'è, altrimenti il progetto. */
  private cwdOf(row: SessionRow): string {
    return row.cwd ?? this.projects.get(row.project_id)?.path ?? ''
  }

  /** Solo le cartelle di progetti e sessioni: la UI non può chiedere file da altre parti del disco. */
  private knownRoot(root: string): string {
    const normalized = root.replace(/\/+$/, '')
    for (const project of this.projects.values()) if (project.path === normalized) return normalized
    for (const row of this.rows.values()) if (this.cwdOf(row) === normalized) return normalized
    throw new Error('Cartella sconosciuta a Ladder.')
  }

  /** Una sessione che sta scrivendo in `root`, se c'è. */
  private busySession(root: string): SessionRow | null {
    for (const row of this.rows.values()) {
      if (row.archived || this.cwdOf(row) !== root) continue
      if (this.runtimes.get(row.id)?.adapter.isRunning || row.run_state === 'running' || row.run_state === 'waiting') return row
    }
    return null
  }

  private async addProject(path: string): Promise<Project> {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('La cartella non esiste.')
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
    return project
  }

  private async createSession(command: Extract<HostCommand, { type: 'session.create' }>): Promise<SessionSummary> {
    const project = this.mustProject(command.projectId)
    const mode = command.mode ?? 'chat'
    const now = Date.now()
    const shellCommand = mode === 'terminal' ? (command.command?.trim() || 'claude') : null
    const title = mode === 'terminal' && !command.text.trim() ? shellCommand! : titleFrom(command.text)

    // Worktree: cartella e branch nuovi, file da copiare, poi lo script di setup prima di partire.
    let worktree: WorktreeInfo | null = null
    const settings = await loadProjectSettings(project.path)
    const notices: string[] = []
    if (command.worktree) {
      if (!project.isGit) throw new Error('Il worktree richiede un repository git.')
      const created = await createWorktree(project, title, settings.worktree.copy)
      worktree = created.info
      void ensureExcluded(project.path, PERSONAL_PATTERNS).catch(() => undefined)
      if (created.missing.length) notices.push(`File da copiare che non ho trovato nel progetto: ${created.missing.join(', ')}.`)
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
      agent_ref: null
    }
    this.db
      .prepare(
        `insert into sessions (id, project_id, title, agent, model, effort, permission, created_at, updated_at, mode, command, cwd, worktree)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.project_id, row.title, row.agent, row.model, row.effort, row.permission, now, now, mode, shellCommand, row.cwd, row.worktree)
    this.rows.set(row.id, row)
    for (const text of notices) this.upsertItem(row.id, { kind: 'notice', id: randomUUID(), turnId: 'system', at: now, tone: 'info', text })

    const begin = async () => {
      if (mode === 'terminal') this.startTerminalAgent(row.id, command.text.trim() || null)
      else await this.send(row.id, command.text, command.attachments ?? [])
    }

    if (worktree && settings.worktree.setup) {
      // Il primo messaggio aspetta in coda che il setup finisca; nel frattempo la sessione è "in corso".
      this.preparing.add(row.id)
      if (mode === 'chat') {
        const queued: QueuedMessage = { id: randomUUID(), text: command.text, ...(command.attachments?.length ? { attachments: command.attachments } : {}) }
        this.updateRow(row.id, { queue: JSON.stringify([queued]) })
      }
      this.updateRow(row.id, { run_state: 'running' })
      this.termStatus.set(row.id, { label: null, activity: 'Prepara il worktree…', turn: null })
      this.emitSummary(row.id)
      void this.runSetup(row.id, project, worktree.path, settings.worktree.setup).then(async (code) => {
        this.preparing.delete(row.id)
        this.termStatus.delete(row.id)
        this.updateRow(row.id, { run_state: 'idle' })
        if (code !== 0) {
          this.upsertItem(row.id, {
            kind: 'notice',
            id: randomUUID(),
            turnId: 'system',
            at: Date.now(),
            tone: 'error',
            text: `Lo script di setup del worktree è uscito ${code === null ? 'senza codice' : `con codice ${code}`}: guarda il terminale “setup”. La sessione parte lo stesso.`
          })
          this.flush()
        }
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
      await begin()
    }
    return this.summary(row.id)
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

  private async archive(sessionId: string): Promise<void> {
    const row = this.mustRow(sessionId)
    this.runtimes.get(sessionId)?.adapter.close()
    this.runtimes.delete(sessionId)
    for (const terminal of this.terminals.bySession(sessionId)) this.terminals.close(terminal.id)
    this.termStatus.delete(sessionId)
    this.updateRow(sessionId, { archived: 1, run_state: 'idle' })
    this.emitSummary(sessionId)
    // Comando di chiusura del worktree (per esempio docker compose down). Il worktree resta: si unisce o si toglie in F3.
    if (row.worktree) {
      const project = this.projects.get(row.project_id)
      const settings = project ? await loadProjectSettings(project.path) : null
      const cwd = this.cwdOf(row)
      if (project && settings?.worktree.archive && existsSync(cwd)) {
        this.terminals.spawn({ projectId: project.id, sessionId: null, kind: 'run', title: 'archivio', cwd, command: settings.worktree.archive, port: this.ports.allocate(cwd) })
      }
    }
  }

  // ── Azioni di avvio ([[run]] in .ladder/settings.toml) ────────────────────

  private async startRun(projectId: string, sessionId: string | null, name: string): Promise<TerminalInfo> {
    const project = this.mustProject(projectId)
    const settings = await loadProjectSettings(project.path)
    const action = settings.run.find((r) => r.name === name)
    if (!action) throw new Error(`Nessuna azione “${name}” in .ladder/settings.toml.`)
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
    } else if (kind === 'codex') {
      options.file = words[0]
      options.args = [...words.slice(1), ...(prompt && !resume ? [prompt] : [])]
      options.agent = { kind }
    } else {
      options.agent = { kind }
    }
    const existing = this.terminals.bySession(sessionId, 'agent')[0]
    const resolved = options.file && !options.file.includes('/') ? null : options.file
    void (async () => {
      // Le app GUI non vedono il PATH della shell: il comando si risolve con la shell di login.
      if (options.file && !resolved) options.file = (await whichCommand(options.file)) ?? options.file
      if (existing) this.terminals.restart(existing.id, options)
      else this.terminals.spawn(options)
      this.updateRow(sessionId, { run_state: kind === 'generic' ? 'running' : 'starting', estimated: kind === 'generic' ? 1 : 0 })
      this.termStatus.set(sessionId, { label: null, activity: null, turn: null })
      this.emitSummary(sessionId)
      // Checkpoint di inizio sessione: è il "prima" del diff della sessione.
      if (!resume) void this.terminalCheckpoint(sessionId, 'session', 'start', 'Avvio della sessione')
    })()
  }

  private resumeTerminalSession(sessionId: string): null {
    const row = this.mustRow(sessionId)
    if (row.mode !== 'terminal') throw new Error('Solo le sessioni terminale si riavviano.')
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
    const sha = await createCheckpoint(root, `refs/ladder/${sessionId}/${turnId}-${kind}`, `ladder: ${kind === 'start' ? 'inizio' : 'fine'} turno`).catch(() => null)
    if (sha) recordCheckpoint(this.db, { session_id: sessionId, turn_id: turnId, kind, sha, root, label, at: Date.now() })
    return sha
  }

  private onAgentSignal(terminal: TerminalInfo, signal: AgentSignal): void {
    const sessionId = terminal.sessionId
    const row = sessionId ? this.rows.get(sessionId) : undefined
    if (!sessionId || !row || row.mode !== 'terminal' || terminal.kind !== 'agent') return
    const status = this.termStatus.get(sessionId) ?? { label: null, activity: null, turn: null }
    this.termStatus.set(sessionId, status)
    switch (signal.type) {
      case 'ready':
        status.label = null
        status.activity = null
        if (row.run_state !== 'idle') this.updateRow(sessionId, { run_state: 'idle', estimated: 0 })
        break
      case 'turn-start': {
        const turnId = randomUUID()
        const label = signal.prompt ? titleFrom(signal.prompt) : 'Messaggio nel terminale'
        status.turn = { id: turnId, start: this.terminalCheckpoint(sessionId, turnId, 'start', label) }
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
        this.updateRow(sessionId, { run_state: 'waiting', estimated: signal.estimated ? 1 : 0 })
        break
      case 'done': {
        status.label = null
        status.activity = null
        // Fine turno: la sessione diventa "da leggere" e il turno ha il suo checkpoint di fine.
        const seq = row.last_seq + 1
        this.updateRow(sessionId, { run_state: 'idle', estimated: signal.estimated ? 1 : 0, last_seq: seq, last_activity_seq: seq })
        const turn = status.turn
        status.turn = null
        if (turn) void turn.start.then((start) => (start ? this.terminalCheckpoint(sessionId, turn.id, 'end', null) : null))
        break
      }
      case 'error':
        status.label = null
        status.activity = signal.message
        this.updateRow(sessionId, { run_state: 'error', estimated: 0 })
        break
      case 'exit':
        status.label = null
        status.activity = null
        status.turn = null
        this.updateRow(sessionId, { run_state: 'idle', estimated: 0 })
        break
    }
    this.emitSummary(sessionId)
  }

  // ── Turni ────────────────────────────────────────────────────────────────

  private async send(sessionId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    const row = this.mustRow(sessionId)
    if (row.mode === 'terminal') throw new Error('Una sessione terminale si usa dal suo terminale.')
    const runtime = this.runtimes.get(sessionId)
    if (runtime?.adapter.isRunning || row.run_state === 'waiting' || this.preparing.has(sessionId)) {
      const queue = JSON.parse(row.queue) as QueuedMessage[]
      queue.push({ id: randomUUID(), text, ...(attachments.length ? { attachments } : {}) })
      this.updateRow(sessionId, { queue: JSON.stringify(queue) })
      this.emitSummary(sessionId)
      return
    }
    await this.startTurn(sessionId, text, attachments)
  }

  private async startTurn(sessionId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    const row = this.mustRow(sessionId)
    const project = this.mustProject(row.project_id)
    if (!this.claudeCli) throw new Error(this.agent.error ?? 'Claude Code non disponibile.')
    const cwd = this.cwdOf(row)

    let runtime = this.runtimes.get(sessionId)
    if (!runtime) {
      const adapter = new ClaudeSession(
        {
          cwd,
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
    this.upsertItem(sessionId, {
      kind: 'user',
      id: randomUUID(),
      turnId,
      at: Date.now(),
      text,
      ...(attachments.length ? { attachments: attachments.map((a) => ({ name: a.name, mediaType: a.mediaType })) } : {})
    })
    this.updateRow(sessionId, { run_state: 'running', title: row.last_seq <= 1 ? titleFrom(text) : row.title })
    this.emitSummary(sessionId)
    this.flush()
    runtime.turnStart = project.isGit
      ? await createCheckpoint(cwd, `refs/ladder/${sessionId}/${turnId}-start`, 'ladder: inizio turno').catch(() => null)
      : null
    if (runtime.turnStart) recordCheckpoint(this.db, { session_id: sessionId, turn_id: turnId, kind: 'start', sha: runtime.turnStart, root: cwd, label: titleFrom(text), at: Date.now() })
    runtime.adapter.send(text, attachments)
  }

  private noticeError(sessionId: string, text: string): void {
    this.upsertItem(sessionId, { kind: 'notice', id: randomUUID(), turnId: 'system', at: Date.now(), tone: 'error', text })
    this.flush()
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
    const cwd = this.cwdOf(row)
    let files: Extract<ChatItem, { kind: 'turn-end' }>['files'] = []
    let checkpoints: { start: string; end: string } | null = null
    if (project?.isGit && runtime.turnStart) {
      const end = await createCheckpoint(cwd, `refs/ladder/${sessionId}/${turnId}-end`, 'ladder: fine turno').catch(() => null)
      if (end) {
        recordCheckpoint(this.db, { session_id: sessionId, turn_id: turnId, kind: 'end', sha: end, root: cwd, label: null, at: Date.now() })
        checkpoints = { start: runtime.turnStart, end }
        files = await changedFiles(cwd, runtime.turnStart, end).catch(() => [])
      }
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
      costUsd: result.costUsd,
      checkpoints
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
    if (files.length > 0) this.broadcast({ type: 'fs.changed', root: cwd })

    const queue = JSON.parse(this.mustRow(sessionId).queue) as QueuedMessage[]
    const next = queue.shift()
    if (next && result.status !== 'error') {
      this.updateRow(sessionId, { queue: JSON.stringify(queue) })
      await this.startTurn(sessionId, next.text, next.attachments ?? [])
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
    const term = this.termStatus.get(sessionId)
    const run = row.run_state as RunState
    let waitingLabel: string | null = null
    if (run === 'waiting' && runtime) {
      const items = this.liveItems.get(sessionId)
      const open = [...(items?.values() ?? [])].find((i) => i.kind === 'request' && i.state === 'open')
      waitingLabel = open?.kind === 'request' && open.requestType === 'question' ? 'Domanda' : 'Approvazione'
    } else if (run === 'waiting') {
      waitingLabel = term?.label ?? 'Richiede te'
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
      estimated: row.estimated === 1
    }
  }

  private emitSummary(sessionId: string): void {
    if (this.rows.has(sessionId)) this.broadcast({ type: 'session.upsert', session: this.summary(sessionId) })
  }

  shutdown(): void {
    this.flush()
    for (const runtime of this.runtimes.values()) runtime.adapter.close()
    this.terminals.shutdown()
    this.watcher.close()
  }
}

function emptyCounts() {
  return { commands: 0, edits: 0, reads: 0, searches: 0 }
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || 'Nuova sessione'
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

/** Percorso di un comando secondo la shell di login. */
async function whichCommand(name: string): Promise<string | null> {
  try {
    const { stdout } = await run(process.env.SHELL || '/bin/zsh', ['-lc', `command -v -- ${JSON.stringify(name)}`], { timeout: 5000 })
    const path = stdout.trim().split('\n').pop() ?? ''
    return path.startsWith('/') ? path : null
  } catch {
    return null
  }
}

function describeResponse(item: Extract<ChatItem, { kind: 'request' }>, response: RequestResponse): string {
  if ('answers' in response) return Object.values(response.answers).join(', ')
  const option = item.options.find((o) => o.id === response.optionId)
  if (option?.kind === 'deny') return response.message ? `Rifiutato: ${response.message}` : 'Rifiutato'
  return option?.kind === 'allow-always' ? 'Consentito sempre' : 'Approvato'
}
