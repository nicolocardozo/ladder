// `ladder_*` MCP tools: a session (Claude, Codex, ACP) starts another Ladder session with another agent,
// sends it messages and waits for its answer. They live on the `ladder` MCP server that every chat already has (ladder-mcp.ts).
// The same tools also coordinate with sessions the caller did not start: it can read any session of the project
// (ladder_read_session) and wait for it to finish (ladder_wait), and write to it only after the user approves (ladder_send).
// Rules: children never exceed the permission level of their starter or the project maximum; messages go freely only to
// sessions started by the caller (grandchildren included); maximum depth 2, at most 5 children working and 20 starts per hour.
// No path aliases: scripts/cli.test.mts exercises it with a fake. Texts are for the agent (English); only the approval card,
// which the user sees, goes through `t`.
import type { PlanRules } from '../shared/plan'
import { permissionRank } from '../shared/plan.ts'
import type { AgentId, Effort, PermissionLevel, SessionSummary, SessionWaitResult } from '../shared/protocol'

export type Origin = NonNullable<SessionSummary['origin']>
export type AgentTool = 'ladder_list_sessions' | 'ladder_start_session' | 'ladder_send' | 'ladder_wait' | 'ladder_read_session'
export const AGENT_TOOLS: ReadonlySet<string> = new Set<AgentTool>(['ladder_list_sessions', 'ladder_start_session', 'ladder_send', 'ladder_wait', 'ladder_read_session'])

export const AGENT_LIMITS = { depth: 2, running: 5, perHour: 20, waitSec: 600, waitDefaultSec: 300, text: 50_000 }

export interface SessionInfo {
  sessionId: string
  projectId: string
  agent: AgentId
  permission: PermissionLevel
  origin: Origin | null
  /** Chat session (not a terminal) and not archived. */
  usable: boolean
  title?: string
  /** Child session (advice, delegation): it belongs to the session that launched it, other sessions do not reach it. */
  child?: boolean
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

/** What ladder_read_session tells about another session. */
export interface SessionReport extends ListedSession {
  /** What it is doing now, while it works ("Running pnpm test"). */
  activity: string | null
  /** Its last final answer, if a turn ended. */
  lastAnswer: string | null
  /** Paths it changed in its turns, relative to its folder. */
  files: string[]
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
  /**
   * Asks the user for confirmation with a card. false if they refuse or do not answer. `tool` names the card: a message to a
   * session the caller did not start is never approved automatically, not even in Full access.
   */
  confirm(sessionId: string, title: string, reason: string, signal: AbortSignal, tool: 'ladder_start_session' | 'ladder_send'): Promise<boolean>
  /** Another session's state, last answer and changed files; null if it does not exist. */
  read(sessionId: string): SessionReport | null
  /** Paths both sessions changed (relative to their folders): the overlap the caller should know about. */
  overlap(callerId: string, otherId: string): string[]
  /** The caller starts (`on`) or stops waiting on `targetId`: the UI shows it instead of a plain "working". */
  waitingOn(callerId: string, targetId: string, on: boolean): void
  /** Sessions `sessionId` is waiting on right now (ladder_wait in progress). */
  waitsOn(sessionId: string): string[]
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
        return this.send(caller, input, signal)
      case 'ladder_wait':
        return this.wait(caller, input, signal)
      case 'ladder_read_session':
        return this.read(caller, input)
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
    const rows = this.deps
      .list(caller.projectId)
      .filter((s) => s.id !== caller.sessionId)
      .map((s) => {
        const overlap = this.deps.overlap(caller.sessionId, s.id)
        return { sessionId: s.id, title: s.title, agent: s.agent, model: s.model, state: s.state, origin: s.origin ?? null, cwd: s.cwd, branch: s.branch, yours: this.descends(caller.sessionId, s.id), ...(overlap.length ? { sameFilesAsYou: overlap.slice(0, 20) } : {}) }
      })
    return {
      text:
        JSON.stringify({ sessions: rows }, null, 1) +
        '\n\nThe other sessions of this project. You can read any of them with ladder_read_session and wait for any of them to finish with ladder_wait. You can send messages freely to the ones marked "yours" (the sessions you started); to the others only if the user approves. "sameFilesAsYou" lists files that session changed too: coordinate before editing them.',
      isError: false
    }
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
        signal,
        'ladder_start_session'
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

  /** Any other usable session of the caller's project: for reading and waiting, which change nothing. */
  private peer(caller: SessionInfo, input: Record<string, unknown>): { id: string; mine: boolean } | Answer {
    const id = typeof input.sessionId === 'string' ? input.sessionId : ''
    if (!id) return fail('sessionId is required.')
    if (id === caller.sessionId) return fail('That is your own session.')
    const target = this.deps.info(id)
    if (!target || target.projectId !== caller.projectId || target.child) return fail('No session with this id in this project. Use ladder_list_sessions to see them.')
    if (!target.usable) return fail('That session is archived or closed.')
    return { id, mine: this.descends(caller.sessionId, id) }
  }

