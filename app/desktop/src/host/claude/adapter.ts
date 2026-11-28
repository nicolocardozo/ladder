// Claude Code adapter: one Ladder session = one Agent SDK `query()` with streaming input.
import { randomUUID } from 'node:crypto'
import { relative } from 'node:path'
import {
  query,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand as SDKSlashCommand
} from '@anthropic-ai/claude-agent-sdk'
import { localeTag, t } from '@shared/i18n'
import type { AgentStatus, Attachment, Effort, PermissionLevel, Question, RequestOption, RequestResponse, SlashCommand, ToolKind, UsageWindow } from '@shared/protocol'
import { agentInstructions, BROWSER_MCP_NAME, LADDER_MCP_NAME, ladderDetail } from '../agents/common'
import type { SubagentUpdate } from '../subagents'
import { readOnlyHooks } from './read-only'
import { claudeAccountLabel, claudeEnv, claudeModels, claudeUsage, readClaudeDefaults } from './environment'

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
  /** All the files touched, when there is more than one (Codex apply_patch). */
  paths?: string[]
}

const PREVIEW_MAX_LINES = 400

/** Change proposed by Edit, MultiEdit and Write as "- " and "+ " lines: used by the card and by "Waiting". */
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
  context: { used: number; window: number; compactAt?: number | null } | null
}

export interface AdapterEvents {
  init(info: { externalId: string; model: string | null; effort?: Effort | null }): void
  assistant(id: string, text: string, streaming: boolean): void
  tool(update: ToolUpdate): void
  activity(text: string | null): void
  request(request: UserRequest, signal: AbortSignal): Promise<RequestResponse>
  turnEnd(result: TurnResult): void
  /** The agent opened a turn on its own: an inserted message that survived an interruption. The host opens the turn. */
  turnStart?(uuids: string[]): void
  notice(tone: 'info' | 'error', text: string): void
  account(info: { account: string | null; email?: string | null; models: AgentStatus['models']; limits?: string | null }): void
  /** Plan limit windows: merged into the already known ones, by key. */
  usage(windows: UsageWindow[]): void
  /** Sub-agents started by the session: partial updates, merged by the host. */
  subagent(update: SubagentUpdate): void
  /** List of the agent's / commands: replaces the known one. */
  commands(commands: SlashCommand[]): void
  /** Context compacted, by hand or automatically. */
  compacted(info: { trigger: 'manual' | 'auto'; preTokens: number | null; postTokens: number | null }): void
  /** Context updated after the turn (arrives late relative to turnEnd): replaces the known one. */
  context?(context: NonNullable<TurnResult['context']>): void
  exit(error: string | null): void
}

export interface StartOptions {
  cwd: string
  cli: string | null
  /** Profile configuration folder (CLAUDE_CONFIG_DIR); null = the CLI's own. */
  configDir?: string | null
  model: string | null
  effort: Effort | null
  permission: PermissionLevel
  resume: string | null
  /** Autonomy instruction in the system prompt (HostPrefs.autonomyHint), only with edit or full permission. */
  autonomyHint?: boolean
  /** MCP server of the agent's browser (session URL and token); absent = no registration. */
  browserTools?: { url: string; token: string } | null
  /** Ladder MCP server (session URL and token); absent = no registration. */
  ladderTools?: { url: string; token: string } | null
  /** Read-only child session: write tools and plan exit are removed, not just refused. */
  readOnly?: boolean
  /** Project delegates in the system prompt. */
  delegateHint?: string | null
}


/** After how long an implicit turn with no main-thread messages is considered never started. */
const IMPLICIT_TURN_MS = 45_000

