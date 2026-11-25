// Generic ACP adapter (Agent Client Protocol, SDK 2.4.0, protocol v1): an agent is just a configuration
// entry (command, arguments, environment). Rules from the spike: options reapplied after resume,
// open tool calls closed at the end of the turn, permission option names taken from the agent, diff computed by git.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { t } from '@shared/i18n'
import type { AcpAgentSpec, AgentLogin, Attachment, Effort, PermissionLevel, RequestOption } from '@shared/protocol'
import { agentEnv, BROWSER_MCP_NAME, LADDER_MCP_NAME, ladderDetail, clip, displayCommand, firstLine, whichInShell, type AdapterEvents, type AgentSession, type SessionOptions, type UserRequest } from '../agents/common'

/** API keys always removed: the agent's own login applies. */
export const STRIP_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']

export interface AcpOptions extends SessionOptions {
  spec: AcpAgentSpec
  /** What the protocol said about login (sign-in methods, session opened or auth_required): the host keeps it for the catalog. */
  onLogin?: (login: AgentLogin) => void
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

/** Agent mode closest to a Ladder level: names change from agent to agent. */
const MODE_PATTERNS: Record<PermissionLevel, RegExp[]> = {
  plan: [/plan/i, /read[-_ ]?only/i],
  ask: [/^default$/i, /ask|untrusted|manual/i, /read[-_ ]?only/i],
  edit: [/accept[-_ ]?edits|edit/i, /workspace[-_ ]?write/i, /^auto$|^agent$/i],
  full: [/bypass|full[-_ ]?access|yolo|dangerous/i]
}

/**
 * Sign-in methods declared in `initialize`, in the contract's shape. `agent` only if `type` is missing (it is ACP's default)
 * or is `agent`; `terminal` for terminal methods; any other type (e.g. `env_var`) is `unsupported`: Ladder can't do it and the
 * UI doesn't show it as "Sign in".
 */
function authMethodsOf(init: { authMethods?: acp.AuthMethod[] | null }): AgentLogin['methods'] {
  return (init.authMethods ?? []).map((m) => {
    const kind = (m as { type?: string }).type
    return { id: m.id, name: m.name, description: m.description ?? null, type: kind === undefined || kind === 'agent' ? ('agent' as const) : kind === 'terminal' ? ('terminal' as const) : ('unsupported' as const) }
  })
}

/** Maximum time for a sign-in: the agent may wait for the user in the browser. */
const AUTH_TIMEOUT_MS = 5 * 60_000

/**
 * Sign-in to an agent through its own `agent` method (ACP `authenticate`), outside a chat session: starts the agent, runs
 * `initialize` without client-side capabilities, calls `authenticate` and verifies with a test session (`session/new`,
 * without a prompt). Ladder neither sees nor touches the credentials: the agent manages them. The outcome is the login state:
 * `ready` if the session opens, `required` if the agent still asks to sign in (auth_required). A `terminal` or
 * `unsupported` method is never passed to `authenticate`. If the agent dies or doesn't start, the wait ends at once (not after 5 minutes);
 * `signal` cancels: the child stops and the promise fails with an AbortError. The child always stops when done (SIGKILL after 3 seconds).
 */
export async function acpAuthenticate(spec: AcpAgentSpec, methodId: string, cwd: string, signal?: AbortSignal, timeoutMs = AUTH_TIMEOUT_MS): Promise<AgentLogin> {
  const command = await whichInShell(spec.command)
  if (!command || (command.startsWith('/') && !existsSync(command))) throw new Error(t('command “{command}” not found', { command: spec.command }))
  signal?.throwIfAborted()
  const env = await agentEnv(STRIP_ENV, spec.env ?? {})
  // Stop can arrive while the environment is being prepared: without this check the agent would start anyway.
  signal?.throwIfAborted()
  const child = spawn(command, spec.args, { cwd, stdio: ['pipe', 'pipe', 'ignore'], env })
  child.on('error', () => undefined)
  let timedOut = false
  let timer: NodeJS.Timeout | undefined
  // On expiry the promise rejects by itself (an agent that ignores SIGTERM must not keep the sign-in busy); SIGKILL after one second.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      child.kill()
      setTimeout(() => child.kill('SIGKILL'), 1000).unref()
      reject(new Error(t('Sign-in timed out.')))
    }, timeoutMs)
  })
  timeout.catch(() => undefined)
  const onAbort = () => child.kill('SIGKILL')
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  // An agent that doesn't start, dies or is stopped interrupts every wait in progress.
  const gone = new Promise<never>((_, reject) => {
    child.once('error', (error) => reject(error))
    child.once('exit', () => reject(new Error(t('The agent stopped before signing in.'))))
  })
  gone.catch(() => undefined)
  const wait = <T>(request: Promise<T>): Promise<T> => Promise.race([request, gone, timeout])
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>)
  const connection = acp
    .client({ name: 'ladder' })
    .onRequest('*', ({ method }) => {
      throw acp.RequestError.methodNotFound(method)
    })
    .onNotification('*', () => undefined)
    .connect(stream)
  try {
    const init = await wait(
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'ladder', title: 'Ladder', version: '0.0.0' }
      })
    )
    const methods = authMethodsOf(init)
    const method = methods.find((m) => m.id === methodId)
    if (!method) throw new Error(t('This sign-in method is not available for the agent.'))
    if (method.type === 'terminal') throw new Error(t('Signing in through a terminal is not supported yet.'))
    if (method.type !== 'agent') throw new Error(t('This sign-in method is not supported by Ladder.'))
    await wait(connection.agent.request(acp.methods.agent.authenticate, { methodId }))
    try {
      await wait(connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }))
    } catch (error) {
      if ((error as { code?: number }).code === -32000) return { state: 'required', methods, checkedAt: Date.now() }
      throw error
    }
    return { state: 'ready', methods, checkedAt: Date.now() }
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error(t('Sign-in was cancelled.')), { name: 'AbortError' })
    if (timedOut) throw new Error(t('Sign-in timed out.'))
    // If the agent dies right away, the SDK sees the connection closed before the exit event: the host's message wins (not for protocol errors).
    if (typeof (error as { code?: unknown }).code !== 'number') {
      const stopped = await Promise.race([gone.then(() => null, (e: Error) => e), new Promise<null>((r) => setTimeout(() => r(null), 300))])
      if (stopped) throw stopped
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    connection.close()
    child.kill()
    // An agent that ignores SIGTERM must not stay alive: SIGKILL after a few seconds, if it is still there.
    if (child.exitCode === null && child.signalCode === null) setTimeout(() => child.kill('SIGKILL'), 3000).unref()
  }
}

