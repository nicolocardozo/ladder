// Adapter Claude Code: una sessione di Ladder = un `query()` dell'Agent SDK con input in streaming.
import { relative } from 'node:path'
import {
  query,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { Attachment, Effort, PermissionLevel, Question, RequestOption, RequestResponse, ToolKind } from '@shared/protocol'
import { claudeEnv } from './environment'

export const PERMISSION_MODE: Record<PermissionLevel, PermissionMode> = {
  plan: 'plan',
  ask: 'default',
  edit: 'acceptEdits',
  full: 'bypassPermissions'
}

export interface ToolUpdate {
  id: string
  tool: ToolKind
  name: string
  title: string
  detail: string | null
  status: 'running' | 'done' | 'error' | 'denied'
  output: string | null
}

export interface UserRequest {
  requestType: 'permission' | 'question'
  toolName: string
  title: string
  command: string | null
  path: string | null
  reason: string | null
  options: RequestOption[]
  questions: Question[] | null
  preview?: { text: string; lines: number; truncated: boolean } | null
}

const PREVIEW_MAX_LINES = 400

/** Modifica proposta da Edit, MultiEdit e Write come righe "- " e "+ ": serve alla card e a "In attesa". */
export function editPreview(toolName: string, input: Record<string, unknown>): UserRequest['preview'] {
  const lines: string[] = []
  const add = (prefix: string, text: unknown) => {
    if (typeof text !== 'string' || text === '') return
    for (const line of text.replace(/\n$/, '').split('\n')) lines.push(`${prefix}${line}`)
  }
  if (toolName === 'Edit') {
    add('-', input.old_string)
    add('+', input.new_string)
  } else if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const edit of input.edits as Record<string, unknown>[]) {
      if (lines.length) lines.push('…')
      add('-', edit.old_string)
      add('+', edit.new_string)
    }
  } else if (toolName === 'Write') {
    add('+', input.content)
  } else {
    return null
  }
  if (lines.length === 0) return null
  const counted = lines.filter((l) => l !== '…').length
  return { text: lines.slice(0, PREVIEW_MAX_LINES).join('\n'), lines: counted, truncated: lines.length > PREVIEW_MAX_LINES }
}

export interface TurnResult {
  status: 'completed' | 'interrupted' | 'error'
  durationMs: number
  costUsd: number | null
  error: string | null
  context: { used: number; window: number } | null
}

export interface AdapterEvents {
  init(info: { externalId: string; model: string | null }): void
  assistant(id: string, text: string, streaming: boolean): void
  tool(update: ToolUpdate): void
  activity(text: string | null): void
  request(request: UserRequest, signal: AbortSignal): Promise<RequestResponse>
  turnEnd(result: TurnResult): void
  notice(tone: 'info' | 'error', text: string): void
  account(info: { account: string | null; models: { id: string; label: string }[]; limits?: string | null }): void
  exit(error: string | null): void
}

export interface StartOptions {
  cwd: string
  cli: string | null
  model: string | null
  effort: Effort | null
  permission: PermissionLevel
  resume: string | null
}

