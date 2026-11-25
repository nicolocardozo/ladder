// `ladder_*` MCP tools: a session (Claude, Codex, ACP) starts another Ladder session with another agent,
// sends it messages and waits for its answer. They live on the `ladder` MCP server that every chat already has (ladder-mcp.ts).
// Rules: children never exceed the permission level of their starter or the project maximum; you can only send to and wait on
// sessions started by the caller (grandchildren included); maximum depth 2, at most 5 children working and 20 starts per hour.
// No path aliases: scripts/cli.test.mts exercises it with a fake. Texts are for the agent (English); only the approval card,
// which the user sees, goes through `t`.
import type { PlanRules } from '../shared/plan'
import { permissionRank } from '../shared/plan.ts'
import type { AgentId, Effort, PermissionLevel, SessionSummary, SessionWaitResult } from '../shared/protocol'

export type Origin = NonNullable<SessionSummary['origin']>
export type AgentTool = 'ladder_list_sessions' | 'ladder_start_session' | 'ladder_send' | 'ladder_wait'
export const AGENT_TOOLS: ReadonlySet<string> = new Set<AgentTool>(['ladder_list_sessions', 'ladder_start_session', 'ladder_send', 'ladder_wait'])

export const AGENT_LIMITS = { depth: 2, running: 5, perHour: 20, waitSec: 600, waitDefaultSec: 300, text: 50_000 }

export interface SessionInfo {
  sessionId: string
  projectId: string
  agent: AgentId
  permission: PermissionLevel
  origin: Origin | null
  /** Chat session (not a terminal) and not archived. */
  usable: boolean
}

export interface ListedSession {
  id: string
  title: string
  agent: AgentId
  model: string | null
  /** Session state: idle, running, waiting, error. */
  state: string
  origin: Origin | null
  /** Where it works and on which branch: the caller knows where to look for the changes. */
  cwd: string | null
  branch: string | null
}

export interface StartSpec {
  callerId: string
  projectId: string
  agent: AgentId
  prompt: string
  model: string | null
  effort: Effort | null
  permission: PermissionLevel
  worktree: boolean
  title: string | null
  origin: Origin
}

export interface AgentSessionsDeps {
  now(): number
  t(text: string, vars?: Record<string, string | number>): string
  info(sessionId: string): SessionInfo | null
  rules(projectId: string): Promise<PlanRules>
  /** The project is a git repository (a worktree is possible). */
  isGit(projectId: string): boolean
  list(projectId: string): ListedSession[]
  start(spec: StartSpec): Promise<{ sessionId: string; cwd: string | null; branch: string | null }>
  send(sessionId: string, text: string): Promise<void>
  wait(sessionId: string, timeoutMs: number, signal: AbortSignal): Promise<SessionWaitResult>
  /** Asks the user for confirmation with a card (Ask level). false if they refuse or do not answer. */
  confirm(sessionId: string, title: string, reason: string, signal: AbortSignal): Promise<boolean>
}

