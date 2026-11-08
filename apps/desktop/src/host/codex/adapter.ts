// Adapter Codex su `codex app-server` (JSON-RPC su stdio), con le regole dello spike S1:
// effort e livello di servizio espliciti a ogni turno, piano attivato su thread/start, item lasciati aperti
// chiusi a fine turno, delta di turni vecchi scartati, processo riavviato se un comando sopravvive all'interruzione.
import { realpathSync } from 'node:fs'
import { relative } from 'node:path'
import { t } from '@shared/i18n'
import type { Attachment, PermissionLevel, Question, RequestOption, RequestResponse } from '@shared/protocol'
import { agentEnv, clip, displayCommand, firstLine, type AdapterEvents, type AgentSession, type SessionOptions, type UserRequest } from '../agents/common'
import { accountLabel, CODEX_STRIP_ENV, describeLimits, parseModels, type CodexModel } from './environment'
import { CodexRpc, type ServerReply, type ServerRequest } from './rpc'

export interface CodexOptions extends SessionOptions {
  cli: string
  version: string
  /** Schema JSON della risposta finale (per la review: commenti strutturati). */
  outputSchema?: unknown
}

type Policy = { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> }

/** Livelli di Ladder → policy di approvazione e sandbox di Codex. */
function policyFor(level: PermissionLevel, cwd: string): Policy {
  const workspace = { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  switch (level) {
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
    case 'ask':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write', sandboxPolicy: workspace }
    case 'full':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: workspace }
  }
}

interface OpenItem {
  kind: 'command' | 'edit' | 'mcp' | 'web' | 'agent' | 'other'
  title: string
  detail: string | null
  output: string
  diff: string | null
  paths: string[]
}

/** Opzioni delle approvazioni: etichette nella lingua attuale, quindi calcolate a ogni richiesta. */
function approveOptions(): RequestOption[] {
  return [
    { id: 'accept', label: t('Approve'), kind: 'allow' },
    { id: 'acceptForSession', label: t('Allow for this session'), kind: 'allow-always' },
    { id: 'decline', label: t('Deny'), kind: 'deny' }
  ]
}

export class CodexSession implements AgentSession {
  private rpc: CodexRpc | null = null
  private ready: Promise<void> | null = null
  private threadId: string | null
  /** Thread dei sotto-agenti avviati con spawnAgent: i loro eventi vanno alla mappa, non alla chat. */
  private subThreads = new Set<string>()
  private subToolUses = new Map<string, number>()
  private turnId: string | null = null
  private running = false
  private interrupted = false
  private turnStartedAt = 0
  private permission: PermissionLevel
  private model: string | null
  private models: CodexModel[] = []
  private texts = new Map<string, string>()
  private items = new Map<string, OpenItem>()
  private context: { used: number; window: number } | null = null
  /** Richieste del server aperte: si chiudono quando Codex le risolve da sé (fine turno). */
  private requests = new Map<string, AbortController>()
  private closed = false
  private readonly cwd: string