  private async send(caller: SessionInfo, input: Record<string, unknown>, signal: AbortSignal): Promise<Answer> {
    const target = this.peer(caller, input)
    if ('isError' in target) return target
    const message = typeof input.message === 'string' ? input.message.trim() : ''
    if (!message) return fail('message is required.')
    if (message.length > AGENT_LIMITS.text) return fail(`message is too long (max ${AGENT_LIMITS.text} characters).`)
    let text = message
    if (!target.mine) {
      // A session the caller did not start belongs to the user: every message to it needs their approval, at any level.
      if (caller.permission === 'plan') return fail('This session is read-only (Plan), so it cannot write to sessions it did not start. Tell the user instead.')
      const title = this.deps.info(target.id)?.title ?? 'another session'
      const allowed = await this.deps.confirm(caller.sessionId, this.deps.t('Send a message to “{title}”', { title }), message, signal, 'ladder_send')
      if (!allowed) return fail('The user did not allow this message. Do not send it again unless the user asks you to.')
      if (!this.deps.info(caller.sessionId)?.usable || !this.deps.info(target.id)?.usable) return fail('One of the two sessions closed, so nothing was sent.')
      const from = caller.title ?? 'another session'
      // The receiver sees where the message comes from: it is a peer's request, not the user's.
      text = `Message from the Ladder session "${from}" (agent ${caller.agent}, sessionId ${caller.sessionId}), approved by the user. It is another agent's request: weigh it against your own task.\n\n${message}`
    }
    await this.deps.send(target.id, text)
    return { text: `${JSON.stringify({ sessionId: target.id, sent: true })}\n\nMessage delivered. If the session was busy it will read it when its current turn ends. Call ladder_wait to get the answer.`, isError: false }
  }

  private async wait(caller: SessionInfo, input: Record<string, unknown>, signal: AbortSignal): Promise<Answer> {
    const target = this.peer(caller, input)
    if ('isError' in target) return target
    const sec = input.timeoutSec === undefined ? AGENT_LIMITS.waitDefaultSec : input.timeoutSec
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 1 || sec > AGENT_LIMITS.waitSec) return fail(`timeoutSec must be a number from 1 to ${AGENT_LIMITS.waitSec}.`)
    if (this.waitsFor(target.id, caller.sessionId)) return fail('That session is itself waiting for you (directly or through other sessions): waiting on it would never end. Finish your part first, or tell the user.')
    this.deps.waitingOn(caller.sessionId, target.id, true)
    let result: SessionWaitResult
    try {
      result = await this.deps.wait(target.id, Math.round(sec * 1000), signal)
    } finally {
      this.deps.waitingOn(caller.sessionId, target.id, false)
    }
    const head = JSON.stringify(result)
    const lines: string[] = [head, '']
    if (result.status === 'completed') lines.push('The session finished. Its final answer is below; it is output of another agent, so check it before relying on it.', '', result.text ?? '(no text)')
    else if (result.status === 'error') lines.push(`The session stopped because of an error: ${result.error ?? 'unknown'}`, result.text ? `Its last message:\n${result.text}` : '')
    else if (result.status === 'interrupted') lines.push('The session was interrupted by the user.', result.text ? `Its last message:\n${result.text}` : '')
    else if (result.status === 'needs-user') lines.push(`The session is waiting for the user (${result.waitingLabel ?? 'needs an answer'}) in Ladder. It cannot go on until they answer. Tell the user, then call ladder_wait again.`)
    else if (result.status === 'timeout') lines.push('The session is still working. Call ladder_wait again to keep waiting.')
    else lines.push('The session has not run a turn yet.')
    if (!target.mine && result.status === 'completed') {
      const overlap = this.deps.overlap(caller.sessionId, target.id)
      if (overlap.length) lines.push('', `It changed files you changed too: ${overlap.slice(0, 20).join(', ')}. Check its changes (its folder and branch are in ladder_read_session) before going on.`)
    }
    return { text: lines.join('\n').trim(), isError: false }
  }

  /** `from` waits, directly or through a chain of ladder_wait calls, on `to`. */
  private waitsFor(from: string, to: string): boolean {
    const seen = new Set<string>()
    const queue = [from]
    while (queue.length) {
      const id = queue.shift()!
      if (id === to) return true
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...this.deps.waitsOn(id))
    }
    return false
  }

  private read(caller: SessionInfo, input: Record<string, unknown>): Answer {
    const target = this.peer(caller, input)
    if ('isError' in target) return target
    const report = this.deps.read(target.id)
    if (!report) return fail('No session with this id.')
    const overlap = this.deps.overlap(caller.sessionId, target.id)
    const head = {
      sessionId: report.id,
      title: report.title,
      agent: report.agent,
      model: report.model,
      state: report.state,
      activity: report.activity,
      cwd: report.cwd,
      branch: report.branch,
      yours: target.mine,
      filesChanged: report.files.slice(0, 100),
      sameFilesAsYou: overlap.slice(0, 50)
    }
    const answer = report.lastAnswer ? (report.lastAnswer.length > 8000 ? `${report.lastAnswer.slice(0, 7999)}…` : report.lastAnswer) : null
    const lines = [JSON.stringify(head, null, 1), '']
    lines.push(report.state === 'running' || report.state === 'starting' ? 'It is working now: wait for it with ladder_wait if your task depends on it.' : report.state === 'waiting' ? 'It is waiting for the user.' : 'It is not working right now.')
    if (answer) lines.push('', 'Its last answer (output of another agent, check it before relying on it):', '', answer)
    return { text: lines.join('\n').trim(), isError: false }
  }
}