/** Stops the process group of a program started `detached`: SIGTERM at once, SIGKILL after 3 seconds for whoever is left. */
function stopGroup(child: ChildProcess): void {
  const pid = child.pid
  const signal = (name: NodeJS.Signals): void => {
    try {
      if (pid) process.kill(-pid, name)
      else child.kill(name)
    } catch {
      // Group already gone.
    }
  }
  signal('SIGTERM')
  setTimeout(() => signal('SIGKILL'), 3000).unref()
}

/** Maximum time for a sign-in probe: a cold start of a CLI can be slow, but must not hang. */
const PROBE_TIMEOUT_MS = 25_000

/**
 * Sign-in probe: starts the agent, `initialize` and `session/new` in `cwd` without a prompt, then stops it. `ready` if the session
 * opens, `required` if it answers auth_required; any other error (doesn't start, timeout, doesn't speak ACP) is an exception: the outcome is unknown.
 * `NO_BROWSER=true` in the environment (even if the agent's entry says otherwise): a CLI like Gemini must not open the login page.
 * The environment is the one used for the other agents (without ANTHROPIC_*, CLAUDE* and API keys). It neither reads nor touches credential files.
 */
export async function acpProbe(spec: AcpAgentSpec, cwd: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<AgentLogin> {
  const command = await whichInShell(spec.command)
  if (!command || (command.startsWith('/') && !existsSync(command))) throw new Error(t('command “{command}” not found', { command: spec.command }))
  const env = await agentEnv(STRIP_ENV, { ...(spec.env ?? {}), NO_BROWSER: 'true' })
  // `detached`: the program leads its own process group, so at the end the grandchildren stop too (MCP servers, updates).
  const child = spawn(command, spec.args, { cwd, stdio: ['pipe', 'pipe', 'ignore'], env, detached: true })
  child.on('error', () => undefined)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(t('The agent did not answer in time.'))), timeoutMs)
  })
  timeout.catch(() => undefined)
  const gone = new Promise<never>((_, reject) => {
    child.once('error', (error) => reject(error))
    child.once('exit', () => reject(new Error(t('The agent stopped before answering.'))))
  })
  gone.catch(() => undefined)
  const wait = <T>(request: Promise<T>): Promise<T> => Promise.race([request, gone, timeout])
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>)
  const connection = acp
    .client({ name: 'ladder' })
    .onRequest('*', ({ method }) => {
      throw acp.RequestError.methodNotFound(method)
    })
    .onNotification('*', () => undefined)
    .connect(stream)
  try {
    const init = await wait(
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'ladder', title: 'Ladder', version: '0.0.0' }
      })
    )
    const methods = authMethodsOf(init)
    try {
      await wait(connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }))
    } catch (error) {
      if ((error as { code?: number }).code === -32000) return { state: 'required', methods, checkedAt: Date.now() }
      throw error
    }
    return { state: 'ready', methods, checkedAt: Date.now() }
  } finally {
    clearTimeout(timer)
    connection.close()
    stopGroup(child)
  }
}