/** Coda di messaggi utente letta dall'SDK come prompt in streaming. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false
  push(text: string, attachments: Attachment[] = []): void {
    const content = attachments.length
      ? [
          ...attachments.map((a) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: a.mediaType as 'image/png', data: a.data } })),
          { type: 'text' as const, text }
        ]
      : text
    this.items.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })
    this.wake?.()
  }
  close(): void {
    this.closed = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.items.length) yield this.items.shift()!
      if (this.closed) return
      await new Promise<void>((resolve) => (this.wake = resolve))
      this.wake = null
    }
  }
}

type Block = Record<string, unknown>

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function firstLine(text: string, max = 80): string {
  const line = text.split('\n')[0]
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Titolo leggibile e categoria di una tool call di Claude Code. */
export function describeTool(name: string, input: Block, cwd: string): Pick<ToolUpdate, 'tool' | 'title' | 'detail'> {
  const rel = (p: unknown) => {
    const path = str(p)
    if (!path) return null
    const r = relative(cwd, path)
    return r && !r.startsWith('..') ? r : path
  }
  switch (name) {
    case 'Bash': {
      const command = str(input.command) ?? ''
      return { tool: 'command', title: `Esegue ${firstLine(command)}`, detail: command }
    }
    case 'Read':
      return { tool: 'read', title: `Legge ${rel(input.file_path) ?? 'un file'}`, detail: rel(input.file_path) }
    case 'Write':
      return { tool: 'edit', title: `Scrive ${rel(input.file_path) ?? 'un file'}`, detail: rel(input.file_path) }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { tool: 'edit', title: `Modifica ${rel(input.file_path ?? input.notebook_path) ?? 'un file'}`, detail: rel(input.file_path ?? input.notebook_path) }
    case 'Grep':
      return { tool: 'search', title: `Cerca “${firstLine(str(input.pattern) ?? '', 50)}”`, detail: str(input.pattern) }
    case 'Glob':
      return { tool: 'search', title: `Cerca file ${firstLine(str(input.pattern) ?? '', 50)}`, detail: str(input.pattern) }
    case 'WebSearch':
      return { tool: 'web', title: `Cerca sul web: ${firstLine(str(input.query) ?? '', 60)}`, detail: str(input.query) }
    case 'WebFetch':
      return { tool: 'web', title: `Legge ${firstLine(str(input.url) ?? 'una pagina', 60)}`, detail: str(input.url) }
    case 'Task':
    case 'Agent':
      return { tool: 'agent', title: `Sotto-agente: ${firstLine(str(input.description) ?? 'attività', 60)}`, detail: str(input.prompt) }
    case 'TodoWrite':
      return { tool: 'plan', title: 'Aggiorna il piano', detail: null }
    case 'ExitPlanMode':
      return { tool: 'plan', title: 'Propone il piano', detail: str(input.plan) }
    default:
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__')
        return { tool: 'other', title: `Usa ${server} · ${tool}`, detail: null }
      }
      return { tool: 'other', title: `Usa ${name}`, detail: null }
  }
}

function toolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && (part as Block).type === 'text' ? String((part as Block).text ?? '') : ''))
      .join('\n')
  }
  return null
}

const OUTPUT_LIMIT = 8000

export class ClaudeSession {
  private input = new InputQueue()
  private q: Query | null = null
  private abort = new AbortController()
  private toolInputs = new Map<string, { name: string; input: Block }>()
  /** Blocchi di testo in streaming: indice del blocco → id dell'elemento. */
  private streamBlocks = new Map<number, string>()
  /** Blocchi di testo aperti nello stream e non ancora chiusi dal messaggio completo, in ordine. */
  private openTextIds: string[] = []
  private textCounter = 0
  private deniedTools = new Set<string>()
  private currentMessageId: string | null = null
  private turnStartedAt = 0
  private running = false
  private interrupted = false

  constructor(
    private readonly options: StartOptions,
    private readonly events: AdapterEvents
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    const { cwd, cli, model, effort, permission, resume } = this.options
    const canUseTool: CanUseTool = (toolName, input, opts) => this.handlePermission(toolName, input, opts)
    this.q = query({
      prompt: this.input,
      options: {
        cwd,
        env: claudeEnv(),
        abortController: this.abort,
        ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(resume ? { resume } : {}),
        permissionMode: PERMISSION_MODE[permission],
        allowDangerouslySkipPermissions: permission === 'full',
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        // Con il login dell'abbonamento la CLI collegherebbe i connettori di claude.ai (posta, calendario…).
        settings: { disableClaudeAiConnectors: true },
        canUseTool
      }
    })
    void this.consume()
    void this.loadAccount()
  }

  send(text: string, attachments: Attachment[] = []): void {
    this.running = true
    this.interrupted = false
    this.turnStartedAt = Date.now()
    this.events.activity('Pensa…')
    this.input.push(text, attachments)
  }

  async interrupt(): Promise<void> {
    this.interrupted = true
    try {
      await this.q?.interrupt()
    } catch (error) {
      this.events.notice('error', `Interruzione non riuscita: ${(error as Error).message}`)
    }
  }

