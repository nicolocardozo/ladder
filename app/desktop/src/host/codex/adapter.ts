// Codex adapter on `codex app-server` (JSON-RPC over stdio), with the rules from the spike:
// explicit effort and service tier on every turn, plan mode enabled on thread/start, items left open
// closed at the end of the turn, deltas from old turns discarded, process restarted if a command survives the interruption.
import { realpathSync } from 'node:fs'
import { relative } from 'node:path'
import { t } from '@shared/i18n'
import type { Attachment, Effort, PermissionLevel, Question, RequestOption, RequestResponse, SlashCommand } from '@shared/protocol'
import { agentInstructions, BROWSER_MCP_NAME, LADDER_MCP_NAME, ladderDetail, clip, displayCommand, firstLine, type AdapterEvents, type AgentSession, type SessionOptions, type UserRequest } from '../agents/common'
import { accountEmail, accountLabel, codexEnv, describeLimits, codexModels, describeUsage, parseModels, type CodexModel } from './environment'
import { CodexRpc, type ServerReply, type ServerRequest } from './rpc'

export interface CodexOptions extends SessionOptions {
  cli: string
  version: string
  /** JSON schema of the final answer (for review: structured comments). */
  outputSchema?: unknown
}

/** Window after a Stop in which a turn/started with no host turn is taken as the turn just stopped. */
const STOP_WINDOW_MS = 15_000

type Policy = { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> }

/** Ladder levels → Codex approval policy and sandbox. */
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

/** Approval options: labels in the current language, so computed on every request. */
function approveOptions(): RequestOption[] {
  return [
    { id: 'accept', label: t('Approve'), kind: 'allow' },
    { id: 'acceptForSession', label: t('Allow for this session'), kind: 'allow-always' },
    { id: 'decline', label: t('Deny'), kind: 'deny' }
  ]
}

/** Past this time without a reply, a /compact with no turn ends with an error. */
const COMPACT_TIMEOUT_MS = 180_000

/** Commands Codex always has, with or without a process: skills are added once it is started. */
export function codexFixedCommands(): SlashCommand[] {
  return [
    { name: 'compact', description: t('Summarize the conversation to free up context'), hint: null, source: 'builtin' },
    { name: 'review', description: t('Review your uncommitted changes, or follow your instructions'), hint: t('Optional review instructions'), source: 'builtin' }
  ]
}

export class CodexSession implements AgentSession {
  private rpc: CodexRpc | null = null
  private ready: Promise<void> | null = null
  private threadId: string | null
  /** Threads of sub-agents started with spawnAgent: their events go to the map, not to the chat. */
  private subThreads = new Set<string>()
  /** Sub-agent thread → id of the collab item (the tool row in chat) that started it. */
  private threadItems = new Map<string, string>()
  private subToolUses = new Map<string, number>()
  private turnId: string | null = null
  private running = false
  private interrupted = false
  /** Instant of the last Stop: a turn/started right after it is the stopped turn, not a resume on its own. */
  private stopAt = 0
  private turnStartedAt = 0
  private permission: PermissionLevel
  private model: string | null
  private models: CodexModel[] = []
  private texts = new Map<string, string>()
  private items = new Map<string, OpenItem>()
  private context: { used: number; window: number } | null = null
  /** Open server requests: they close when Codex resolves them itself (end of turn). */
  private requests = new Map<string, AbortController>()
  private closed = false
  /** thread/compact/start in progress: the end is the contextCompaction item. */
  private compacting = false
  /** /compact launched by Ladder: survives finishTurn, so a late 'compacted' stays manual. */
  private manualCompact = false
  private compactTimer: NodeJS.Timeout | null = null
  /** Texts (trimmed) of the agentMessages closed in the turn and text of the review already shown: they avoid duplicates. */
  private doneTexts = new Set<string>()
  /** Review already shown by exitedReviewMode (row id and text) and review deferred while an agentMessage is open. */
  private reviewShown: { id: string; text: string } | null = null
  private reviewPending: { id: string; text: string } | null = null
  /** Number of the turn started by begin(): async actions from an old turn stop. */
  private turnSeq = 0
  /** Skill loading in progress: skill commands wait for it. */
  private skillsReady: Promise<void> | null = null
  /** A command list has already been emitted: after a restart we don't fall back to the fixed ones only. */
  private commandsKnown = false
  /** Agent skills: name → path, which turn/start needs to invoke them. */
  private skills = new Map<string, string>()
  private readonly cwd: string

