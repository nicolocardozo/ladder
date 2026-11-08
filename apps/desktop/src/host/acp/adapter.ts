// Adapter ACP generico (Agent Client Protocol, SDK 2.4.0, protocollo v1): un agente è solo una voce
// di configurazione (comando, argomenti, ambiente). Regole dello spike S5: opzioni riapplicate dopo la ripresa,
// tool call aperte chiuse a fine turno, nomi delle opzioni di permesso presi dall'agente, diff calcolato da git.
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { t } from '@shared/i18n'
import type { AcpAgentSpec, Attachment, Effort, PermissionLevel, RequestOption } from '@shared/protocol'
import { agentEnv, clip, displayCommand, firstLine, whichInShell, type AdapterEvents, type AgentSession, type SessionOptions, type UserRequest } from '../agents/common'

/** Chiavi API tolte sempre: vale il login dell'agente. */
const STRIP_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']

export interface AcpOptions extends SessionOptions {
  spec: AcpAgentSpec
}

type ConfigOption = acp.SessionConfigOption
type SelectValue = { value: string; name: string; description?: string | null }

function flatten(option: ConfigOption): SelectValue[] {
  if (option.type !== 'select') return []
  const out: SelectValue[] = []
  for (const entry of option.options as Array<SelectValue | { options: SelectValue[] }>) {
    if ('options' in entry) out.push(...entry.options)
    else out.push(entry)
  }
  return out
}

/** Modalità dell'agente più vicina al livello di Ladder: i nomi cambiano da agente ad agente. */
const MODE_PATTERNS: Record<PermissionLevel, RegExp[]> = {
  plan: [/plan/i, /read[-_ ]?only/i],
  ask: [/^default$/i, /ask|untrusted|manual/i, /read[-_ ]?only/i],
  edit: [/accept[-_ ]?edits|edit/i, /workspace[-_ ]?write/i, /^auto$|^agent$/i],
  full: [/bypass|full[-_ ]?access|yolo|dangerous/i]
}

export class AcpSession implements AgentSession {
  private child: ChildProcess | null = null
  private connection: acp.ClientConnection | null = null
  private ready: Promise<void> | null = null
  private sessionId: string | null
  private config: ConfigOption[] = []
  private running = false
  private turnStartedAt = 0
  private permission: PermissionLevel
  private model: string | null
  private effort: Effort | null
  private context: { used: number; window: number } | null = null
  /** Messaggio o ragionamento aperto: ACP non ha un evento di fine messaggio. */
  private open: { kind: 'message' | 'thought'; id: string; text: string } | null = null
  private counter = 0
  private tools = new Map<string, { title: string; kind: string; detail: string | null; output: string; status: string }>()
  private diffs = new Map<string, { path: string; oldText: string | null; newText: string }>()
  private pending = new Map<string, AbortController>()
  private closed = false