/** Queue of user messages read by the SDK as a streaming prompt. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false
  push(text: string, attachments: Attachment[] = [], extra: Pick<SDKUserMessage, 'uuid' | 'priority'> = {}): void {
    const content = attachments.length
      ? [
          ...attachments.map((a) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: a.mediaType as 'image/png', data: a.data } })),
          { type: 'text' as const, text }
        ]
      : text
    this.items.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...extra })
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

function asEffortLevel(value: unknown): Effort | null {
  return typeof value === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? (value as Effort) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isAgentTool(name: string): boolean {
  return name === 'Task' || name === 'Agent'
}

function firstLine(text: string, max = 80): string {
  const line = text.split('\n')[0]
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Readable title and category of a Claude Code tool call. */
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
      return { tool: 'command', title: t('Runs {command}', { command: firstLine(command) }), detail: command }
    }
    case 'Read':
      return { tool: 'read', title: t('Reads {file}', { file: rel(input.file_path) ?? t('a file') }), detail: rel(input.file_path) }
    case 'Write':
      return { tool: 'edit', title: t('Writes {file}', { file: rel(input.file_path) ?? t('a file') }), detail: rel(input.file_path) }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { tool: 'edit', title: t('Edits {file}', { file: rel(input.file_path ?? input.notebook_path) ?? t('a file') }), detail: rel(input.file_path ?? input.notebook_path) }
    case 'Grep':
      return { tool: 'search', title: t('Searches “{pattern}”', { pattern: firstLine(str(input.pattern) ?? '', 50) }), detail: str(input.pattern) }
    case 'Glob':
      return { tool: 'search', title: t('Searches files {pattern}', { pattern: firstLine(str(input.pattern) ?? '', 50) }), detail: str(input.pattern) }
    case 'WebSearch':
      return { tool: 'web', title: t('Searches the web: {query}', { query: firstLine(str(input.query) ?? '', 60) }), detail: str(input.query) }
    case 'WebFetch':
      return { tool: 'web', title: t('Reads {file}', { file: firstLine(str(input.url) ?? t('a page'), 60) }), detail: str(input.url) }
    case 'Task':
    case 'Agent':
      return { tool: 'agent', title: t('Subagent: {task}', { task: firstLine(str(input.description) ?? t('task'), 60) }), detail: str(input.prompt) }
    case 'TodoWrite':
      return { tool: 'plan', title: t('Updates the plan'), detail: null }
    case 'ExitPlanMode':
      return { tool: 'plan', title: t('Proposes the plan'), detail: str(input.plan) }
    default:
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__')
        return { tool: 'other', title: t('Uses {tool}', { tool: `${server} · ${tool}` }), detail: server === LADDER_MCP_NAME ? ladderDetail(input, tool) : null }
      }
      return { tool: 'other', title: t('Uses {tool}', { tool: name }), detail: null }
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
/** task_id → sub-agent entries that stay around for resumes. */
const TASK_MAP_LIMIT = 500
/** Grace period before treating a background task missing from background_tasks_changed as finished: the order relative to task_started/notification is not guaranteed. */
const BG_GRACE_MS = 3000
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export class ClaudeSession {
  private input = new InputQueue()
  private q: Query | null = null
  /** Tokens of the last assistant message of the main loop (last per message.id), fallback if getContextUsage fails. */
  private lastMainUsed: number | null = null
  private lastWindow: number | null = null
  private contextSeq = 0
  private abort = new AbortController()
  private toolInputs = new Map<string, { name: string; input: Block }>()
  /** Streaming text blocks: block index → item id. */
  private streamBlocks = new Map<number, string>()
  /** Text blocks open in the stream and not yet closed by the complete message, in order. */
  private openTextIds: string[] = []
  private textCounter = 0
  private deniedTools = new Set<string>()
  /** Agent/Task tool_use at every level: they become the nodes of the agent map. */
  private agentTools = new Set<string>()
  /**
   * SDK task_id (and agentId from the Agent output) → sub-agent id (its tool_use, if any).
   * Not emptied at the end of the turn: a resume carries the same task_id and must find the original entry. Limited to TASK_MAP_LIMIT.
   */
  private taskIds = new Map<string, string>()
  /** Last run_id seen per task_id: late messages from an earlier run don't touch the resume. */
  private taskRuns = new Map<string, string>()
  /** task_id of the background sub-agents still running as far as we know: background_tasks_changed is compared against them. */
  private bgTasks = new Set<string>()
  /** Set of live background tasks since the last background_tasks_changed (null: never received). */
  private liveTasks: Set<string> | null = null
  /** Live background tasks of every kind (background commands, monitors, sub-agents) since the last background_tasks_changed. */
  private liveBackground = 0
  /** Live background tasks that are shell commands or monitors rather than agents or workflows. */
  private liveCommands = 0
  private bgTimer: ReturnType<typeof setTimeout> | null = null
  /** Sub-agents followed by task_* events: the end is told by task_notification, not by tool_result. */
  private trackedTasks = new Set<string>()
  /** Agent/Task seen from tool_use and not yet linked to a task_started: used to match tasks without a tool_use_id. */
  private unlinkedAgents = new Map<string, string>()
  /** Sub-agents whose model is already known (from input.model or the first message): not overwritten. */
  private modelKnown = new Set<string>()
  /** Finished sub-agents: at the end of the turn their entries leave the maps above. */
  private doneAgents = new Set<string>()
  /** Sub-agent tools (id → name and title): on the result their state is updated in the agent's buffer. */
  private subTools = new Map<string, { name: string; title: string; parent: string }>()
  private currentMessageId: string | null = null
  private turnStartedAt = 0
  private running = false
  private interrupted = false
  /** The running turn comes from a / command; the displayed text (assistant or local output) avoids the duplicate. */
  private commandTurn = false
  private turnText = false
  /** Inserted messages (uuid) the CLI hasn't merged into a turn yet: if the turn ends, they run on their own. */
  private pendingSteers = new Set<string>()
  /** The running turn was opened by the CLI for an inserted message, not by the host. */
  private implicitTurn = false
  /** Something has already arrived from the CLI in the implicit turn. */
  private implicitActive = false
  /** Fires if the implicit turn produces nothing: the pending ones never started and must not be waited for. */
  private implicitTimer: ReturnType<typeof setTimeout> | null = null
  /** Stop: whatever runs on its own after the interruption must be stopped too (see stopSurvivors). */
  private stopSurvivors = new Set<string>()
  /** Without the list of uuids, Stop applies to the first implicit turn that starts before this time. */
  private stopFirstUntil = 0
  /** The open implicit turn contains messages that a Stop has already asked to stop. */
  private implicitStop = false

  constructor(
    private readonly options: StartOptions,
    private readonly events: AdapterEvents
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  get pendingSteerCount(): number {
    return this.pendingSteers.size
  }

  /** Turn opened for inserted messages the CLI hasn't started yet. */
  get idleImplicitTurn(): boolean {
    return this.implicitTurn && !this.implicitActive && this.running
  }

  start(): void {
    const { cwd, cli, configDir, model, effort, permission, resume, autonomyHint } = this.options
    const canUseTool: CanUseTool = (toolName, input, opts) => this.handlePermission(toolName, input, opts)
    this.q = query({
      prompt: this.input,
      options: {
        cwd,
        // The agent browser's token travels in the process environment, not in the arguments (`ps` shows them to everyone).
        env: { ...claudeEnv(configDir ?? null), ...(this.options.browserTools ? { LADDER_BROWSER_TOKEN: this.options.browserTools.token } : {}), ...(this.options.ladderTools ? { LADDER_MCP_TOKEN: this.options.ladderTools.token } : {}) },
        abortController: this.abort,
        ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(resume ? { resume } : {}),
        permissionMode: PERMISSION_MODE[permission],
        // Read-only: write tools removed and a hook that decides before the settings allow rules (see read-only.ts).
        ...(this.options.readOnly ? { disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode'], hooks: readOnlyHooks } : {}),
        // Always Claude Code's prompt (without it the SDK would use an empty prompt). Default snapshot: the prompt is recorded at the
        // first request and reused (stable cache), so the autonomy instruction applies from the session's creation
        // (permission and preference of that moment); later resumes and permission changes don't alter it.
        systemPrompt: {
          type: 'preset' as const,
          preset: 'claude_code' as const,
          append: agentInstructions(autonomyHint && (permission === 'edit' || permission === 'full'), this.options.delegateHint)
        },
        // Always on: without it, a session born in Ask couldn't switch to Full access (setPermissionMode would be rejected).
        allowDangerouslySkipPermissions: !this.options.readOnly,
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        // With the subscription login the CLI would attach claude.ai connectors (mail, calendar…).
        settings: { disableClaudeAiConnectors: true },
        // The agent's browser. Confirmations (click, typing, addresses outside localhost) are asked by the server
        // itself with approval cards and according to the session level: here the tools don't ask a second time.
        // Ladder MCP server (handoff, delegation, result). Permissions are handled by the server (handoff confirmation) and, for
        // read-only children, by the hook (only list_agents and report_result).
        ...(this.options.browserTools || this.options.ladderTools
          ? {
              mcpServers: {
                ...(this.options.browserTools ? { [BROWSER_MCP_NAME]: { type: 'http' as const, url: this.options.browserTools.url, headers: { Authorization: 'Bearer ${LADDER_BROWSER_TOKEN}' }, timeout: 660_000 } } : {}),
                ...(this.options.ladderTools ? { [LADDER_MCP_NAME]: { type: 'http' as const, url: this.options.ladderTools.url, headers: { Authorization: 'Bearer ${LADDER_MCP_TOKEN}' }, timeout: 3_600_000 } } : {})
              },
              allowedTools: [...(this.options.browserTools ? [`mcp__${BROWSER_MCP_NAME}`] : []), ...(this.options.ladderTools ? [`mcp__${LADDER_MCP_NAME}`] : [])]
            }
          : {}),
        canUseTool
      }
    })
    void this.consume()
    void this.loadAccount()
    void this.loadCommands()
  }

  send(text: string, attachments: Attachment[] = []): void {
    this.resetStop()
    this.running = true
    this.interrupted = false
    this.commandTurn = false
    this.turnText = false
    this.turnStartedAt = Date.now()
    this.events.activity(t('Thinking…'))
    // With the uuid the CLI lists it in the turn's result.
    this.input.push(text, attachments, { uuid: randomUUID() })
  }

  /**
   * Inserts a message into the running turn: the CLI queues it and merges it into the turn between one tool round
   * and the next. Doesn't touch the turn's state and duration. False if there is no turn to join.
   */
  async steer(text: string, attachments: Attachment[] = [], id?: string): Promise<boolean> {
    if (!this.running || this.interrupted) return false
    const uuid = (id ?? randomUUID()) as ReturnType<typeof randomUUID>
    this.pendingSteers.add(uuid)
    this.input.push(text, attachments, { uuid, priority: 'next' })
    return true
  }

  /** A / command is a user message like any other: the CLI handles it. */
  command(name: string, args: string): void {
    this.send(`/${name} ${args}`.trim())
    this.commandTurn = true
  }

  /**
   * `all`: Stop, also stops inserted messages not yet merged (the SDK doesn't expose cancel_queued: if they run,
   * their turn starts and is interrupted at once, with the output staying visible). The surviving uuids are
   * remembered: Stop applies only to a turn that contains them, never to one opened by a background sub-agent.
   * Without `all` ("send now") the pending ones stay and run together with the new message.
   */
  async interrupt(all = false): Promise<void> {
    this.interrupted = true
    try {
      await this.afterReceipt(all)
    } catch (error) {
      this.resetStop()
      this.events.notice('error', t('Interrupt failed: {message}', { message: (error as Error).message }))
    }
  }

  /**
   * "Send now" with pending inserted messages: interrupts and, right after the receipt, puts the message in the
   * stream. This way the CLI merges it with the pending ones into a single turn, and the host opens one (the implicit one, which
   * reassigns the 'user' row created by `beforePush`). False if the interruption failed.
   */
  async interruptThenSend(text: string, attachments: Attachment[], id: string, beforePush: () => void): Promise<boolean> {
    this.interrupted = true
    try {
      await this.afterReceipt(false)
      beforePush()
      this.pendingSteers.add(id)
      this.input.push(text, attachments, { uuid: id as ReturnType<typeof randomUUID> })
      if (!this.running) this.armImplicit()
      return true
    } catch (error) {
      this.events.notice('error', t('Interrupt failed: {message}', { message: (error as Error).message }))
      return false
    }
  }

  private async afterReceipt(all: boolean): Promise<void> {
    // The receipt lists the messages still queued, which would run on their own: the others are already in the turn.
    const receipt = await this.q?.interrupt()
    if (Array.isArray(receipt?.still_queued)) {
      for (const uuid of this.pendingSteers) if (!receipt.still_queued.includes(uuid)) this.pendingSteers.delete(uuid)
      if (all) this.stopSurvivors = new Set([...this.pendingSteers])
    } else if (all) {
      const hadPending = this.pendingSteers.size > 0
      this.pendingSteers.clear()
      this.stopSurvivors.clear()
      if (hadPending && !this.implicitTurn) this.stopFirstUntil = Date.now() + IMPLICIT_TURN_MS
    }
    // Implicit turn not started yet: "send now" closes it to make room for the message (the pending ones stay and
    // merge into it). Stop closes it only if nothing is left in the queue; otherwise it stays open and stops what starts.
    if (this.idleImplicitTurn && (!all || this.pendingSteers.size === 0)) this.closeTurn('interrupted')
    if (!this.running && this.stopSurvivors.size === 0) this.resetStop()
  }

  private resetStop(): void {
    this.stopSurvivors.clear()
    this.stopFirstUntil = 0
    this.implicitStop = false
  }

  async setPermission(level: PermissionLevel): Promise<void> {
    // If the agent refuses, the error goes up: the saved level doesn't change.
    await this.q?.setPermissionMode(PERMISSION_MODE[level])
    // A session restart starts again from the new level.
    this.options.permission = level
  }

  async setEffort(effort: Effort): Promise<void> {
    // Applies from the next message; with a session not started yet, the saved choice is enough.
    this.options.effort = effort
    await this.q?.applyFlagSettings({ effortLevel: effort })
  }

  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model)
  }

  close(): void {
    if (this.bgTimer) clearTimeout(this.bgTimer)
    this.bgTimer = null
    this.input.close()
    this.abort.abort()
    this.pendingSteers.clear()
    this.resetStop()
    this.closeTurn('interrupted')
  }

  /** Closes the running turn, if any, and stops the implicit turn's timer. */
  private closeTurn(status: 'interrupted' | 'error', error: string | null = null): void {
    if (this.implicitTimer) clearTimeout(this.implicitTimer)
    this.implicitTimer = null
    if (this.running) this.finishTurn({ status, durationMs: Date.now() - this.turnStartedAt, costUsd: null, error, context: null })
  }

  /** Opens the turn for pending messages, waiting for the CLI to start; if it doesn't start, the timer closes it. */
  private armImplicit(): void {
    this.openImplicit()
    // Only a hint: if the CLI doesn't start, the timer closes the empty turn and clears the pending ones and the Stop;
    // if the CLI then starts, the safety net in handle() reopens it.
    this.implicitTimer = setTimeout(() => {
      this.implicitTimer = null
      if (!this.idleImplicitTurn) return
      this.pendingSteers.clear()
      this.stopSurvivors.clear()
      this.closeTurn('interrupted')
    }, IMPLICIT_TURN_MS)
  }

  /** Opens a turn the CLI started on its own (an inserted message that survived an interruption). */
  private openImplicit(): void {
    this.running = true
    this.interrupted = false
    this.commandTurn = false
    this.turnText = false
    this.implicitTurn = true
    this.implicitActive = false
    this.turnStartedAt = Date.now()
    const uuids = [...this.pendingSteers]
    // Stop applies to this turn only if it contains a survivor, or if it is the first after a Stop with no list.
    this.implicitStop = uuids.some((uuid) => this.stopSurvivors.has(uuid)) || Date.now() < this.stopFirstUntil
    if (Date.now() < this.stopFirstUntil) this.stopFirstUntil = 0
    this.events.turnStart?.(uuids)
    this.events.activity(t('Thinking…'))
  }

  private async loadAccount(): Promise<void> {
    if (!this.q) return
    try {
      const [account, models] = await Promise.all([this.q.accountInfo(), this.q.supportedModels()])
      this.events.account({
        account: claudeAccountLabel(account),
        email: account.email ?? null,
        models: claudeModels(models, readClaudeDefaults(this.options.configDir ?? null))
      })
    } catch {
      // Account information is a bonus: without it the session works anyway.
    }
  }

  private async loadCommands(): Promise<void> {
    if (!this.q) return
    try {
      this.setCommands(await this.q.supportedCommands())
    } catch {
      // Without the list the session works anyway.
    }
  }

  /** Replaces the list. Rows with the same name: Claude Code's wins, the one run by /name. */
  private setCommands(raw: SDKSlashCommand[]): void {
    const byName = new Map<string, SlashCommand>()
    for (const c of raw) {
      if (byName.has(c.name) && !c.builtin) continue
      byName.set(c.name, {
        name: c.name,
        description: c.description,
        hint: str(c.argumentHint),
        source: c.builtin ? 'builtin' : 'custom',
        ...(c.aliases?.length ? { aliases: c.aliases } : {})
      })
    }
    this.events.commands([...byName.values()])
  }

  private async consume(): Promise<void> {
    if (!this.q) return
    try {
      for await (const message of this.q) this.handle(message)
      this.pendingSteers.clear()
      this.resetStop()
      this.closeTurn('interrupted')
      this.events.exit(null)
    } catch (error) {
      const text = (error as Error).message
      this.pendingSteers.clear()
      this.resetStop()
      this.closeTurn('error', text)
      this.events.exit(this.abort.signal.aborted ? null : text)
    }
  }

  private handle(message: SDKMessage): void {
    const m = message as Block & { type: string }
    // Safety net: the main thread's output is never lost. If it arrives with no open turn
    // (inserted message that survived an interruption, API retry), one is opened.
    const main =
      !m.parent_tool_use_id && (m.type === 'assistant' || m.type === 'stream_event' || (m.type === 'system' && m.subtype === 'api_retry'))
    if (main && !this.running) {
      this.openImplicit()
      this.implicitActive = true
    }
    if (this.implicitTurn && !this.implicitActive && main) this.implicitActive = true
    if (main && this.implicitTurn) {
      if (this.implicitTimer) clearTimeout(this.implicitTimer)
      this.implicitTimer = null
      // Stop with surviving messages: their turn started, it stops at once.
      if (this.implicitStop && !this.interrupted) void this.interrupt(true)
    }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') this.events.init({ externalId: String(m.session_id), model: str(m.model), effort: asEffortLevel(m.effort) })
        else if (m.subtype === 'commands_changed') this.setCommands(m.commands as SDKSlashCommand[])
        else if (m.subtype === 'compact_boundary') {
          const meta = (m.compact_metadata ?? {}) as Block
          const postTokens = num(meta.post_tokens) ?? null
          if (postTokens !== null) this.lastMainUsed = postTokens
          this.events.compacted({ trigger: meta.trigger === 'auto' ? 'auto' : 'manual', preTokens: num(meta.pre_tokens) ?? null, postTokens })
        } else if (m.subtype === 'background_tasks_changed') this.syncBackground(m.tasks)
        else if (typeof m.subtype === 'string' && m.subtype.startsWith('task_')) this.handleTask(m)
        return
      case 'stream_event':
        if (m.parent_tool_use_id) return // sub-agent text: not shown for now
        this.handleStream(m.event as Block)
        return
      case 'assistant':
        if (m.parent_tool_use_id) this.handleSubagentAssistant(String(m.parent_tool_use_id), m.message as Block, str(m.agent_id))
        else this.handleAssistant(m.message as Block)
        return
      case 'user':
        this.handleLocalOutput(m.message as Block)
        this.handleToolResults(m.message as Block, m.parent_tool_use_id ? String(m.parent_tool_use_id) : null, m.tool_use_result)
        return
      case 'result':
        this.handleResult(m)
        return
      case 'rate_limit_event': {
        const info = (m.rate_limit_info ?? {}) as Block
        const window = claudeUsage(info)
        if (window) this.events.usage([window])
        if (info.status === 'rejected') {
          const reset = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }) : null
          this.events.notice('error', reset ? t('Usage limit reached: resets at {time}.', { time: reset }) : t('Usage limit reached.'))
        } else if (info.status === 'allowed_warning') {
          this.events.notice('info', t('You are getting close to your plan usage limit.'))
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
          this.events.activity(t('Writing the reply'))
        } else if (block?.type === 'thinking') {
          this.events.activity(t('Thinking…'))
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
    // The message with the same id comes back several times (one block at a time): the last wins.
    const u = message.usage as Block | undefined
    if (u) this.lastMainUsed = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0)
    const content = Array.isArray(message.content) ? (message.content as Block[]) : []
    content.forEach((block) => {
      if (block.type === 'text') {
        // The complete message arrives one block at a time: it closes the first text block still open.
        const id = this.openTextIds.shift() ?? `${messageId}:t${++this.textCounter}`
        if (String(block.text ?? '').trim()) this.turnText = true
        this.texts.set(id, String(block.text ?? ''))
        this.events.assistant(id, String(block.text ?? ''), false)
      } else if (block.type === 'tool_use') {
        const id = String(block.id)
        const name = String(block.name)
        const input = (block.input ?? {}) as Block
        this.toolInputs.set(id, { name, input })
        if (name === 'AskUserQuestion') return // becomes a question, not an activity row
        if (isAgentTool(name)) this.startSubagent(id, null, input)
        const described = describeTool(name, input, this.options.cwd)
        this.events.tool({ id, name, ...described, status: 'running', output: null })
        this.events.activity(described.title)
      }
    })
  }

  /** Message from a sub-agent: its tools become its activity, its Agents become children. */
  private handleSubagentAssistant(parentToolId: string, message: Block, agentId: string | null): void {
    // agent_id is the task_id, unchanged on resume: it leads to the original entry. A parent never seen creates no entries.
    const parent = (agentId && this.taskIds.get(agentId)) || (this.knowsAgent(parentToolId) ? this.taskIds.get(parentToolId) ?? parentToolId : null)
    if (!parent) return
    const content = Array.isArray(message?.content) ? (message.content as Block[]) : []
    const model = str(message?.model)
    let activity: string | null = null
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      const name = String(block.name)
      const input = (block.input ?? {}) as Block
      if (isAgentTool(name)) this.startSubagent(String(block.id), parent, input)
      const described = describeTool(name, input, this.options.cwd)
      activity = described.title
      this.subTools.set(String(block.id), { name, title: described.title, parent })
      this.events.subagent({ id: parent, tool: { id: String(block.id), name, title: described.title, status: 'running', at: Date.now() } })
    }
    const setModel = model && !this.modelKnown.has(parent)
    if (setModel) this.modelKnown.add(parent)
    if (activity || setModel) this.events.subagent({ id: parent, ...(activity ? { activity } : {}), ...(setModel ? { model } : {}) })
  }

  /**
   * background_tasks_changed: the complete set of live background tasks (replace semantics).
   * Background sub-agents that are gone and whose notification never arrived are treated as stopped.
   */
  private syncBackground(tasks: unknown): void {
    if (!Array.isArray(tasks)) return
    const live = new Set<string>()
    let background = 0
    let commands = 0
    for (const entry of tasks as Block[]) {
      const id = str(entry?.task_id)
      if (!id || entry.ambient === true) continue
      background++
      if (/bash|shell|monitor/.test(str(entry?.task_type) ?? '')) commands++
      if (entry?.task_type === 'local_agent' || entry?.task_type === 'remote_agent') live.add(id)
    }
    this.liveTasks = live
    this.liveBackground = background
    this.liveCommands = commands
    if (this.bgTimer || ![...this.bgTasks].some((task) => !live.has(task))) return
    // Only the tasks missing right now: if they are still absent when the grace period expires, they are finished.
    const missing = [...this.bgTasks].filter((task) => !live.has(task))
    this.bgTimer = setTimeout(() => {
      this.bgTimer = null
      for (const task of missing) {
        if (!this.bgTasks.has(task) || this.liveTasks?.has(task)) continue
        this.bgTasks.delete(task)
        const id = this.taskIds.get(task)
        if (!id || this.doneAgents.has(id)) continue
        this.doneAgents.add(id)
        this.events.subagent({ id, status: 'stopped' })
      }
    }, BG_GRACE_MS)
  }

  get hasBackgroundWork(): boolean {
    return this.liveBackground > 0
  }

  get onlyBackgroundCommands(): boolean {
    return this.liveBackground > 0 && this.liveCommands === this.liveBackground
  }

  /** Sub-agent entries in the last background_tasks_changed (null: never received): the host's safety net doesn't touch them. */
  liveAgentIds(): Set<string> | null {
    if (!this.liveTasks) return null
    return new Set([...this.liveTasks].map((task) => this.taskIds.get(task) ?? task))
  }

  /** Is parent_tool_use_id an agent we know (Agent tool_use, task or alias)? */
  private knowsAgent(id: string): boolean {
    return this.agentTools.has(id) || this.trackedTasks.has(id) || this.taskIds.has(id)
  }

  private linkTask(taskId: string, id: string): void {
    this.taskIds.delete(taskId)
    this.taskIds.set(taskId, id)
    while (this.taskIds.size > TASK_MAP_LIMIT) {
      const oldest = this.taskIds.keys().next().value!
      this.taskIds.delete(oldest)
      this.taskRuns.delete(oldest)
      this.bgTasks.delete(oldest)
    }
  }

  private startSubagent(id: string, parentId: string | null, input: Block): void {
    this.agentTools.add(id)
    const title = firstLine(str(input.description) ?? '', 80) || t('Subagent')
    const effort = str(input.effort)
    if (str(input.model)) this.modelKnown.add(id)
    if (str(input.description)) this.unlinkedAgents.set(id, str(input.description)!)
    this.events.subagent({
      id,
      parentId,
      toolId: id,
      title,
      kind: str(input.subagent_type),
      ...(str(input.model) ? { model: str(input.model) } : {}),
      ...(effort && EFFORTS.includes(effort as Effort) ? { effort: effort as Effort } : {}),
      ...(str(input.prompt) ? { prompt: str(input.prompt) } : {}),
      status: 'running',
      background: input.run_in_background === true
    })
  }

  /** SDK task_* events: start, progress with tokens and tools, end. Sub-agents only, not background commands. */
  private handleTask(m: Block): void {
    const taskId = String(m.task_id ?? '')
    if (!taskId) return
    // Message from a run earlier than the one shown (resume): late, ignored. Run ids sort as strings.
    const run = str(m.run_id)
    const seen = this.taskRuns.get(taskId)
    if (run && seen && run < seen) return
    if (run && m.subtype !== 'task_started' && this.taskIds.has(taskId)) this.taskRuns.set(taskId, run)
    if (m.subtype === 'task_started') {
      const type = str(m.task_type)
      const isAgent = type ? type === 'local_agent' || type === 'remote_agent' : Boolean(m.subagent_type)
      if (!isAgent || m.ambient === true || m.skip_transcript === true) return
      if (run) this.taskRuns.set(taskId, run)
      // Task already seen (or agentId from the Agent output): it is a resume, the entry is the same and goes back to running.
      const resumed = this.taskIds.get(taskId)
      const toolUse = resumed ? null : str(m.tool_use_id) ?? this.linkAgentTool(str(m.description))
      const id = resumed ?? toolUse ?? taskId
      this.unlinkedAgents.delete(id)
      this.linkTask(taskId, id)
      this.trackedTasks.add(id)
      this.doneAgents.delete(id)
      if (m.is_backgrounded === true) this.bgTasks.add(taskId)
      else this.bgTasks.delete(taskId)
      const parentTask = str(m.parent_task_id)
      const title = firstLine(str(m.description) ?? '', 80) || t('Subagent')
      this.events.subagent({
        id,
        ...(!resumed && parentTask && this.taskIds.has(parentTask) ? { parentId: this.taskIds.get(parentTask) } : {}),
        // On resume type and prompt stay those of the original entry, and so does the title (the board doesn't overwrite it).
        title,
        ...(str(m.subagent_type) && !resumed ? { kind: str(m.subagent_type) } : {}),
        ...(toolUse ? { toolId: toolUse } : {}),
        ...(str(m.prompt) && !resumed ? { prompt: str(m.prompt) } : {}),
        status: 'running',
        background: m.is_backgrounded === true
      })
      return
    }
    const id = this.taskIds.get(taskId)
    if (!id) return
    const usage = (m.usage ?? null) as Block | null
    const counts = usage ? { tokens: num(usage.total_tokens), toolUses: num(usage.tool_uses) } : {}
    if (m.subtype === 'task_progress') {
      const summary = str(m.summary)
      this.events.subagent({ id, ...counts, ...(summary ? { activity: firstLine(summary, 100) } : {}) })
    } else if (m.subtype === 'task_updated') {
      const patch = (m.patch ?? {}) as Block
      const status = patch.status === 'completed' ? 'done' : patch.status === 'failed' ? 'error' : patch.status === 'killed' ? 'stopped' : undefined
      if (status) {
        this.doneAgents.add(id)
        this.bgTasks.delete(taskId)
      }
      if (patch.is_backgrounded === true) this.bgTasks.add(taskId)
      this.events.subagent({ id, ...(status ? { status } : {}), ...(typeof patch.is_backgrounded === 'boolean' ? { background: patch.is_backgrounded } : {}) })
    } else if (m.subtype === 'task_notification') {
      const status = m.status === 'completed' ? 'done' : m.status === 'failed' ? 'error' : 'stopped'
      const summary = str(m.summary)
      const outputFile = str(m.output_file)
      this.doneAgents.add(id)
      this.bgTasks.delete(taskId)
      this.events.subagent({ id, status, ...counts, ...(summary ? { report: summary } : {}), ...(outputFile ? { outputFile } : {}) })
    }
  }

  /** task_started without tool_use_id: matches it to its Agent/Task only if the description matches exactly one. */
  private linkAgentTool(description: string | null): string | null {
    if (!description) return null
    const found = [...this.unlinkedAgents].filter(([, d]) => d === description)
    return found.length === 1 ? found[0][0] : null
  }

  /** Output of local commands (/context, /cost…): arrives as <local-command-stdout> in a user message. */
  private handleLocalOutput(message: Block): void {
    if (!this.commandTurn || this.turnText) return
    const content = message?.content
    const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? (content as Block[]).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')) : []
    for (const part of parts) {
      const found = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(part)
      const text = found?.[1].trim()
      if (!text) continue
      this.turnText = true
      this.events.assistant(`${this.currentMessageId ?? 'local'}:out${++this.textCounter}`, text, false)
      return
    }
  }

  private handleToolResults(message: Block, parent: string | null = null, toolUseResult: unknown = null): void {
    const content = Array.isArray(message?.content) ? (message.content as Block[]) : []
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const id = String(block.tool_use_id)
      this.unlinkedAgents.delete(id)
      // The agentId of the Agent output is an alias of the task: a resume with that task_id finds the entry.
      const agentId = this.agentTools.has(id) && toolUseResult && typeof toolUseResult === 'object' ? str((toolUseResult as Block).agentId) : null
      if (agentId && !this.taskIds.has(agentId)) this.linkTask(agentId, id)
      // End of a sub-agent without task_* events (older CLIs): told by the result of its Agent.
      if (this.agentTools.has(id) && !this.trackedTasks.has(id)) {
        this.events.subagent({ id, status: this.deniedTools.has(id) ? 'stopped' : block.is_error ? 'error' : 'done' })
        this.doneAgents.add(id)
      }
      // The Agent result's full text is the foreground report: it sits in the heavy buffer, beyond the row limit.
      if (this.agentTools.has(id) && !this.deniedTools.has(id) && !block.is_error) {
        const full = toolResultText(block.content)?.trim()
        if (full) this.events.subagent({ id, result: full.slice(0, 60_000) })
      }
      if (parent) {
        // The sub-agent tool's state: the title is the one already known.
        const inner = this.subTools.get(id)
        if (inner) this.events.subagent({ id: parent, tool: { id, name: inner.name, title: inner.title, status: this.deniedTools.has(id) ? 'denied' : block.is_error ? 'error' : 'done', at: Date.now() } })
        this.subTools.delete(id)
        continue // internal results of a sub-agent: not shown in the chat
      }
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
    if (!parent) this.events.activity(t('Thinking…'))
  }

  private handleResult(m: Block): void {
    const usage = (m.modelUsage ?? {}) as Record<string, Block>
    const main = Object.values(usage).sort((a, b) => Number(b.contextWindow ?? 0) - Number(a.contextWindow ?? 0))[0]
    // Fallback: the last message of the main loop, never m.usage (aggregated over the turn, the cache read counts N times).
    const window = main && Number(main.contextWindow) > 0 ? Number(main.contextWindow) : this.lastWindow
    const context = window && this.lastMainUsed !== null ? { used: this.lastMainUsed, window } : null
    void this.refreshContext()
    // The uuids consumed by the turn: the list, or the last message for CLIs that don't send it. With nothing we can't tell: no pending ones left hanging.
    if (Array.isArray(m.user_message_uuids)) for (const uuid of m.user_message_uuids as unknown[]) this.pendingSteers.delete(String(uuid))
    else this.pendingSteers.clear() // CLI without a list: messages inserted before the result were consumed
    const isError = m.subtype !== 'success' || m.is_error === true
    const status: TurnResult['status'] = this.interrupted ? 'interrupted' : isError ? 'error' : 'completed'
    // A command that ends with no assistant text (/context, /cost…): its result is the answer.
    if (this.commandTurn && !this.turnText && status === 'completed' && !isError && str(m.result)?.trim()) {
      this.turnText = true
      this.events.assistant(`result:${Date.now()}`, str(m.result)!.trim(), false)
    }
    // Result with no open turn: already closed by an interruption, or a turn with no output. Nothing to close.
    if (!this.running) {
      if (this.pendingSteers.size > 0) this.armImplicit()
      else this.resetStop()
      return
    }
    const errors = Array.isArray(m.errors) ? (m.errors as unknown[]).map(String).join('\n') : null
    this.finishTurn({
      status,
      durationMs: Number(m.duration_ms ?? Date.now() - this.turnStartedAt),
      costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null,
      error: status === 'error' ? errors || str(m.result) || t('The session stopped with an error.') : null,
      context
    })
    // Inserted messages not yet merged into a turn run on their own: the turn is already open for them, the output isn't discarded.
    if (this.pendingSteers.size > 0) this.armImplicit()
    else this.resetStop()
  }

  /**
   * Context as /context counts it: getContextUsage('summary') makes no counting calls.
   * Doesn't block the end of the turn: updates the context as soon as it answers, within a timeout.
   */
  private async refreshContext(): Promise<void> {
    const q = this.q
    if (!q) return
    const seq = ++this.contextSeq
    let timer: NodeJS.Timeout | undefined
    try {
      const usage = await Promise.race([
        q.getContextUsage({ detail: 'summary' }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 4000)
        })
      ])
      if (seq !== this.contextSeq || usage.totalTokens <= 0) return
      // The window is the one with which percentage = totalTokens / window: between maxTokens and rawMaxTokens
      // the types don't say, the one that reproduces the percentage is chosen (on a tie, maxTokens).
      const fit = (w: number): number => (w > 0 ? Math.abs((usage.totalTokens / w) * 100 - usage.percentage) : Infinity)
      const window = fit(usage.rawMaxTokens) < fit(usage.maxTokens) ? usage.rawMaxTokens : usage.maxTokens
      if (!(window > 0)) return
      this.lastWindow = window
      this.lastMainUsed = usage.totalTokens
      this.events.context?.({ used: usage.totalTokens, window, compactAt: usage.isAutoCompactEnabled ? usage.autoCompactThreshold : null })
    } catch {
      // Without it: the fallback computed at the end of the turn stays.
    } finally {
      clearTimeout(timer)
    }
  }

  private finishTurn(result: TurnResult): void {
    if (this.implicitTimer) clearTimeout(this.implicitTimer)
    this.implicitTimer = null
    this.implicitTurn = false
    this.implicitActive = false
    this.implicitStop = false
    this.running = false
    this.interrupted = false
    this.commandTurn = false
    this.turnText = false
    this.texts.clear()
    this.openTextIds = []
    this.events.activity(null)
    this.forgetFinishedAgents()
    this.events.turnEnd(result)
  }

  /** At the end of the turn the maps keep only the agents still alive (the background ones that will finish later); taskIds stays for resumes. */
  private forgetFinishedAgents(): void {
    for (const id of this.doneAgents) {
      this.agentTools.delete(id)
      this.trackedTasks.delete(id)
      this.unlinkedAgents.delete(id)
      this.modelKnown.delete(id)
      for (const [tool, sub] of this.subTools) if (sub.parent === id) this.subTools.delete(tool)
    }
    this.doneAgents.clear()
  }

  private async handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string; decisionReason?: string; toolUseID?: string }
  ): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') return this.handleQuestion(input, opts.signal)
    const described = describeTool(toolName, input, this.options.cwd)
    const options: RequestOption[] = [{ id: 'allow', label: t('Approve'), kind: 'allow' }]
    const suggestions = this.allowedSuggestions(opts.suggestions)
    if (suggestions.length) options.push({ id: 'always', label: t('Always allow'), kind: 'allow-always' })
    options.push({ id: 'deny', label: t('Deny'), kind: 'deny' })
    this.events.activity(t('Waiting for your approval'))
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
      return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions }
    const message = 'optionId' in response && response.message ? response.message : t('The user denied this action.')
    if (opts.toolUseID) {
      this.deniedTools.add(opts.toolUseID)
      this.unlinkedAgents.delete(opts.toolUseID)
    }
    return { behavior: 'deny', message }
  }

  /** Removes from the "Always allow" suggestions the mode changes beyond the session's level (never bypassPermissions unless it is Full access). */
  private allowedSuggestions(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] {
    const rank: Record<PermissionLevel, number> = { plan: 0, ask: 1, edit: 2, full: 3 }
    const limit = rank[this.options.permission]
    return (suggestions ?? []).filter((update) => {
      if (update.type !== 'setMode') return true
      const level = (Object.keys(PERMISSION_MODE) as PermissionLevel[]).find((l) => PERMISSION_MODE[l] === update.mode)
      return level !== undefined && rank[level] <= limit
    })
  }

  private async handleQuestion(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const raw = Array.isArray(input.questions) ? (input.questions as Block[]) : []
    const questions: Question[] = raw.map((q) => ({
      question: String(q.question ?? ''),
      header: str(q.header),
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? (q.options as Block[]) : []).map((o) => ({ label: String(o.label ?? ''), description: str(o.description) }))
    }))
    this.events.activity(t('Waiting for your answer'))
    const response = await this.events.request(
      { requestType: 'question', toolName: 'AskUserQuestion', title: questions[0]?.question ?? t('Question'), command: null, path: null, reason: null, options: [], questions },
      signal
    )
    this.events.activity(t('Thinking…'))
    if ('answers' in response) return { behavior: 'allow', updatedInput: { ...input, answers: response.answers } }
    return { behavior: 'deny', message: t('The user did not answer the question.') }
  }
}