  constructor(
    private readonly options: CodexOptions,
    private readonly events: AdapterEvents
  ) {
    this.threadId = options.resume
    this.permission = options.permission
    this.model = options.model
    // On macOS /var becomes /private/var: Codex compares exact paths.
    let cwd = options.cwd
    try {
      cwd = realpathSync(options.cwd)
    } catch {
      // The folder may no longer exist: the error comes from Codex.
    }
    this.cwd = cwd
  }

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    // Fixed commands don't wait for the process: they are there even if skills/list fails or doesn't answer.
    if (!this.commandsKnown) {
      this.commandsKnown = true
      this.events.commands(codexFixedCommands())
    }
    this.ready = this.boot()
    this.ready.catch((error: Error) => this.events.notice('error', t('{agent} failed to start: {message}', { agent: 'Codex', message: error.message })))
  }

  private async boot(): Promise<void> {
    const rpc = new CodexRpc(
      this.options.cli,
      await codexEnv(this.options.configDir ?? null),
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
    this.skillsReady = this.loadSkills(rpc)
    const policy = policyFor(this.permission, this.cwd)
    const common = {
      cwd: this.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(this.model ? { model: this.model } : {}),
      // The agent's browser as an http MCP server; the policy (confirmations, level) belongs to the server, so Codex doesn't ask a second time.
      config: {
        'tools.update_plan.enabled': true,
        ...(this.options.browserTools
          ? {
              [`mcp_servers.${BROWSER_MCP_NAME}.url`]: this.options.browserTools.url,
              [`mcp_servers.${BROWSER_MCP_NAME}.http_headers`]: { Authorization: `Bearer ${this.options.browserTools.token}` },
              [`mcp_servers.${BROWSER_MCP_NAME}.default_tools_approval_mode`]: 'approve',
              // Default 60 s: a user confirmation (up to 10 minutes in the server) would make the call time out.
              [`mcp_servers.${BROWSER_MCP_NAME}.tool_timeout_sec`]: 660
            }
          : {}),
        // Ladder MCP server. A delegation lasts as long as the other agent's work (up to an hour); the server asks for handoff confirmation.
        ...(this.options.ladderTools
          ? {
              [`mcp_servers.${LADDER_MCP_NAME}.url`]: this.options.ladderTools.url,
              [`mcp_servers.${LADDER_MCP_NAME}.http_headers`]: { Authorization: `Bearer ${this.options.ladderTools.token}` },
              [`mcp_servers.${LADDER_MCP_NAME}.default_tools_approval_mode`]: 'approve',
              [`mcp_servers.${LADDER_MCP_NAME}.tool_timeout_sec`]: 3600
            }
          : {})
      }
    }
    const result = this.threadId
      ? await rpc.request<{ thread: { id: string }; model: string }>('thread/resume', { threadId: this.threadId, excludeTurns: true, ...common })
      : await rpc.request<{ thread: { id: string }; model: string }>('thread/start', {
          ...common,
          // Only on a new thread: a resumed thread keeps the instructions it was born with (and a later permission change doesn't alter them).
          developerInstructions: agentInstructions(this.options.autonomyHint && (this.permission === 'edit' || this.permission === 'full'), this.options.delegateHint)
        })
    this.threadId = result.thread.id
    this.events.init({ externalId: result.thread.id, model: this.model ?? result.model ?? null })
  }

  private async loadAccount(rpc: CodexRpc): Promise<void> {
    try {
      const account = await rpc.request<{ account: Record<string, unknown> | null }>('account/read', { refreshToken: false }, 15000)
      this.models = parseModels(await rpc.request('model/list', {}, 15000))
      let limits: string | null = null
      try {
        const data = await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }, 15000)
        limits = describeLimits(data)
        this.events.usage(describeUsage(data))
      } catch {
        limits = null
      }
      this.events.account({ account: accountLabel(account.account), email: accountEmail(account.account), models: codexModels(this.models, this.options.configDir ?? null), limits })
    } catch {
      // Without account and models the session works anyway.
    }
  }

  send(text: string, attachments: Attachment[] = []): void {
    this.begin(() =>
      this.startTurn([
        ...attachments.map((a) => ({ type: 'image', url: `data:${a.mediaType};base64,${a.data}` })),
        { type: 'text', text, text_elements: [] }
      ])
    )
  }

  /** Inserts a message into the running turn (turn/steer). False if it can't: the host queues it. */
  async steer(text: string, attachments: Attachment[] = []): Promise<boolean> {
    if (!this.running || this.interrupted || this.compacting || !this.rpc || !this.threadId || !this.turnId) return false
    try {
      await this.rpc.request(
        'turn/steer',
        {
          threadId: this.threadId,
          expectedTurnId: this.turnId,
          input: [...attachments.map((a) => ({ type: 'image', url: `data:${a.mediaType};base64,${a.data}` })), { type: 'text', text, text_elements: [] }]
        },
        10000
      )
      return true
    } catch (error) {
      // Only the timeout is ambiguous: it may have gone in, and queuing it would duplicate it. Every other error is a refusal.
      if ((error as Error).message !== t('Codex did not respond to {method}.', { method: 'turn/steer' })) return false
      this.events.notice('error', t('Codex did not confirm the message. It may not have reached the running turn.'))
      return true
    }
  }

  /** compact and review have their own request; skills are a turn with the "skill" input. */
  command(name: string, args: string): void {
    if (name === 'compact') {
      this.begin(async () => {
        this.compacting = true
        this.manualCompact = true
        // Safety net: if Codex doesn't confirm the compaction, the command doesn't hang.
        this.compactTimer = setTimeout(() => {
          if (!this.compacting || this.turnId) return
          this.manualCompact = false
          this.finishTurn({ status: 'error', error: t('Compaction timed out.') })
        }, COMPACT_TIMEOUT_MS)
        await this.rpc!.request('thread/compact/start', { threadId: this.threadId })
      })
    } else if (name === 'review') {
      this.begin(async () => {
        const target = args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' }
        const result = await this.rpc!.request<{ turn: { id: string } }>('review/start', { threadId: this.threadId, target, delivery: 'inline' })
        this.turnId ??= result.turn.id
      })
    } else {
      this.begin(async (live) => {
        // Skills are looked up once Codex is ready, after the list has loaded.
        await this.skillsReady
        if (!live()) return
        const path = this.skills.get(name)
        if (!path) throw new Error(t('Unknown command: /{name}', { name }))
        await this.startTurn([
          { type: 'text', text: `$${name} ${args}`.trim(), text_elements: [] },
          { type: 'skill', name, path }
        ])
      })
    }
  }

  /** Marks the start of a turn and launches the action when Codex is ready. */
  private begin(action: (live: () => boolean) => Promise<void>): void {
    const seq = ++this.turnSeq
    const live = (): boolean => seq === this.turnSeq && this.running && !this.interrupted
    this.running = true
    this.interrupted = false
    this.turnStartedAt = Date.now()
    this.turnId = null
    this.doneTexts.clear()
    this.reviewShown = null
    this.reviewPending = null
    this.events.activity(t('Thinking…'))
    void (async () => {
      try {
        if (!this.ready) this.start()
        await this.ready
        if (!live()) return
        await action(live)
      } catch (error) {
        this.finishTurn({ status: 'error', error: (error as Error).message })
      }
    })()
  }

  private async startTurn(input: unknown[]): Promise<void> {
    const policy = policyFor(this.permission, this.cwd)
    const effort = this.effortFor()
    const result = await this.rpc!.request<{ turn: { id: string } }>('turn/start', {
      threadId: this.threadId,
      input,
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: policy.sandboxPolicy,
      ...(this.model ? { model: this.model } : {}),
      ...(effort ? { effort } : {}),
      // The "priority" tier uses double the quota: never inherit it from the configuration.
      serviceTierForTurn: 'default',
      ...(this.options.outputSchema ? { outputSchema: this.options.outputSchema } : {})
    })
    this.turnId ??= result.turn.id
  }

  /** Agent skills for this folder: reloaded on skills/changed. */
  private async loadSkills(rpc: CodexRpc): Promise<void> {
    try {
      type Skill = { name: string; description: string; shortDescription?: string; interface?: { shortDescription?: string }; path: string; enabled: boolean }
      const reply = await rpc.request<{ data: { skills: Skill[] }[] }>('skills/list', { cwds: [this.cwd] }, 15000)
      if (this.rpc !== rpc) return
      this.skills.clear()
      const fixed = codexFixedCommands()
      const found: SlashCommand[] = []
      for (const skill of reply.data.flatMap((entry) => entry.skills)) {
        if (!skill.enabled || this.skills.has(skill.name) || fixed.some((c) => c.name === skill.name)) continue
        this.skills.set(skill.name, skill.path)
        found.push({ name: skill.name, description: skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description, hint: null, source: 'skill' })
      }
      this.commandsKnown = true
      this.events.commands([...fixed, ...found])
    } catch {
      // Without skills, compact and review remain.
    }
  }

  /** Ladder's effort applies only if the model supports it; otherwise Codex decides. */
  private effortFor(): string | null {
    const effort = this.options.effort
    if (!effort) return null
    const model = this.models.find((m) => m.id === this.model) ?? this.models.find((m) => m.isDefault)
    if (!model || model.efforts.length === 0) return effort
    return model.efforts.includes(effort) ? effort : null
  }

  async interrupt(): Promise<void> {
    this.interrupted = true
    // Only a Stop with a turn/start still in flight (no turnId) can cause a turn/started to discard.
    this.stopAt = this.turnId ? 0 : Date.now()
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
    // Applies from the next turn: Codex accepts policy and sandbox in turn/start.
    this.permission = level
  }

  async setModel(model: string): Promise<void> {
    this.model = model
  }

  async setEffort(effort: Effort): Promise<void> {
    // Codex gets the effort on every turn.
    this.options.effort = effort
  }

  close(): void {
    this.closed = true
    if (this.compactTimer) clearTimeout(this.compactTimer)
    this.compactTimer = null
    for (const controller of this.requests.values()) controller.abort()
    this.requests.clear()
    this.rpc?.kill()
    this.rpc = null
  }

  // ── Events from Codex ────────────────────────────────────────────────────

  private isCurrent(params: Record<string, unknown>): boolean {
    // After an interruption a command left alive keeps sending output with the old turn.
    return !params.turnId || !this.turnId || params.turnId === this.turnId
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    // Events from another thread (a sub-agent): they don't touch the session's turn.
    const thread = typeof params.threadId === 'string' ? params.threadId : null
    if (thread && this.threadId && thread !== this.threadId && method !== 'serverRequest/resolved') {
      if (this.subThreads.has(thread)) this.onSubagentNotification(thread, method, params)
      return
    }
    switch (method) {
      case 'turn/started':
        this.turnId = ((params.turn as { id?: string }) ?? {}).id ?? this.turnId
        // Main-thread turn we didn't open (resumed on its own after the sub-agents): the host opens an implicit one.
        if (!this.running && !this.closed) {
          // Right after a Stop it is the turn the user just stopped, restarted late: it is interrupted, not shown.
          if (this.interrupted && this.stopAt > 0 && Date.now() - this.stopAt < STOP_WINDOW_MS && this.rpc && this.threadId && this.turnId) {
            void this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 10000).catch(() => undefined)
          } else this.openImplicit()
        }
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
        // If this is the start of the review already shown, the row exists: no second streaming row.
        if (this.reviewShown?.text.startsWith(text.trim())) return
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
        // Codex closed a request itself (for example at the end of the turn): the card becomes "expired".
        const key = String(params.requestId ?? '')
        this.requests.get(key)?.abort()
        this.requests.delete(key)
        return
      }
      case 'error': {
        const error = params.error as { message?: string } | undefined
        if (params.willRetry) this.events.activity(t('Retrying…'))
        else if (this.compacting && !this.turnId) {
          this.manualCompact = false
          this.finishTurn({ status: 'error', error: error?.message ?? t('Compaction failed.') })
        }
        else if (error?.message) this.events.notice('error', `Codex: ${error.message}`)
        return
      }
      case 'turn/completed': {
        const turn = (params.turn ?? {}) as { id?: string; status?: string; error?: { message?: string } | null; durationMs?: number | null }
        if (this.turnId && turn.id && turn.id !== this.turnId) return
        const status = turn.status === 'failed' ? 'error' : turn.status === 'interrupted' || this.interrupted ? 'interrupted' : 'completed'
        this.finishTurn({ status, error: turn.error?.message ?? null, durationMs: turn.durationMs ?? undefined })
        // A command alive after the interruption: the process restarts, the thread resumes at the next message.
        if (status === 'interrupted' && [...this.items.values()].some((i) => i.kind === 'command')) this.restart()
        return
      }
      case 'skills/changed':
        if (this.rpc) void this.loadSkills(this.rpc)
        return
      case 'account/rateLimits/updated':
        this.events.usage(describeUsage(params))
        return
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
        // Ladder server tools: the input as JSON in detail (the UI derives the title from it).
        const detail = item.server === LADDER_MCP_NAME ? ladderDetail(item.arguments, String(item.tool)) : null
        this.items.set(id, { kind: 'mcp', title, detail, output: '', diff: null, paths: [] })
        this.events.tool({ id, tool: 'other', name, title, detail, status: 'running', output: null })
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

  /** spawnAgent, wait, closeAgent…: new sub-agents enter the map, known states update it. */
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
        // The tool row in chat exists only for the session's own spawns: nested ones don't have one.
        if (!parentId) this.threadItems.set(thread, id)
        const effort = typeof item.reasoningEffort === 'string' ? item.reasoningEffort : null
        this.events.subagent({
          id: thread,
          parentId,
          ...(!parentId ? { toolId: id } : {}),
          // The title is what makes the entry appear: without a prompt, the generic one.
          ...(prompt ? { title: firstLine(prompt, 80), prompt } : { title: t('Subagent') }),
          ...(typeof item.model === 'string' ? { model: item.model } : {}),
          ...(effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? { effort: effort as Effort } : {}),
          status: 'running'
        })
      }
      if (started && !parentId) {
        const title = t('Subagent: {task}', { task: firstLine(prompt ?? t('task'), 60) })
        this.items.set(id, { kind: 'agent', title, detail: prompt, output: '', diff: null, paths: [] })
        this.events.tool({ id, tool: 'agent', name: 'spawn_agent', title, detail: prompt, status: 'running', output: null })
      }
    }
    const states = (item.agentsStates ?? {}) as Record<string, { status?: string; message?: string | null } | undefined>
    for (const [thread, state] of Object.entries(states)) {
      const status = collabStatus(state?.status)
      if (!status || !this.subThreads.has(thread)) continue
      const toolId = this.threadItems.get(thread)
      const message = status !== 'running' && typeof state?.message === 'string' && state.message.trim() ? state.message : null
      this.events.subagent({ id: thread, status, ...(toolId ? { toolId } : {}), ...(message ? { report: message } : {}) })
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
      title: path ?? t('Subagent'),
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
        this.events.subagent({
          id: thread,
          activity,
          toolUses: uses,
          ...(item.type === 'reasoning' ? {} : { tool: { id: String(item.id ?? `${thread}:${uses}`), name: String(item.type), title: activity, status: 'running' as const, at: Date.now() } })
        })
        return
      }
      case 'item/completed': {
        const item = (params.item ?? {}) as Record<string, unknown>
        if (item.type === 'reasoning' || typeof item.id !== 'string') return
        const activity = this.describeItem(item)
        if (!activity) return
        const failed = item.status === 'failed' || item.status === 'declined'
        this.events.subagent({ id: thread, tool: { id: item.id, name: String(item.type), title: activity, status: failed ? 'error' : 'done', at: Date.now() } })
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

  /** Short line for a sub-agent's activity: like the titles of chat rows. */
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
    if (item.type === 'contextCompaction') {
      // Compaction requested by us is manual; the one Codex does by itself mid-turn is automatic.
      this.events.compacted({ trigger: this.manualCompact ? 'manual' : 'auto', preTokens: null, postTokens: null })
      this.manualCompact = false
      // Without a turn of its own (no turn/started) the end of compaction closes the command.
      const closes = this.compacting && !this.turnId
      this.compacting = false
      if (closes) this.finishTurn({ status: 'completed', error: null })
      return
    }
    if (item.type === 'exitedReviewMode') {
      // The review result arrives here, as agent text, unless it is already in chat as an agentMessage.
      const review = String(item.review ?? '').trim()
      if (!review || this.doneTexts.has(review)) return
      // An open agentMessage may be the review itself: decided when it closes.
      if (this.texts.size > 0) this.reviewPending = { id, text: review }
      else this.showReview(id, review)
      return
    }
    if (item.type === 'agentMessage') {
      const text = String(item.text ?? this.texts.get(id) ?? '')
      this.texts.delete(id)
      this.doneTexts.add(text.trim())
      // Review already shown with the same text: that row is finalized, without duplicating it.
      if (this.reviewShown && text.trim() === this.reviewShown.text) this.events.assistant(this.reviewShown.id, text, false)
      else this.events.assistant(id, text, false)
      const pending = this.reviewPending
      if (pending && this.texts.size === 0) {
        this.reviewPending = null
        if (!this.doneTexts.has(pending.text)) this.showReview(pending.id, pending.text)
      }
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

  /** Opens a turn Codex started on its own: the host shows it as an implicit turn. */
  private openImplicit(): void {
    this.running = true
    this.interrupted = false
    this.turnStartedAt = Date.now()
    this.doneTexts.clear()
    this.reviewShown = null
    this.reviewPending = null
    this.events.turnStart?.([])
    this.events.activity(t('Thinking…'))
  }

  private showReview(id: string, text: string): void {
    this.reviewShown = { id, text }
    this.events.assistant(id, text, false)
  }

  private finishTurn(result: { status: 'completed' | 'interrupted' | 'error'; error: string | null; durationMs?: number }): void {
    if (!this.running) return
    this.running = false
    this.compacting = false
    if (this.compactTimer) clearTimeout(this.compactTimer)
    this.compactTimer = null
    for (const controller of this.requests.values()) controller.abort()
    this.requests.clear()
    // Messages left without item/completed (steer, interruption) are closed with the text received.
    for (const [id, text] of this.texts) {
      const trimmed = text.trim()
      // Fragment of the review already shown (same check as the deltas): no half row is left.
      if (this.reviewShown?.text.startsWith(trimmed)) {
        if (trimmed === this.reviewShown.text) this.events.assistant(this.reviewShown.id, text, false)
        this.doneTexts.add(trimmed)
        continue
      }
      this.doneTexts.add(trimmed)
      this.events.assistant(id, text, false)
    }
    this.texts.clear()
    // Review deferred and never matched by a message: it is shown now.
    if (this.reviewPending && !this.doneTexts.has(this.reviewPending.text)) this.showReview(this.reviewPending.id, this.reviewPending.text)
    this.reviewPending = null
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

  // ── Codex requests: approvals and questions ──────────────────────────────

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
              ...(open?.paths.length ? { paths: open.paths } : {}),
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
        // An MCP server asks for confirmation (tool approval): same card as permissions. Forms with fields: refused.
        case 'mcpServer/elicitation/request': {
          const server = String(params.serverName ?? 'MCP')
          // A form with fields can't be filled in from here: refused at once, no card.
          if (params.mode === 'form') return { result: { action: 'decline', content: null, _meta: null } }
          const message = typeof params.message === 'string' ? params.message : ''
          const response = await this.events.request(
            { requestType: 'permission', toolName: `mcp:${server}`, title: t('Uses {tool}', { tool: server }), command: null, path: null, reason: message || null, options: approveOptions(), questions: null },
            controller.signal
          )
          return { result: { action: this.decision(response) !== 'decline' ? 'accept' : 'decline', content: null, _meta: null } }
        }
        default:
          return { error: { code: -32601, message: t('Ladder does not handle {method}', { method: request.method }) } }
      }
    } finally {
      this.requests.delete(key)
    }
  }

  /** Decision for Codex; a refusal with a message also arrives as an instruction to the running turn. */
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

/** Unified diff from Codex → - and + lines for the card (like Claude Code's preview). */
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