  constructor(
    private readonly options: AcpOptions,
    private readonly events: AdapterEvents
  ) {
    this.sessionId = options.resume
    this.permission = options.permission
    this.model = options.model
    this.effort = options.effort
  }

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    this.ready = this.boot()
    this.ready.catch((error: Error) => this.events.notice('error', t('{agent} failed to start: {message}', { agent: this.options.spec.name, message: error.message })))
  }

  private async boot(): Promise<void> {
    const { spec } = this.options
    const command = await whichInShell(spec.command)
    if (!command) throw new Error(t('command “{command}” not found', { command: spec.command }))
    const env = await agentEnv(STRIP_ENV, spec.env ?? {})
    const child = spawn(command, spec.args, { cwd: this.options.cwd, stdio: ['pipe', 'pipe', 'pipe'], env })
    this.child = child
    const stderr: string[] = []
    child.stderr?.on('data', (d: Buffer) => {
      stderr.push(...d.toString('utf8').split('\n').filter(Boolean))
      if (stderr.length > 30) stderr.splice(0, stderr.length - 30)
    })
    child.on('error', () => undefined)
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.connection = null
      this.ready = null
      if (this.closed) return
      if (this.running) this.finishTurn('error', stderr.length ? t('{agent} exited: {error}', { agent: spec.name, error: stderr.at(-1) ?? '' }) : t('{agent} exited', { agent: spec.name }))
      else if (code !== 0 && signal !== 'SIGTERM') this.events.notice('error', t('{agent} exited ({reason}). The next message restarts it.', { agent: spec.name, reason: String(signal ?? code) }))
    })

    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>)
    const app = acp
      .client({ name: 'ladder' })
      .onNotification(acp.methods.client.session.update, ({ params }) => this.onUpdate(params))
      .onRequest(acp.methods.client.session.requestPermission, async ({ params, signal }) => this.onPermission(params, signal))
      .onRequest('*', ({ method }) => {
        throw acp.RequestError.methodNotFound(method)
      })
      // Estensioni con "_" (per esempio lo stato del login, con email e piano): ignorate.
      .onNotification('*', () => undefined)
    this.connection = app.connect(stream)
    const agent = this.connection.agent

    // Nessuna capacità lato client: gli agenti provati scrivono ed eseguono da sé.
    const init = await agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'ladder', title: 'Ladder', version: '0.0.0' }
    })
    const caps = (init.agentCapabilities ?? {}) as { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } }
    let configOptions: ConfigOption[] | null | undefined
    if (this.sessionId && caps.sessionCapabilities?.resume) {
      const res = await agent.request(acp.methods.agent.session.resume, { sessionId: this.sessionId, cwd: this.options.cwd, mcpServers: [] })
      configOptions = (res as { configOptions?: ConfigOption[] | null }).configOptions
    } else {
      // Senza ripresa (o se l'agente non la supporta) si apre una sessione nuova: la storia resta in Ladder.
      const res = await agent.request(acp.methods.agent.session.new, { cwd: this.options.cwd, mcpServers: [] })
      this.sessionId = res.sessionId
      configOptions = res.configOptions
    }
    this.config = configOptions ?? []
    // Modello, effort e modalità non sopravvivono alla ripresa: si riapplicano sempre.
    await this.applyConfig()
    const models = this.optionByCategory('model')
    this.events.account({
      account: (init.agentInfo as { title?: string; name?: string; version?: string } | undefined)?.title ?? spec.name,
      models: models ? flatten(models).map((v) => ({ id: v.value, label: v.name })) : [],
      limits: null
    })
    this.events.init({ externalId: this.sessionId!, model: this.model ?? (models?.type === 'select' ? String(models.currentValue) : null) })
  }

  private optionByCategory(category: string): ConfigOption | undefined {
    return this.config.find((o) => o.category === category && o.type === 'select')
  }

  private async setOption(option: ConfigOption | undefined, value: string | null): Promise<void> {
    if (!option || !value || !this.connection || !this.sessionId || option.type !== 'select' || option.currentValue === value) return
    if (!flatten(option).some((v) => v.value === value)) return
    const res = await this.connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId: option.id, value })
    this.config = (res.configOptions as ConfigOption[] | null | undefined) ?? this.config
  }

  private async applyConfig(): Promise<void> {
    try {
      await this.setOption(this.optionByCategory('model'), this.model)
      const thought = this.optionByCategory('thought_level')
      if (thought && this.effort) {
        const match = flatten(thought).find((v) => v.value.toLowerCase() === this.effort || v.name.toLowerCase() === this.effort)
        await this.setOption(thought, match?.value ?? null)
      }
      const mode = this.optionByCategory('mode')
      if (mode) {
        const values = flatten(mode)
        let hit: SelectValue | undefined
        for (const pattern of MODE_PATTERNS[this.permission]) {
          hit = values.find((v) => pattern.test(v.value) || pattern.test(v.name))
          if (hit) break
        }
        await this.setOption(mode, hit?.value ?? null)
      }
    } catch (error) {
      this.events.notice('info', t('{agent} did not accept the settings: {message}', { agent: this.options.spec.name, message: (error as Error).message }))
    }
  }

  send(text: string, attachments: Attachment[] = []): void {
    this.running = true
    this.turnStartedAt = Date.now()
    this.events.activity(t('Thinking…'))
    void (async () => {
      try {
        if (!this.ready) this.start()
        await this.ready
        const response: acp.PromptResponse = await this.connection!.agent.request(acp.methods.agent.session.prompt, {
          sessionId: this.sessionId!,
          prompt: [...attachments.map((a) => ({ type: 'image' as const, data: a.data, mimeType: a.mediaType })), { type: 'text' as const, text }]
        })
        const reason = response.stopReason
        this.finishTurn(reason === 'cancelled' ? 'interrupted' : reason === 'refusal' ? 'error' : 'completed', reason === 'refusal' ? t('The agent refused the request.') : null)
      } catch (error) {
        this.finishTurn('error', (error as Error).message)
      }
    })()
  }

  async interrupt(): Promise<void> {
    // Le richieste aperte si chiudono con "cancelled", come vuole il protocollo.
    for (const controller of this.pending.values()) controller.abort()
    if (this.connection && this.sessionId) await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }).catch(() => undefined)
  }

  async setPermission(level: PermissionLevel): Promise<void> {
    this.permission = level
    if (this.connection) await this.applyConfig()
  }

  async setModel(model: string): Promise<void> {
    this.model = model
    if (this.connection) await this.applyConfig()
  }

  close(): void {
    this.closed = true
    for (const controller of this.pending.values()) controller.abort()
    this.connection?.close()
    this.child?.kill('SIGTERM')
    this.child = null
  }

  // ── Aggiornamenti della sessione ──────────────────────────────────────────

  private closeOpen(): void {
    const open = this.open
    if (!open) return
    this.open = null
    if (open.kind === 'message') this.events.assistant(open.id, open.text, false)
  }

  private onUpdate(notification: acp.SessionNotification): void {
    if (this.sessionId && notification.sessionId !== this.sessionId) return
    const u = notification.update
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (!this.running) return
        const kind = u.sessionUpdate === 'agent_message_chunk' ? 'message' : 'thought'
        const text = u.content.type === 'text' ? u.content.text : ''
        const messageId = (u as { messageId?: string | null }).messageId ?? null
        if (!this.open || this.open.kind !== kind || (messageId && messageId !== this.open.id.split(':')[1])) {
          this.closeOpen()
          this.open = { kind, id: `${this.sessionId}:${messageId ?? `m${++this.counter}`}:${this.counter}`, text: '' }
        }
        this.open.text += text
        if (kind === 'message') this.events.assistant(this.open.id, this.open.text, true)
        else this.events.activity(t('Reasoning…'))
        return
      }
      case 'tool_call': {
        if (!this.running) return
        this.closeOpen()
        const raw = (u.rawInput ?? {}) as Record<string, unknown>
        const command = displayCommand(typeof raw.command === 'string' ? raw.command : Array.isArray(raw.command) ? (raw.command as string[]).join(' ') : null)
        const location = u.locations?.[0]?.path ?? null
        const kind = u.kind ?? 'other'
        const tool = { title: u.title || command || kind, kind, detail: command ?? location, output: '', status: u.status ?? 'pending' }
        this.tools.set(u.toolCallId, tool)
        this.captureContent(u.toolCallId, u.content, (u as { _meta?: Record<string, unknown> })._meta)
        this.events.activity(tool.title)
        this.emitTool(u.toolCallId)
        return
      }
      case 'tool_call_update': {
        const tool = this.tools.get(u.toolCallId)
        if (!tool) return
        if (u.title) tool.title = u.title
        if (u.status) tool.status = u.status
        this.captureContent(u.toolCallId, u.content, (u as { _meta?: Record<string, unknown> })._meta)
        this.emitTool(u.toolCallId)
        return
      }
      case 'usage_update': {
        const usage = u as { used?: number; size?: number }
        if (typeof usage.used === 'number' && typeof usage.size === 'number' && usage.size > 0) this.context = { used: usage.used, window: usage.size }
        return
      }
      case 'config_option_update':
        this.config = (u as { configOptions: ConfigOption[] }).configOptions ?? this.config
        return
      default:
        return
    }
  }

  private captureContent(id: string, content: acp.ToolCallContent[] | null | undefined, meta: Record<string, unknown> | null | undefined): void {
    const tool = this.tools.get(id)
    if (!tool) return
    for (const c of content ?? []) {
      if (c.type === 'diff') this.diffs.set(id, { path: c.path, oldText: c.oldText ?? null, newText: c.newText })
      else if (c.type === 'content' && c.content.type === 'text') tool.output += c.content.text
    }
    // Output dei comandi fuori standard (per esempio _meta.terminal_output_delta di codex-acp).
    for (const [key, value] of Object.entries(meta ?? {})) {
      if (!/terminal_output/.test(key)) continue
      const text = typeof value === 'string' ? value : typeof (value as { data?: unknown })?.data === 'string' ? String((value as { data: string }).data) : ''
      tool.output += text
    }
  }

  private emitTool(id: string): void {
    const tool = this.tools.get(id)
    if (!tool) return
    const status = tool.status === 'completed' ? 'done' : tool.status === 'failed' ? 'error' : 'running'
    const category = tool.kind === 'execute' ? 'command' : tool.kind === 'edit' || tool.kind === 'delete' || tool.kind === 'move' ? 'edit' : tool.kind === 'read' ? 'read' : tool.kind === 'search' ? 'search' : tool.kind === 'fetch' ? 'web' : tool.kind === 'think' ? 'plan' : 'other'
    this.events.tool({ id, tool: category, name: tool.kind, title: firstLine(tool.title), detail: tool.detail, status, output: clip(tool.output) })
  }

  private async onPermission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    this.closeOpen()
    const call = params.toolCall
    const known = this.tools.get(call.toolCallId)
    const raw = (call.rawInput ?? {}) as Record<string, unknown>
    const command = displayCommand(typeof raw.command === 'string' ? raw.command : Array.isArray(raw.command) ? shellJoin(raw.command as string[]) : null) ?? (known?.kind === 'execute' ? known.detail : null)
    const diff = this.diffs.get(call.toolCallId) ?? (call.content ?? []).filter((c): c is Extract<acp.ToolCallContent, { type: 'diff' }> => c.type === 'diff').map((c) => ({ path: c.path, oldText: c.oldText ?? null, newText: c.newText }))[0]
    // I nomi delle opzioni sono quelli dell'agente: il significato di un rifiuto cambia da agente ad agente.
    const options: RequestOption[] = params.options.map((o) => ({
      id: o.optionId,
      label: o.name,
      kind: o.kind === 'allow_once' ? 'allow' : o.kind === 'allow_always' ? 'allow-always' : 'deny'
    }))
    const controller = new AbortController()
    const key = `${call.toolCallId}:${Date.now()}`
    this.pending.set(key, controller)
    signal.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      const response = await this.events.request(
        {
          requestType: 'permission',
          toolName: known?.kind ?? call.kind ?? 'tool',
          title: call.title ?? known?.title ?? t('Agent request'),
          command,
          path: diff?.path ?? call.locations?.[0]?.path ?? null,
          reason: null,
          options,
          questions: null,
          preview: diff ? textPreview(diff.oldText, diff.newText) : null
        },
        controller.signal
      )
      if (controller.signal.aborted || !('optionId' in response) || !params.options.some((o) => o.optionId === response.optionId)) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: response.optionId } }
    } finally {
      this.pending.delete(key)
    }
  }

  private finishTurn(status: 'completed' | 'interrupted' | 'error', error: string | null): void {
    if (!this.running) return
    this.running = false
    this.closeOpen()
    // Dopo un rifiuto o un annullamento le tool call restano "in corso": le chiude Ladder.
    for (const [id, tool] of this.tools) {
      if (tool.status !== 'completed' && tool.status !== 'failed') {
        tool.status = status === 'completed' ? 'completed' : 'failed'
        this.emitTool(id)
      }
    }
    this.tools.clear()
    this.diffs.clear()
    this.events.activity(null)
    this.events.turnEnd({ status, durationMs: Date.now() - this.turnStartedAt, costUsd: null, error: status === 'error' ? (error ?? t('The turn failed.')) : null, context: this.context })
  }
}

/** Testo prima e dopo → righe - e + (diff ingenuo per l'anteprima della card). */
function textPreview(oldText: string | null, newText: string): UserRequest['preview'] {
  const before = oldText ? oldText.split('\n') : []
  const after = newText.split('\n')
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  const lines = [...before.slice(start, endBefore).map((l) => `-${l}`), ...after.slice(start, endAfter).map((l) => `+${l}`)]
  if (lines.length === 0) return null
  return { text: lines.slice(0, 400).join('\n'), lines: lines.length, truncated: lines.length > 400 }
}

/** Argomenti di un comando ricomposti come li scriveresti nella shell. */
function shellJoin(args: string[]): string {
  return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ')
}