/** Ladder MCP tool from the tool call title or, if the title does not say, from the input shape. */
function ladderToolName(title: string, raw: Record<string, unknown>): string | null {
  const named = /(list_agents|handoff|delegate|report_result)/.exec(title)
  if (named) return named[1]
  // Plan and session tools are not rendered as delegations, whatever shape their input has.
  if (/(propose_plan|revise_plan|ladder_(list_sessions|start_session|send|wait))/.test(title)) return null
  // Shape detection only for keys that exist in no plan or session tool: delegate's read_only and handoff's summary are unique,
  // and {agent, prompt} alone is also ladder_start_session, so it stays unknown (no wrong delegation row).
  if ('read_only' in raw && 'prompt' in raw) return 'delegate'
  if ('summary' in raw && 'agent' in raw) return 'handoff'
  if ('summary' in raw && 'status' in raw) return 'report_result'
  return null
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
  /** Open message or reasoning: ACP has no end-of-message event. */
  private open: { kind: 'message' | 'thought'; id: string; text: string } | null = null
  private counter = 0
  private tools = new Map<string, { title: string; kind: string; detail: string | null; output: string; status: string; name?: string }>()
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
    if (!command || (command.startsWith('/') && !existsSync(command))) throw new Error(t('command “{command}” not found', { command: spec.command }))
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
      // Extensions with "_" (for example the login state, with email and plan): ignored.
      .onNotification('*', () => undefined)
    this.connection = app.connect(stream)
    const agent = this.connection.agent

    // No client-side capabilities: the agents tried write and execute on their own.
    const init = await agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'ladder', title: 'Ladder', version: '0.0.0' }
    })
    const caps = (init.agentCapabilities ?? {}) as { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } }
    const methods = authMethodsOf(init)
    // The agent's browser, only if the agent declares MCP over http (initialize → mcpCapabilities); otherwise it is not registered and a notice is shown.
    const browser = this.options.browserTools
    const mcpHttp = (init.agentCapabilities as { mcpCapabilities?: { http?: boolean } } | undefined)?.mcpCapabilities?.http === true
    const ladder = this.options.ladderTools
    const mcpServers: acp.McpServer[] = mcpHttp
      ? [
          ...(browser ? [{ type: 'http' as const, name: BROWSER_MCP_NAME, url: browser.url, headers: [{ name: 'Authorization', value: `Bearer ${browser.token}` }] }] : []),
          // Ladder MCP server; without MCP over http the agent silently works without handoff or delegation.
          ...(ladder ? [{ type: 'http' as const, name: LADDER_MCP_NAME, url: ladder.url, headers: [{ name: 'Authorization', value: `Bearer ${ladder.token}` }] }] : [])
        ]
      : []
    if (browser && !mcpHttp) this.events.notice('info', t('{agent} cannot use the browser tools: it does not support MCP servers over HTTP.', { agent: spec.name }))
    let configOptions: ConfigOption[] | null | undefined
    try {
      if (this.sessionId && caps.sessionCapabilities?.resume) {
        const res = await agent.request(acp.methods.agent.session.resume, { sessionId: this.sessionId, cwd: this.options.cwd, mcpServers })
        configOptions = (res as { configOptions?: ConfigOption[] | null }).configOptions
      } else {
        // Without resume (or if the agent doesn't support it) a new session is opened: the history stays in Ladder.
        const res = await agent.request(acp.methods.agent.session.new, { cwd: this.options.cwd, mcpServers })
        this.sessionId = res.sessionId
        configOptions = res.configOptions
      }
    } catch (error) {
      // auth_required (-32000): the agent says sign-in is needed. It is the only case in which login counts as "required".
      if ((error as { code?: number }).code === -32000) {
        this.options.onLogin?.({ state: 'required', methods, checkedAt: Date.now() })
        throw new Error(t('{agent} needs you to sign in before it can start a session.', { agent: spec.name }))
      }
      throw error
    }
    this.options.onLogin?.({ state: 'ready', methods, checkedAt: Date.now() })
    this.config = configOptions ?? []
    // The agent's default is what it declares before Ladder applies its choices.
    const startModel = this.optionByCategory('model')
    const startThought = this.optionByCategory('thought_level')
    const defaultModel = startModel ? String(startModel.currentValue) : null
    const defaultThought = startThought ? flatten(startThought).find((v) => v.value === String(startThought.currentValue)) : undefined
    const defaultEffort = defaultThought ? (['low', 'medium', 'high', 'xhigh', 'max'] as const).find((e) => e === defaultThought.value.toLowerCase() || e === defaultThought.name.toLowerCase()) : undefined
    // Model, effort and mode don't survive a resume: they are always reapplied.
    await this.applyConfig()
    const models = this.optionByCategory('model')
    this.events.account({
      account: (init.agentInfo as { title?: string; name?: string; version?: string } | undefined)?.title ?? spec.name,
      models: models ? flatten(models).map((v) => ({ id: v.value, label: v.name, ...(v.value === defaultModel ? { isDefault: true, defaultEffort: defaultEffort ?? null } : {}) })) : [],
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

  /** Picks the level's mode option. With `strict`, if the agent has a mode option but no value matches, it is an error. */
  private async applyMode(strict: boolean): Promise<void> {
    const mode = this.optionByCategory('mode')
    // Read-only child session: without a mode that enforces it the agent would run in auto-edit, so it does not start.
    if (this.options.readOnly && !mode) throw new Error(t('{agent} has no plan or read-only mode, so it cannot run read-only.', { agent: this.options.spec.name }))
    let hit: SelectValue | undefined
    if (mode) {
      const values = flatten(mode)
      for (const pattern of MODE_PATTERNS[this.permission]) {
        hit = values.find((v) => pattern.test(v.value) || pattern.test(v.name))
        if (hit) break
      }
    }
    if (strict && mode && !hit) throw new Error(t('{agent} has no mode matching this permission level.', { agent: this.options.spec.name }))
    if (mode) await this.setOption(mode, hit?.value ?? null)
  }

  private async applyConfig(): Promise<void> {
    try {
      await this.setOption(this.optionByCategory('model'), this.model)
      const thought = this.optionByCategory('thought_level')
      if (thought && this.effort) {
        const match = flatten(thought).find((v) => v.value.toLowerCase() === this.effort || v.name.toLowerCase() === this.effort)
        await this.setOption(thought, match?.value ?? null)
      }
      if (!this.options.readOnly) await this.applyMode(false)
    } catch (error) {
      this.events.notice('info', t('{agent} did not accept the settings: {message}', { agent: this.options.spec.name, message: (error as Error).message }))
    }
    // Read-only: plan mode must really apply, a refusal fails the start (it is not just a warning).
    if (this.options.readOnly) await this.applyMode(true)
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

  /** For ACP a / command is a "/name arguments" prompt. */
  command(name: string, args: string): void {
    this.send(`/${name} ${args}`.trim())
  }

  async interrupt(): Promise<void> {
    // Open requests are closed with "cancelled", as the protocol requires.
    for (const controller of this.pending.values()) controller.abort()
    // Interrupted before the agent is ready: the cancel goes out as soon as the session exists.
    if (this.running && (!this.connection || !this.sessionId)) await this.ready?.catch(() => undefined)
    if (this.connection && this.sessionId) await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }).catch(() => undefined)
  }

  async setPermission(level: PermissionLevel): Promise<void> {
    const before = this.permission
    this.permission = level
    // During startup the configuration isn't there yet: we wait, then apply the level.
    if (!this.connection && this.ready) await this.ready.catch(() => undefined)
    if (!this.connection) return
    try {
      await this.applyMode(true)
    } catch (error) {
      // Rejected: the level stays what it was, and the error goes up to whoever asked for it.
      this.permission = before
      throw error
    }
  }

  async setModel(model: string): Promise<void> {
    this.model = model
    if (this.connection) await this.applyConfig()
  }

  async setEffort(effort: Effort): Promise<void> {
    this.effort = effort
    if (this.connection) await this.applyConfig()
  }

  close(): void {
    this.closed = true
    for (const controller of this.pending.values()) controller.abort()
    this.connection?.close()
    this.child?.kill('SIGTERM')
    this.child = null
  }

  // ── Session updates ───────────────────────────────────────────────────

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
        // Ladder server tools (title contains "ladder"): the input as JSON in detail.
        const ladderName = kind === 'other' && /ladder/i.test(u.title ?? '') ? ladderToolName(u.title ?? '', raw) : null
        const ladder = ladderName ? ladderDetail(raw, ladderName) : null
        const tool = { title: u.title || command || kind, kind, detail: ladder ?? command ?? location, output: '', status: u.status ?? 'pending', ...(ladderName ? { name: `${LADDER_MCP_NAME}.${ladderName}` } : {}) }
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
      case 'available_commands_update':
        this.events.commands(
          u.availableCommands.map((c) => ({
            name: c.name.replace(/^\//, ''),
            description: c.description,
            hint: c.input?.hint?.trim() || null,
            source: 'custom' as const
          }))
        )
        return
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
    // Output of non-standard commands (for example _meta.terminal_output_delta from codex-acp).
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
    this.events.tool({ id, tool: category, name: tool.name ?? tool.kind, title: firstLine(tool.title), detail: tool.detail, status, output: clip(tool.output) })
  }

  private async onPermission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    this.closeOpen()
    const call = params.toolCall
    const known = this.tools.get(call.toolCallId)
    const raw = (call.rawInput ?? {}) as Record<string, unknown>
    const command = displayCommand(typeof raw.command === 'string' ? raw.command : Array.isArray(raw.command) ? shellJoin(raw.command as string[]) : null) ?? (known?.kind === 'execute' ? known.detail : null)
    const diff = this.diffs.get(call.toolCallId) ?? (call.content ?? []).filter((c): c is Extract<acp.ToolCallContent, { type: 'diff' }> => c.type === 'diff').map((c) => ({ path: c.path, oldText: c.oldText ?? null, newText: c.newText }))[0]
    // The option names are the agent's own: the meaning of a refusal changes from agent to agent.
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
    // After a refusal or a cancellation the tool calls stay "in progress": Ladder closes them.
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

/** Text before and after → lines - and + (naive diff for the card preview). */
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

/** A command's arguments recomposed as you would type them in the shell. */
function shellJoin(args: string[]): string {
  return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ')
}