  constructor(
    private readonly options: CodexOptions,
    private readonly events: AdapterEvents
  ) {
    this.threadId = options.resume
    this.permission = options.permission
    this.model = options.model
    // Su macOS /var diventa /private/var: Codex confronta i percorsi esatti.
    let cwd = options.cwd
    try {
      cwd = realpathSync(options.cwd)
    } catch {
      // La cartella può non esistere più: l'errore arriva da Codex.
    }
    this.cwd = cwd
  }

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    this.ready = this.boot()
    this.ready.catch((error: Error) => this.events.notice('error', t('{agent} failed to start: {message}', { agent: 'Codex', message: error.message })))
  }

  private async boot(): Promise<void> {
    const rpc = new CodexRpc(
      this.options.cli,
      await agentEnv(CODEX_STRIP_ENV),
      (method, params) => this.onNotification(method, params),
      (request) => this.onRequest(request)
    )
    this.rpc = rpc
    void rpc.exited.then(({ code, signal }) => {
      if (this.rpc !== rpc) return
      this.rpc = null
      this.ready = null
      if (this.closed) return
      const crashed = code !== 0 && signal !== 'SIGTERM'
      if (this.running) this.finishTurn({ status: 'error', error: rpc.stderr.length ? t('{agent} exited: {error}', { agent: 'Codex', error: rpc.stderr.at(-1) ?? '' }) : t('{agent} exited', { agent: 'Codex' }) })
      if (crashed) this.events.notice('error', t('Codex exited ({reason}). The next message restarts it and resumes the conversation.', { reason: String(signal ?? code) }))
    })
    await rpc.initialize(this.options.version)
    void this.loadAccount(rpc)
    const policy = policyFor(this.permission, this.cwd)
    const common = {
      cwd: this.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(this.model ? { model: this.model } : {}),
      config: { 'tools.update_plan.enabled': true }
    }
    const result = this.threadId
      ? await rpc.request<{ thread: { id: string }; model: string }>('thread/resume', { threadId: this.threadId, excludeTurns: true, ...common })
      : await rpc.request<{ thread: { id: string }; model: string }>('thread/start', common)
    this.threadId = result.thread.id
    this.events.init({ externalId: result.thread.id, model: this.model ?? result.model ?? null })
  }

  private async loadAccount(rpc: CodexRpc): Promise<void> {
    try {
      const account = await rpc.request<{ account: Record<string, unknown> | null }>('account/read', { refreshToken: false }, 15000)
      this.models = parseModels(await rpc.request('model/list', {}, 15000))
      let limits: string | null = null
      try {
        limits = describeLimits(await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }, 15000))
      } catch {
        limits = null
      }
      this.events.account({ account: accountLabel(account.account), models: this.models.map((m) => ({ id: m.id, label: m.label })), limits })
    } catch {
      // Senza account e modelli la sessione funziona comunque.
    }
  }

  send(text: string, attachments: Attachment[] = []): void {
    this.running = true
    this.interrupted = false
    this.turnStartedAt = Date.now()
    this.turnId = null
    this.events.activity(t('Thinking…'))
    void (async () => {
      try {
        if (!this.ready) this.start()
        await this.ready
        const policy = policyFor(this.permission, this.cwd)
        const effort = this.effortFor()
        const result = await this.rpc!.request<{ turn: { id: string } }>('turn/start', {
          threadId: this.threadId,
          input: [
            ...attachments.map((a) => ({ type: 'image', url: `data:${a.mediaType};base64,${a.data}` })),
            { type: 'text', text, text_elements: [] }
          ],
          approvalPolicy: policy.approvalPolicy,
          sandboxPolicy: policy.sandboxPolicy,
          ...(this.model ? { model: this.model } : {}),
          ...(effort ? { effort } : {}),
          // Il livello "priority" consuma il doppio della quota: mai ereditarlo dalla configurazione.
          serviceTierForTurn: 'default',
          ...(this.options.outputSchema ? { outputSchema: this.options.outputSchema } : {})
        })
        this.turnId ??= result.turn.id
      } catch (error) {
        this.finishTurn({ status: 'error', error: (error as Error).message })
      }
    })()
  }

  /** L'effort di Ladder vale solo se il modello lo supporta; altrimenti decide Codex. */
  private effortFor(): string | null {
    const effort = this.options.effort
    if (!effort) return null
    const model = this.models.find((m) => m.id === this.model) ?? this.models.find((m) => m.isDefault)
    if (!model || model.efforts.length === 0) return effort
    return model.efforts.includes(effort) ? effort : null
  }

  async interrupt(): Promise<void> {
    this.interrupted = true
    if (!this.rpc || !this.threadId || !this.turnId) {
      if (this.running) this.finishTurn({ status: 'interrupted', error: null })
      return
    }
    try {
      await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 10000)
    } catch {
      if (this.running) this.finishTurn({ status: 'interrupted', error: null })
    }
  }

  async setPermission(level: PermissionLevel): Promise<void> {
    // Vale dal prossimo turno: Codex accetta policy e sandbox in turn/start.
    this.permission = level
  }

  async setModel(model: string): Promise<void> {
    this.model = model
  }

  close(): void {
    this.closed = true
    for (const controller of this.requests.values()) controller.abort()
    this.requests.clear()
    this.rpc?.kill()
    this.rpc = null
  }

  // ── Eventi da Codex ──────────────────────────────────────────────────────

  private isCurrent(params: Record<string, unknown>): boolean {
    // Dopo un'interruzione un comando rimasto vivo continua a mandare output con il turno vecchio.
    return !params.turnId || !this.turnId || params.turnId === this.turnId
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    // Eventi di un altro thread (un sotto-agente): non toccano il turno della sessione.
    const thread = typeof params.threadId === 'string' ? params.threadId : null
    if (thread && this.threadId && thread !== this.threadId && method !== 'serverRequest/resolved') {
      if (this.subThreads.has(thread)) this.onSubagentNotification(thread, method, params)
      return
    }
    switch (method) {
      case 'turn/started':
        this.turnId = ((params.turn as { id?: string }) ?? {}).id ?? this.turnId
        return
      case 'item/started':
        if (this.isCurrent(params)) this.itemStarted(params.item as Record<string, unknown>)
        return
      case 'item/completed':
        if (this.isCurrent(params)) this.itemCompleted(params.item as Record<string, unknown>)
        return
      case 'item/agentMessage/delta': {
        if (!this.isCurrent(params)) return
        const id = String(params.itemId)
        const text = (this.texts.get(id) ?? '') + String(params.delta ?? '')
        this.texts.set(id, text)
        this.events.assistant(id, text, true)
        return
      }
      case 'item/commandExecution/outputDelta': {
        if (!this.isCurrent(params)) return
        const item = this.items.get(String(params.itemId))
        if (!item) return
        item.output += String(params.delta ?? '')
        this.events.tool({ id: String(params.itemId), tool: 'command', name: 'Shell', title: item.title, detail: item.detail, status: 'running', output: clip(item.output) })
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.events.activity(t('Reasoning…'))
        return
      case 'thread/tokenUsage/updated': {
        const usage = params.tokenUsage as { last?: { inputTokens?: number; outputTokens?: number }; modelContextWindow?: number | null } | undefined
        if (usage?.last && usage.modelContextWindow) this.context = { used: (usage.last.inputTokens ?? 0) + (usage.last.outputTokens ?? 0), window: usage.modelContextWindow }
        return
      }
      case 'serverRequest/resolved': {
        // Codex ha chiuso una richiesta da sé (per esempio a fine turno): la card diventa "scaduta".
        const key = String(params.requestId ?? '')
        this.requests.get(key)?.abort()
        this.requests.delete(key)
        return
      }
      case 'error': {
        const error = params.error as { message?: string } | undefined
        if (params.willRetry) this.events.activity(t('Retrying…'))
        else if (error?.message) this.events.notice('error', `Codex: ${error.message}`)
        return
      }
      case 'turn/completed': {
        const turn = (params.turn ?? {}) as { id?: string; status?: string; error?: { message?: string } | null; durationMs?: number | null }
        if (this.turnId && turn.id && turn.id !== this.turnId) return
        const status = turn.status === 'failed' ? 'error' : turn.status === 'interrupted' || this.interrupted ? 'interrupted' : 'completed'
        this.finishTurn({ status, error: turn.error?.message ?? null, durationMs: turn.durationMs ?? undefined })
        // Un comando vivo dopo l'interruzione: si riavvia il processo, il thread si riprende al prossimo messaggio.
        if (status === 'interrupted' && [...this.items.values()].some((i) => i.kind === 'command')) this.restart()
        return
      }
      case 'account/rateLimits/updated':
      default:
        return
    }
  }

  private rel(path: string): string {
    const r = relative(this.cwd, path)
    return r && !r.startsWith('..') ? r : path
  }

  private itemStarted(item: Record<string, unknown>): void {
    const id = String(item.id)
    switch (item.type) {
      case 'agentMessage':
        this.texts.set(id, '')
        return
      case 'commandExecution': {
        const command = displayCommand(String(item.command ?? '')) ?? ''
        const open: OpenItem = { kind: 'command', title: t('Runs {command}', { command: firstLine(command) }), detail: command, output: String(item.aggregatedOutput ?? ''), diff: null, paths: [] }
        this.items.set(id, open)
        this.events.activity(open.title)
        this.events.tool({ id, tool: 'command', name: 'Shell', title: open.title, detail: command, status: 'running', output: null })
        return
      }
      case 'fileChange': {
        const changes = (item.changes ?? []) as { path: string; diff: string }[]
        const paths = changes.map((c) => this.rel(c.path))
        const open: OpenItem = {
          kind: 'edit',
          title: paths.length === 1 ? t('Edits {file}', { file: paths[0] }) : t('Edits {n} files', { n: paths.length }),
          detail: paths.join(', '),
          output: '',
          diff: changes.map((c) => c.diff).join('\n'),
          paths
        }
        this.items.set(id, open)
        this.events.activity(open.title)
        this.events.tool({ id, tool: 'edit', name: 'apply_patch', title: open.title, detail: open.detail, status: 'running', output: null })
        return
      }
      case 'mcpToolCall': {
        const name = `${item.server}.${item.tool}`
        const title = t('Uses {tool}', { tool: name })
        this.items.set(id, { kind: 'mcp', title, detail: null, output: '', diff: null, paths: [] })
        this.events.tool({ id, tool: 'other', name, title, detail: null, status: 'running', output: null })
        return
      }
      case 'webSearch': {
        const query = String(item.query ?? '')
        const title = t('Searches the web for {query}', { query: firstLine(query) })
        this.items.set(id, { kind: 'web', title, detail: query, output: '', diff: null, paths: [] })
        this.events.tool({ id, tool: 'web', name: 'web_search', title, detail: query, status: 'running', output: null })
        return
      }
      case 'reasoning':
        this.events.activity(t('Reasoning…'))
        return
      case 'collabAgentToolCall':
        this.collabCall(item, true)
        return
      case 'subAgentActivity':
        this.subAgentActivity(item)
        return
      default:
        return
    }
  }

  /** spawnAgent, wait, closeAgent…: i nuovi sotto-agenti entrano nella mappa, gli stati noti la aggiornano. */
  private collabCall(item: Record<string, unknown>, started: boolean): void {
    const id = String(item.id)
    const tool = String(item.tool ?? '')
    const receivers = Array.isArray(item.receiverThreadIds) ? (item.receiverThreadIds as unknown[]).map(String) : []
    const sender = typeof item.senderThreadId === 'string' ? item.senderThreadId : null
    const parentId = sender && this.subThreads.has(sender) ? sender : null
    const prompt = typeof item.prompt === 'string' ? item.prompt : null
    if (tool === 'spawnAgent') {
      for (const thread of receivers) {
        this.subThreads.add(thread)
        this.events.subagent({
          id: thread,
          parentId,
          ...(prompt ? { title: firstLine(prompt, 80) } : {}),
          ...(typeof item.model === 'string' ? { model: item.model } : {}),
          status: 'running'
        })
      }
      if (started && !parentId) {
        const title = t('Subagent: {task}', { task: firstLine(prompt ?? t('task'), 60) })
        this.items.set(id, { kind: 'agent', title, detail: prompt, output: '', diff: null, paths: [] })
        this.events.tool({ id, tool: 'agent', name: 'spawn_agent', title, detail: prompt, status: 'running', output: null })
      }
    }
    const states = (item.agentsStates ?? {}) as Record<string, { status?: string } | undefined>
    for (const [thread, state] of Object.entries(states)) {
      const status = collabStatus(state?.status)
      if (status && this.subThreads.has(thread)) this.events.subagent({ id: thread, status })
    }
  }

  private subAgentActivity(item: Record<string, unknown>): void {
    const thread = typeof item.agentThreadId === 'string' ? item.agentThreadId : null
    if (!thread) return
    this.subThreads.add(thread)
    const path = typeof item.agentPath === 'string' ? item.agentPath.split('/').filter(Boolean).pop() : undefined
    const status = item.kind === 'completed' ? 'done' : item.kind === 'interrupted' ? 'stopped' : item.kind === 'started' ? 'running' : undefined
    this.events.subagent({
      id: thread,
      ...(path ? { kind: path } : {}),
      ...(typeof item.model === 'string' ? { model: item.model } : {}),
      ...(status ? { status } : {})
    })
  }

  private onSubagentNotification(thread: string, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'turn/started':
        this.events.subagent({ id: thread, status: 'running' })
        return
      case 'turn/completed': {
        const status = ((params.turn ?? {}) as { status?: string }).status
        this.events.subagent({ id: thread, status: status === 'failed' ? 'error' : status === 'interrupted' ? 'stopped' : 'done' })
        return
      }
      case 'item/started': {
        const item = (params.item ?? {}) as Record<string, unknown>
        const activity = this.describeItem(item)
        if (!activity) return
        const uses = (this.subToolUses.get(thread) ?? 0) + (item.type === 'reasoning' ? 0 : 1)
        this.subToolUses.set(thread, uses)
        this.events.subagent({ id: thread, activity, toolUses: uses })
        return
      }
      case 'thread/tokenUsage/updated': {
        const total = (params.tokenUsage as { total?: { totalTokens?: number } } | undefined)?.total?.totalTokens
        if (typeof total === 'number') this.events.subagent({ id: thread, tokens: total })
        return
      }
      default:
        return
    }
  }

  /** Riga breve per l'attività di un sotto-agente: come i titoli delle righe della chat. */
  private describeItem(item: Record<string, unknown>): string | null {
    switch (item.type) {
      case 'commandExecution':
        return t('Runs {command}', { command: firstLine(displayCommand(String(item.command ?? '')) ?? '') })
      case 'fileChange': {
        const paths = ((item.changes ?? []) as { path: string }[]).map((c) => this.rel(c.path))
        return paths.length === 1 ? t('Edits {file}', { file: paths[0] }) : t('Edits {n} files', { n: paths.length })
      }
      case 'mcpToolCall':
        return t('Uses {tool}', { tool: `${item.server}.${item.tool}` })
      case 'webSearch':
        return t('Searches the web for {query}', { query: firstLine(String(item.query ?? '')) })
      case 'reasoning':
        return t('Reasoning…')
      default:
        return null
    }
  }

  private itemCompleted(item: Record<string, unknown>): void {
    const id = String(item.id)
    if (item.type === 'collabAgentToolCall') this.collabCall(item, false)
    else if (item.type === 'subAgentActivity') return this.subAgentActivity(item)
    if (item.type === 'agentMessage') {
      const text = String(item.text ?? this.texts.get(id) ?? '')
      this.texts.delete(id)
      this.events.assistant(id, text, false)
      return
    }
    const open = this.items.get(id)
    if (!open) return
    this.items.delete(id)
    const raw = String(item.status ?? 'completed')
    const status = raw === 'declined' ? 'denied' : raw === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0) ? 'error' : 'done'
    const output = open.kind === 'command' ? clip(String(item.aggregatedOutput ?? open.output)) : null
    const tool = open.kind === 'command' ? 'command' : open.kind === 'edit' ? 'edit' : open.kind === 'web' ? 'web' : open.kind === 'agent' ? 'agent' : 'other'
    this.events.tool({ id, tool, name: open.kind === 'command' ? 'Shell' : open.kind === 'edit' ? 'apply_patch' : open.kind === 'agent' ? 'spawn_agent' : open.title, title: open.title, detail: open.detail, status, output })
    this.events.activity(t('Thinking…'))
  }

  private finishTurn(result: { status: 'completed' | 'interrupted' | 'error'; error: string | null; durationMs?: number }): void {
    if (!this.running) return
    this.running = false
    for (const controller of this.requests.values()) controller.abort()
    this.requests.clear()
    // I messaggi rimasti senza item/completed (steer, interruzione) si chiudono con il testo arrivato.
    for (const [id, text] of this.texts) this.events.assistant(id, text, false)
    this.texts.clear()
    this.events.activity(null)
    this.events.turnEnd({
      status: result.status,
      durationMs: result.durationMs ?? Date.now() - this.turnStartedAt,
      costUsd: null,
      error: result.status === 'error' ? (result.error ?? t('The Codex turn failed.')) : null,
      context: this.context
    })
  }

  private restart(): void {
    const rpc = this.rpc
    this.rpc = null
    this.ready = null
    this.items.clear()
    rpc?.kill()
  }

  // ── Richieste di Codex: approvazioni e domande ───────────────────────────

  private async onRequest(request: ServerRequest): Promise<ServerReply> {
    const params = request.params
    const controller = new AbortController()
    const key = String(request.id)
    this.requests.set(key, controller)
    try {
      switch (request.method) {
        case 'item/commandExecution/requestApproval': {
          const command = displayCommand(String(params.command ?? '')) ?? this.items.get(String(params.itemId))?.detail ?? ''
          const response = await this.events.request(
            {
              requestType: 'permission',
              toolName: 'Shell',
              title: t('Runs {command}', { command: firstLine(command) }),
              command,
              path: null,
              reason: (params.reason as string | null) ?? null,
              options: approveOptions(),
              questions: null
            },
            controller.signal
          )
          return { result: { decision: this.decision(response) } }
        }
        case 'item/fileChange/requestApproval': {
          const open = this.items.get(String(params.itemId))
          const preview = open?.diff ? diffPreview(open.diff) : null
          const response = await this.events.request(
            {
              requestType: 'permission',
              toolName: 'apply_patch',
              title: open?.title ?? t('File edits'),
              command: null,
              path: open?.paths[0] ?? null,
              reason: (params.reason as string | null) ?? null,
              options: approveOptions(),
              questions: null,
              preview
            },
            controller.signal
          )
          return { result: { decision: this.decision(response) } }
        }
        case 'item/tool/requestUserInput': {
          const raw = (params.questions ?? []) as { id: string; header: string; question: string; options: { label: string; description?: string }[] | null }[]
          const questions: Question[] = raw.map((q) => ({
            question: q.question,
            header: q.header || null,
            multiSelect: false,
            options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? null }))
          }))
          const response = await this.events.request(
            { requestType: 'question', toolName: 'request_user_input', title: questions[0]?.question ?? t('Question'), command: null, path: null, reason: null, options: [], questions },
            controller.signal
          )
          const answers: Record<string, { answers: string[] }> = {}
          if ('answers' in response) for (const q of raw) answers[q.id] = { answers: response.answers[q.question] ? [response.answers[q.question]] : [] }
          return { result: { answers } }
        }
        default:
          return { error: { code: -32601, message: t('Ladder does not handle {method}', { method: request.method }) } }
      }
    } finally {
      this.requests.delete(key)
    }
  }

  /** Decisione per Codex; un rifiuto con messaggio arriva anche come istruzione al turno in corso. */
  private decision(response: RequestResponse): string {
    if (!('optionId' in response)) return 'decline'
    if (response.optionId === 'decline' && response.message && this.rpc && this.threadId && this.turnId) {
      const message = response.message
      setTimeout(() => {
        void this.rpc
          ?.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text: message, text_elements: [] }] }, 10000)
          .catch(() => undefined)
      }, 50)
    }
    return response.optionId === 'accept' || response.optionId === 'acceptForSession' ? response.optionId : 'decline'
  }
}

/** Diff unificato di Codex → righe - e + per la card (come l'anteprima di Claude Code). */
function collabStatus(status: string | undefined): 'running' | 'done' | 'error' | 'stopped' | null {
  switch (status) {
    case 'pendingInit':
    case 'running':
      return 'running'
    case 'completed':
    case 'shutdown':
      return 'done'
    case 'errored':
      return 'error'
    case 'interrupted':
    case 'notFound':
      return 'stopped'
    default:
      return null
  }
}

function diffPreview(diff: string): UserRequest['preview'] {
  const lines = diff
    .split('\n')
    .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
  if (lines.length === 0) return null
  return { text: lines.slice(0, 400).join('\n'), lines: lines.length, truncated: lines.length > 400 }
}