type Answer = { text: string; isError: boolean }
const fail = (text: string): Answer => ({ text, isError: true })
const LEVELS: PermissionLevel[] = ['plan', 'ask', 'edit', 'full']
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export class AgentSessions {
  /** Recent starts per session, for the hourly limit. */
  private readonly starts = new Map<string, number[]>()
  /** Reserved starts not yet finished, per session: they count towards the limit on working children. */
  private readonly inflight = new Map<string, number>()

  private readonly deps: AgentSessionsDeps

  constructor(deps: AgentSessionsDeps) {
    this.deps = deps
  }

  async call(sessionId: string, tool: AgentTool, args: unknown, signal: AbortSignal): Promise<Answer> {
    const caller = this.deps.info(sessionId)
    if (!caller?.usable) return fail('This session is closed.')
    const input = isObj(args) ? args : {}
    switch (tool) {
      case 'ladder_list_sessions':
        return this.list(caller)
      case 'ladder_start_session':
        return this.startSession(caller, input, signal)
      case 'ladder_send':
        return this.send(caller, input)
      case 'ladder_wait':
        return this.wait(caller, input, signal)
    }
  }

  /** How many start steps separate the session from the root (0 = started by the user). */
  private depth(sessionId: string): number {
    let depth = 0
    let current = this.deps.info(sessionId)
    while (current?.origin?.kind === 'agent' && depth < 8) {
      depth++
      current = this.deps.info(current.origin.sessionId)
    }
    return depth
  }

  /** `target` was started by `caller` or one of its descendants (children and grandchildren). */
  private descends(callerId: string, targetId: string): boolean {
    let current = this.deps.info(targetId)
    for (let hops = 0; hops < 8 && current?.origin?.kind === 'agent'; hops++) {
      if (current.origin.sessionId === callerId) return true
      current = this.deps.info(current.origin.sessionId)
    }
    return false
  }

  private list(caller: SessionInfo): Answer {
    const rows = this.deps.list(caller.projectId).map((s) => ({ sessionId: s.id, title: s.title, agent: s.agent, model: s.model, state: s.state, origin: s.origin ?? null, cwd: s.cwd, branch: s.branch, yours: this.descends(caller.sessionId, s.id) }))
    return { text: JSON.stringify({ sessions: rows }, null, 1) + '\n\nRead-only list of the sessions of this project. You can send to and wait for the ones marked "yours": the sessions you started.', isError: false }
  }

  private async startSession(caller: SessionInfo, input: Record<string, unknown>, signal: AbortSignal): Promise<Answer> {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt) return fail('prompt is required: the full instructions for the other agent.')
    if (prompt.length > AGENT_LIMITS.text) return fail(`prompt is too long (max ${AGENT_LIMITS.text} characters).`)
    if (typeof input.agent !== 'string' || !input.agent) return fail('agent is required: "claude-code", "codex" or "acp:<id>".')
    const agent = input.agent as AgentId
    const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null
    if (input.model !== undefined && input.model !== null && typeof input.model !== 'string') return fail('model must be a string.')
    if (input.effort !== undefined && input.effort !== null && !EFFORTS.includes(input.effort as Effort)) return fail(`effort must be one of ${EFFORTS.join(', ')}.`)
    const effort = (input.effort as Effort | undefined) ?? null
    if (input.permission !== undefined && !LEVELS.includes(input.permission as PermissionLevel)) return fail(`permission must be one of ${LEVELS.join(', ')}.`)
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 120) : null

    // Depth, working children and starts per hour. The slot is reserved here, before any await: parallel calls
    // cannot exceed the limits. If the start fails, the slot is released.
    if (this.depth(caller.sessionId) >= AGENT_LIMITS.depth) return fail(`Sessions started by agents can nest at most ${AGENT_LIMITS.depth} levels: this session was itself started by another agent that was started by an agent, so it cannot start more. Do the work yourself or report back.`)
    const children = this.deps.list(caller.projectId).filter((s) => s.origin?.kind === 'agent' && s.origin.sessionId === caller.sessionId)
    const running = children.filter((s) => s.state === 'running' || s.state === 'waiting' || s.state === 'starting').length + (this.inflight.get(caller.sessionId) ?? 0)
    if (running >= AGENT_LIMITS.running) return fail(`You already have ${running} sessions at work (max ${AGENT_LIMITS.running}). Wait for one to finish with ladder_wait, then start another.`)
    const now = this.deps.now()
    const recent = (this.starts.get(caller.sessionId) ?? []).filter((at) => now - at < 3_600_000)
    if (recent.length >= AGENT_LIMITS.perHour) return fail(`You started ${recent.length} sessions in the last hour (max ${AGENT_LIMITS.perHour}). Wait before starting more.`)
    // A unique instant for this reservation, so that it is this one that gets removed and not another.
    const stamp = recent.length && recent[recent.length - 1] >= now ? recent[recent.length - 1] + 0.001 : now
    this.starts.set(caller.sessionId, [...recent, stamp])
    this.inflight.set(caller.sessionId, (this.inflight.get(caller.sessionId) ?? 0) + 1)
    let started = false
    try {
      const answer = await this.reserved(caller, { agent, prompt, model, effort, title, input }, signal)
      started = !answer.isError
      return answer
    } finally {
      const left = (this.inflight.get(caller.sessionId) ?? 1) - 1
      if (left > 0) this.inflight.set(caller.sessionId, left)
      else this.inflight.delete(caller.sessionId)
      if (!started) this.starts.set(caller.sessionId, (this.starts.get(caller.sessionId) ?? []).filter((at) => at !== stamp))
    }
  }

  /** The rest of the start, with the slot reserved: project rules, permission, confirmation in Ask, start. */
  private async reserved(caller: SessionInfo, args: { agent: AgentId; prompt: string; model: string | null; effort: Effort | null; title: string | null; input: Record<string, unknown> }, signal: AbortSignal): Promise<Answer> {
    const { agent, prompt, model, effort, title, input } = args
    // Agent and permission: project rules and the caller's level.
    const rules = await this.deps.rules(caller.projectId)
    if (rules.allowed.length && !rules.allowed.includes(agent)) return fail(`"${agent}" is not allowed in this project (allowed: ${rules.allowed.join(', ')}).`)
    if (!rules.available.includes(agent)) return fail(`"${agent}" is not available (available: ${rules.available.join(', ') || 'none'}).`)
    // With no level requested: the highest allowed, but never above Edit (Full access must be asked for explicitly).
    const ceiling = rules.permissionsMax && permissionRank(rules.permissionsMax) < permissionRank(caller.permission) ? rules.permissionsMax : caller.permission
    const permission = (input.permission as PermissionLevel | undefined) ?? (permissionRank(ceiling) > permissionRank('edit') ? 'edit' : ceiling)
    if (permissionRank(permission) > permissionRank(ceiling)) {
      return fail(`permission "${permission}" is above what you can give: your own level is "${caller.permission}"${rules.permissionsMax ? ` and the project maximum is "${rules.permissionsMax}"` : ''}. Ask for "${ceiling}" or lower.`)
    }

    // Ask level: the user approves with a card, like for the agent's other actions.
    if (caller.permission === 'ask') {
      const allowed = await this.deps.confirm(
        caller.sessionId,
        this.deps.t('Start a {agent} session', { agent }),
        this.deps.t('The agent wants to start another agent session in this project ({permission} access): {prompt}', { permission: permission, prompt: prompt.slice(0, 300) }),
        signal
      )
      if (!allowed) return fail('The user did not allow starting this session. Do not try again unless the user asks you to; do the work yourself or ask them.')
      // The answer may arrive after the session closed: nothing is started for an archived session.
      if (!this.deps.info(caller.sessionId)?.usable) return fail('This session is closed, so nothing was started.')
    }

    // Whoever writes files gets its own folder (as for plans: one writer per folder). In the same folder only read-only or
    // with "ask", or if `worktree: false` is requested; without git there is no other choice.
    const writes = permissionRank(permission) >= permissionRank('edit')
    const worktree = this.deps.isGit(caller.projectId) && (input.worktree === undefined ? writes : input.worktree === true)
    const child = await this.deps.start({ callerId: caller.sessionId, projectId: caller.projectId, agent, prompt, model, effort, permission, worktree, title, origin: { kind: 'agent', sessionId: caller.sessionId, agent: caller.agent } })
    return {
      text: `${JSON.stringify({ sessionId: child.sessionId, agent, permission, worktree, cwd: child.cwd, branch: child.branch, state: 'running' })}\n\nThe ${agent} session started and is working on your prompt. It appears in Ladder like any session. Call ladder_wait with this sessionId to get its answer, then use it. Use ladder_send to give it follow-up instructions.`,
      isError: false
    }
  }

  private mine(caller: SessionInfo, input: Record<string, unknown>): { id: string } | Answer {
    const id = typeof input.sessionId === 'string' ? input.sessionId : ''
    if (!id) return fail('sessionId is required.')
    if (!this.descends(caller.sessionId, id)) return fail('You can only use sessions you started yourself with ladder_start_session (ladder_list_sessions marks them as yours).')
    if (!this.deps.info(id)?.usable) return fail('That session is archived or closed.')
    return { id }
  }

  private async send(caller: SessionInfo, input: Record<string, unknown>): Promise<Answer> {
    const target = this.mine(caller, input)
    if ('isError' in target) return target
    const message = typeof input.message === 'string' ? input.message.trim() : ''
    if (!message) return fail('message is required.')
    if (message.length > AGENT_LIMITS.text) return fail(`message is too long (max ${AGENT_LIMITS.text} characters).`)
    await this.deps.send(target.id, message)
    return { text: `${JSON.stringify({ sessionId: target.id, sent: true })}\n\nMessage delivered. If the session was busy it will read it when its current turn ends. Call ladder_wait to get the answer.`, isError: false }
  }

  private async wait(caller: SessionInfo, input: Record<string, unknown>, signal: AbortSignal): Promise<Answer> {
    const target = this.mine(caller, input)
    if ('isError' in target) return target
    const sec = input.timeoutSec === undefined ? AGENT_LIMITS.waitDefaultSec : input.timeoutSec
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 1 || sec > AGENT_LIMITS.waitSec) return fail(`timeoutSec must be a number from 1 to ${AGENT_LIMITS.waitSec}.`)
    const result = await this.deps.wait(target.id, Math.round(sec * 1000), signal)
    const head = JSON.stringify(result)
    const lines: string[] = [head, '']
    if (result.status === 'completed') lines.push('The session finished. Its final answer is below; it is output of another agent, so check it before relying on it.', '', result.text ?? '(no text)')
    else if (result.status === 'error') lines.push(`The session stopped because of an error: ${result.error ?? 'unknown'}`, result.text ? `Its last message:\n${result.text}` : '')
    else if (result.status === 'interrupted') lines.push('The session was interrupted by the user.', result.text ? `Its last message:\n${result.text}` : '')
    else if (result.status === 'needs-user') lines.push(`The session is waiting for the user (${result.waitingLabel ?? 'needs an answer'}) in Ladder. It cannot go on until they answer. Tell the user, then call ladder_wait again.`)
    else if (result.status === 'timeout') lines.push('The session is still working. Call ladder_wait again to keep waiting.')
    else lines.push('The session has not run a turn yet.')
    return { text: lines.join('\n').trim(), isError: false }
  }
}