  async setPermission(level: PermissionLevel): Promise<void> {
    await this.q?.setPermissionMode(PERMISSION_MODE[level])
  }

  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model)
  }

  close(): void {
    this.input.close()
    this.abort.abort()
  }

  private async loadAccount(): Promise<void> {
    if (!this.q) return
    try {
      const [account, models] = await Promise.all([this.q.accountInfo(), this.q.supportedModels()])
      const plan = (account as Record<string, unknown>).subscriptionType
      const keySource = (account as Record<string, unknown>).apiKeySource
      this.events.account({
        account: typeof plan === 'string' ? plan : keySource && keySource !== 'none' ? 'Chiave API' : null,
        models: models.map((m) => ({ id: m.value, label: m.displayName }))
      })
    } catch {
      // Le informazioni sull'account sono un di più: senza, la sessione funziona lo stesso.
    }
  }

  private async consume(): Promise<void> {
    if (!this.q) return
    try {
      for await (const message of this.q) this.handle(message)
      this.events.exit(null)
    } catch (error) {
      const text = (error as Error).message
      if (this.running) this.finishTurn({ status: 'error', durationMs: Date.now() - this.turnStartedAt, costUsd: null, error: text, context: null })
      this.events.exit(this.abort.signal.aborted ? null : text)
    }
  }

  private handle(message: SDKMessage): void {
    const m = message as Block & { type: string }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') this.events.init({ externalId: String(m.session_id), model: str(m.model) })
        return
      case 'stream_event':
        if (m.parent_tool_use_id) return // testo dei sotto-agenti: per ora non lo mostriamo
        this.handleStream(m.event as Block)
        return
      case 'assistant':
        if (m.parent_tool_use_id) return
        this.handleAssistant(m.message as Block)
        return
      case 'user':
        this.handleToolResults(m.message as Block)
        return
      case 'result':
        this.handleResult(m)
        return
      case 'rate_limit_event': {
        const info = (m.rate_limit_info ?? {}) as Block
        if (info.status === 'rejected') {
          const reset = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : null
          this.events.notice('error', `Limite d’uso raggiunto${reset ? `: si azzera alle ${reset}` : ''}.`)
        } else if (info.status === 'allowed_warning') {
          this.events.notice('info', 'Ti stai avvicinando al limite d’uso del piano.')
        }
        return
      }
      default:
        return
    }
  }

  private handleStream(event: Block): void {
    switch (event.type) {
      case 'message_start':
        this.currentMessageId = String((event.message as Block)?.id ?? `m${Date.now()}`)
        this.streamBlocks.clear()
        return
      case 'content_block_start': {
        const block = event.content_block as Block
        if (block?.type === 'text') {
          const id = `${this.currentMessageId}:${String(event.index)}`
          this.streamBlocks.set(Number(event.index), id)
          this.openTextIds.push(id)
          this.events.assistant(id, '', true)
          this.events.activity('Scrive la risposta')
        } else if (block?.type === 'thinking') {
          this.events.activity('Pensa…')
        }
        return
      }
      case 'content_block_delta': {
        const delta = event.delta as Block
        const id = this.streamBlocks.get(Number(event.index))
        if (id && delta?.type === 'text_delta') this.appendText(id, String(delta.text ?? ''))
        return
      }
      default:
        return
    }
  }

  private texts = new Map<string, string>()
  private appendText(id: string, chunk: string): void {
    const text = (this.texts.get(id) ?? '') + chunk
    this.texts.set(id, text)
    this.events.assistant(id, text, true)
  }

  private handleAssistant(message: Block): void {
    const messageId = String(message.id ?? this.currentMessageId ?? `m${Date.now()}`)
    const content = Array.isArray(message.content) ? (message.content as Block[]) : []
    content.forEach((block) => {
      if (block.type === 'text') {
        // Il messaggio completo arriva un blocco alla volta: chiude il primo blocco di testo ancora aperto.
        const id = this.openTextIds.shift() ?? `${messageId}:t${++this.textCounter}`
        this.texts.set(id, String(block.text ?? ''))
        this.events.assistant(id, String(block.text ?? ''), false)
      } else if (block.type === 'tool_use') {
        const id = String(block.id)
        const name = String(block.name)
        const input = (block.input ?? {}) as Block
        this.toolInputs.set(id, { name, input })
        if (name === 'AskUserQuestion') return // diventa una domanda, non una riga di attività
        const described = describeTool(name, input, this.options.cwd)
        this.events.tool({ id, name, ...described, status: 'running', output: null })
        this.events.activity(described.title)
      }
    })
  }

  private handleToolResults(message: Block): void {
    const content = Array.isArray(message?.content) ? (message.content as Block[]) : []
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const id = String(block.tool_use_id)
      const known = this.toolInputs.get(id)
      if (!known || known.name === 'AskUserQuestion') continue
      const text = toolResultText(block.content)
      const described = describeTool(known.name, known.input, this.options.cwd)
      const denied = this.deniedTools.has(id)
      this.events.tool({
        id,
        name: known.name,
        ...described,
        status: denied ? 'denied' : block.is_error ? 'error' : 'done',
        output: text ? text.slice(0, OUTPUT_LIMIT) : null
      })
    }
    this.events.activity('Pensa…')
  }

  private handleResult(m: Block): void {
    const usage = (m.modelUsage ?? {}) as Record<string, Block>
    const main = Object.values(usage).sort((a, b) => Number(b.contextWindow ?? 0) - Number(a.contextWindow ?? 0))[0]
    const lastUsage = (m.usage ?? {}) as Block
    const used =
      Number(lastUsage.input_tokens ?? 0) + Number(lastUsage.cache_read_input_tokens ?? 0) + Number(lastUsage.cache_creation_input_tokens ?? 0)
    const context = main && Number(main.contextWindow) > 0 ? { used, window: Number(main.contextWindow) } : null
    const isError = m.subtype !== 'success' || m.is_error === true
    const status: TurnResult['status'] = this.interrupted ? 'interrupted' : isError ? 'error' : 'completed'
    const errors = Array.isArray(m.errors) ? (m.errors as unknown[]).map(String).join('\n') : null
    this.finishTurn({
      status,
      durationMs: Number(m.duration_ms ?? Date.now() - this.turnStartedAt),
      costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null,
      error: status === 'error' ? errors || str(m.result) || 'La sessione si è fermata con un errore.' : null,
      context
    })
  }

  private finishTurn(result: TurnResult): void {
    this.running = false
    this.interrupted = false
    this.texts.clear()
    this.openTextIds = []
    this.events.activity(null)
    this.events.turnEnd(result)
  }

  private async handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string; decisionReason?: string; toolUseID?: string }
  ): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') return this.handleQuestion(input, opts.signal)
    const described = describeTool(toolName, input, this.options.cwd)
    const options: RequestOption[] = [{ id: 'allow', label: 'Approva', kind: 'allow' }]
    if (opts.suggestions?.length) options.push({ id: 'always', label: 'Consenti sempre', kind: 'allow-always' })
    options.push({ id: 'deny', label: 'Rifiuta', kind: 'deny' })
    this.events.activity('Aspetta la tua approvazione')
    const response = await this.events.request(
      {
        requestType: 'permission',
        toolName,
        title: described.title,
        command: toolName === 'Bash' ? str(input.command) : null,
        path: described.tool === 'edit' || described.tool === 'read' ? described.detail : opts.blockedPath ?? null,
        reason: str(input.description) ?? str(opts.decisionReason),
        options,
        questions: null,
        preview: editPreview(toolName, input)
      },
      opts.signal
    )
    this.events.activity(described.title)
    if ('optionId' in response && response.optionId === 'allow') return { behavior: 'allow', updatedInput: input }
    if ('optionId' in response && response.optionId === 'always')
      return { behavior: 'allow', updatedInput: input, updatedPermissions: opts.suggestions ?? [] }
    const message = 'optionId' in response && response.message ? response.message : 'L’utente ha rifiutato questa azione.'
    if (opts.toolUseID) this.deniedTools.add(opts.toolUseID)
    return { behavior: 'deny', message }
  }

  private async handleQuestion(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const raw = Array.isArray(input.questions) ? (input.questions as Block[]) : []
    const questions: Question[] = raw.map((q) => ({
      question: String(q.question ?? ''),
      header: str(q.header),
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? (q.options as Block[]) : []).map((o) => ({ label: String(o.label ?? ''), description: str(o.description) }))
    }))
    this.events.activity('Aspetta una tua risposta')
    const response = await this.events.request(
      { requestType: 'question', toolName: 'AskUserQuestion', title: questions[0]?.question ?? 'Domanda', command: null, path: null, reason: null, options: [], questions },
      signal
    )
    this.events.activity('Pensa…')
    if ('answers' in response) return { behavior: 'allow', updatedInput: { ...input, answers: response.answers } }
    return { behavior: 'deny', message: 'L’utente non ha risposto alla domanda.' }
  }
}
