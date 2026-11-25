// Fake host: speaks the remote channel protocol (RemoteCommand → results and events) on local data.
// Two uses: the app's demo mode (no network, also in production: it is the demo for App Review) and the e2e harness
// in Node (scripts/e2e-host.ts), which puts it behind the host's real RemoteGateway. No React Native APIs or
// aliases: type imports only, so it runs with `node` directly. Every action changes the local state and emits the same events as the Mac.
import type { AgentId, AgentStatus, Attachment, ChatItem, SlashCommand, PermissionLevel, QueuedMessage, RemoteAgentStatus, RemoteCommand, RemoteEvent, RemotePage, RemoteSessionCreate, RemoteSnapshot, SessionSummary, SubagentInfo, UsageWindow } from '@shared/protocol'
import { buildFixture, type Fixture } from './fixtures.ts'

type RequestItem = Extract<ChatItem, { kind: 'request' }>
const LEVELS: PermissionLevel[] = ['plan', 'ask', 'edit', 'full']

/** Session commands, as sent by Claude Code (demo). */
const DEMO_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context', hint: '[instructions]', source: 'builtin' },
  { name: 'review', description: 'Review the uncommitted changes', hint: null, source: 'builtin' },
  { name: 'init', description: 'Create a CLAUDE.md for this project', hint: null, source: 'builtin' },
  { name: 'security-review', description: 'Check the pending changes for security issues', hint: null, source: 'builtin' },
  { name: 'clear', description: 'Start over with an empty context', hint: null, source: 'builtin' },
  { name: 'commit', description: 'Write a commit for the current changes', hint: '[message]', source: 'custom' },
  { name: 'pr', description: 'Open a pull request from this branch', hint: '[title]', source: 'custom' },
  { name: 'simplify', description: 'Review changed code for reuse and clarity', hint: null, source: 'skill' }
]

/** Project files (demo): enough to test search. */
const DEMO_FILES = [
  'README.md',
  'package.json',
  'tsconfig.json',
  'src/main.ts',
  'src/app.tsx',
  'src/routes/index.tsx',
  'src/routes/payments.tsx',
  'src/routes/payments-filters.tsx',
  'src/components/Button.tsx',
  'src/components/FilterBar.tsx',
  'src/components/PaymentsTable.tsx',
  'src/lib/api.ts',
  'src/lib/format.ts',
  'src/lib/filters.ts',
  'src/lib/filters.test.ts',
  'src/store/payments.ts',
  'docs/architecture.md',
  'docs/payments filters.md',
  'scripts/release.mjs'
]

export interface FakeHostOptions {
  fixture?: Fixture
  /** Simulation time multiplier: 1 = natural, 0.1 = ten times faster (tests). */
  speed?: number
  /** Automatically starts the fixture's "running" session (demo): it ends after a few seconds. */
  autoplay?: boolean
}

export class FakeHost {
  readonly fixture: Fixture
  private readonly speed: number
  private handlers = new Set<(event: RemoteEvent) => void>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private watched: string[] = []
  private seqs = new Map<string, number>()
  private readonly sessions = new Map<string, SessionSummary>()
  private readonly items = new Map<string, ChatItem[]>()
  private disposed = false
  /** Simulated turns in progress per session (cancelled with Stop). */
  private running = new Map<string, number>()
  private runToken = 0

  constructor(options: FakeHostOptions = {}) {
    this.fixture = options.fixture ?? buildFixture()
    this.speed = options.speed ?? 1
    for (const s of this.fixture.sessions) this.sessions.set(s.id, structuredClone(s))
    for (const [id, list] of Object.entries(this.fixture.items)) {
      this.items.set(id, structuredClone(list))
      this.seqs.set(id, Math.max(0, ...list.map((i) => i.seq)))
    }
    if (options.autoplay) {
      for (const s of this.sessions.values()) if (s.run === 'running') this.after(4_000 + Math.random() * 3_000, () => this.finishRunning(s.id))
    }
  }

  onEvent(handler: (event: RemoteEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  dispose(): void {
    this.disposed = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.handlers.clear()
  }

  snapshot(): RemoteSnapshot {
    return {
      type: 'snapshot',
      projects: structuredClone(this.fixture.projects),
      sessions: [...this.sessions.values()].filter((s) => !s.archived).map((s) => structuredClone(s)),
      ui: structuredClone(this.fixture.ui),
      projectGroups: structuredClone(this.fixture.projectGroups),
      agents: structuredClone(this.fixture.agents),
      profiles: structuredClone(this.fixture.profiles),
      defaults: structuredClone(this.fixture.defaults),
      permissionsMax: Object.fromEntries(this.fixture.projects.map((p) => [p.id, this.fixture.permissionMax[p.id] ?? null])),
      prefs: { busySend: 'queue', allowFull: true }
    }
  }

  pageItems(sessionId: string, before?: number, limit = 60): RemotePage {
    const all = this.items.get(sessionId)
    if (!all) throw new Error('Session not found.')
    const sorted = [...all].sort((a, b) => a.seq - b.seq)
    const pool = before === undefined ? sorted : sorted.filter((i) => i.seq < before)
    const page = pool.slice(Math.max(0, pool.length - Math.min(limit, 200)))
    return { sessionId, items: structuredClone(page), hasMore: pool.length > page.length }
  }

  /** Runs a command as the host would: same result, same events. */
  async handle(command: RemoteCommand): Promise<unknown> {
    switch (command.type) {
      case 'hello':
        return this.snapshot()
      case 'session.page':
        return this.pageItems(command.sessionId, command.before, command.limit)
      case 'session.watch': {
        this.watched = this.watched.filter((id) => id !== command.sessionId)
        if (command.on) {
          this.watched.push(command.sessionId)
          if (this.watched.length > 8) this.watched.shift()
        }
        return undefined
      }
      case 'session.read': {
        const s = this.need(command.sessionId)
        const last = this.seqs.get(s.id) ?? 0
        this.patch(s, { unread: false, lastReadSeq: last, agentsNotice: null })
        return undefined
      }
      case 'session.send':
        return this.send(command.sessionId, command.text, command.busy ?? 'queue', command.attachments)
      case 'session.command':
        // Demo: the command shows up as a message (the real Mac adds a "command" row).
        return this.send(command.sessionId, `/${command.name} ${command.args}`.trim(), 'queue')
      case 'session.commands':
        this.need(command.sessionId)
        return structuredClone(DEMO_COMMANDS)
      case 'project.files.search':
        return this.searchFiles(command.projectId, command.query, command.limit)
      case 'session.interrupt':
        this.interrupt(command.sessionId)
        return undefined
      case 'session.respond':
        return this.respond(command.sessionId, command.requestId, command.response)
      case 'session.queue.set': {
        const s = this.need(command.sessionId)
        this.patch(s, { queue: command.queue.map((q): QueuedMessage => ({ id: q.id, text: q.text })) })
        return undefined
      }
      case 'session.queue.deliver':
        return this.deliver(command.sessionId, command.id, command.how)
      case 'session.permission.set':
        return this.setPermission(command.sessionId, command.permission)
      case 'project.sessions.archived':
        return this.archived(command.projectId, command.before, command.limit)
      case 'session.create':
        return this.create(command)
      case 'agents.usage':
        return this.readUsage(command.agent, command.profileId)
      case 'device.push.set':
        return null
      case 'subagent.list':
        return structuredClone(this.fixture.subagents[command.sessionId] ?? ([] as SubagentInfo[]))
      default:
        throw new Error('Not available.')
    }
  }

  /** Archived sessions of a project, most recent first by `updatedAt`; fewer than `limit` results = finished. */
  private archived(projectId: string, before?: number, limit = 30) {
    if (!this.fixture.projects.some((p) => p.id === projectId)) throw new Error('Project not found.')
    return [...this.sessions.values()]
      .filter((s) => s.archived && s.projectId === projectId && (before === undefined || s.updatedAt < before))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.min(limit, 100))
      .map((s) => structuredClone(s))
  }

  // ── State ──

  private need(id: string): SessionSummary {
    const s = this.sessions.get(id)
    if (!s) throw new Error('Session not found.')
    return s
  }

  private emit(event: RemoteEvent): void {
    if (this.disposed) return
    for (const h of this.handlers) h(structuredClone(event))
  }

  private patch(s: SessionSummary, patch: Partial<SessionSummary>): void {
    Object.assign(s, patch, { updatedAt: Date.now() })
    this.emit({ type: 'session.upsert', session: structuredClone(s) })
  }

  private after(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.disposed) fn()
    }, ms * this.speed)
    this.timers.add(timer)
  }

  private nextSeq(id: string): number {
    const n = (this.seqs.get(id) ?? 0) + 1
    this.seqs.set(id, n)
    return n
  }

  private push<K extends ChatItem['kind']>(sessionId: string, turnId: string, kind: K, fields: Record<string, unknown>): Extract<ChatItem, { kind: K }> {
    const seq = this.nextSeq(sessionId)
    const item = { id: `${sessionId}-d${seq}`, turnId, seq, at: Date.now(), kind, ...fields } as unknown as Extract<ChatItem, { kind: K }>
    this.items.get(sessionId)!.push(item)
    this.emit({ type: 'session.items', sessionId, items: [item], replace: false })
    return item
  }

  private update(sessionId: string, item: ChatItem): void {
    this.emit({ type: 'session.items', sessionId, items: [item], replace: false })
  }

  private lastTurn(sessionId: string): string {
    const list = this.items.get(sessionId) ?? []
    return list.length ? list[list.length - 1].turnId : `${sessionId}-turn-0`
  }

  // ── New session and usage limits ──

  /** Like the Mac: same checks (errors in English, no session if something is wrong), then the session starts in chat. */
  private async create(command: RemoteSessionCreate): Promise<SessionSummary> {
    const project = this.fixture.projects.find((p) => p.id === command.projectId)
    if (!project) throw new Error('Project not found.')
    const text = command.text.trim()
    const files = (command.attachments ?? []).map((a) => ({ name: a.name, mediaType: a.mediaType }))
    if (!text && files.length === 0) throw new Error('The message is empty.')
    const status = this.fixture.agents.find((a) => a.agent === command.agent && a.available)
    const allowed = this.fixture.defaults[project.id]?.allowed ?? []
    if (!status || (allowed.length > 0 && !allowed.includes(command.agent))) throw new Error(`${command.agent} is not allowed in this project.`)
    if (command.model && !status.models.some((m) => m.id === command.model)) throw new Error('Unknown model.')
    if (!LEVELS.includes(command.permission)) throw new Error('Unknown permission level.')
    // Above the project ceiling it is reduced to the ceiling, like for the window.
    const max = this.fixture.permissionMax[project.id]
    const permission = max && LEVELS.indexOf(command.permission) > LEVELS.indexOf(max) ? max : command.permission
    // The Mac takes a moment: the phone shows the sending state.
    await new Promise<void>((resolve) => this.after(900, resolve))
    if (this.disposed) throw new Error('Disconnected')
    const now = Date.now()
    const id = `s-new-${now}`
    const session: SessionSummary = {
      id,
      projectId: project.id,
      title: (text.split('\n')[0] || 'Image').slice(0, 48),
      titleSource: 'generated',
      agent: command.agent,
      ...(command.profileId ? { profileId: command.profileId } : {}),
      model: command.model,
      effort: command.effort,
      permission,
      createdAt: now,
      updatedAt: now,
      run: 'starting',
      waitingLabel: null,
      activity: null,
      unread: false,
      lastReadSeq: 0,
      archived: false,
      queue: [],
      context: null,
      mode: 'chat',
      cwd: project.path,
      worktree: null,
      command: null,
      terminalId: null,
      estimated: false,
      waitingSince: null,
      request: null,
      openRequests: 0,
      activityAt: now,
      canSteer: true,
      branch: null,
      pr: null,
      source: null
    }
    this.sessions.set(id, session)
    this.items.set(id, [])
    this.seqs.set(id, 0)
    this.emit({ type: 'session.upsert', session: structuredClone(session) })
    this.after(400, () => this.startTurn(id, text, files))
    return structuredClone(session)
  }

  /** `agents.usage`: a "real" read (here: resets the time) and the value also as `agent.status`; ACP without limits = null. */
  private readUsage(agent: AgentId, profileId?: string): RemoteAgentStatus | null {
    const status = this.fixture.agents.find((a) => a.agent === agent && (profileId ? a.profileId === profileId : !a.profileId))
    if (!status) throw new Error('Agent not found.')
    if (status.kind !== 'native') return null
    status.usageAt = Date.now()
    this.emit({ type: 'agent.status', status: structuredClone(status) })
    return structuredClone(status)
  }

  /** Tests and screenshots only: sets Claude's limits (default account) to a scenario. */
  setUsage(scenario: 'normal' | 'near' | 'banner' | 'limited' | 'empty'): void {
    const status = this.fixture.agents.find((a): a is AgentStatus => a.agent === 'claude-code' && !a.profileId)
    if (!status) return
    const at = (min: number) => Math.floor((Date.now() + min * 60_000) / 1000)
    const win = (key: string, minutes: number, percent: number, inMin: number, state: UsageWindow['state'] = 'ok'): UsageWindow => ({ key, minutes, model: null, percent, resetsAt: at(inMin), state })
    const week = (percent: number) => win('seven_day', 10_080, percent, 3 * 24 * 60 + 200)
    status.usage =
      scenario === 'normal' ? [win('five_hour', 300, 62, 135), week(34)]
      : scenario === 'near' ? [win('five_hour', 300, 82, 95, 'warning'), week(41)]
      : scenario === 'banner' ? [win('five_hour', 300, 96, 22, 'warning'), week(58)]
      : scenario === 'limited' ? [win('five_hour', 300, 100, 48, 'limited'), week(71)]
      : []
    status.usageAt = Date.now() - 2 * 60_000
    this.emit({ type: 'agent.status', status: structuredClone(status) })
  }

  // ── Actions ──

  /** Like the Mac's `project.files.search`, in small: case-insensitive substring, file name before path. */
  private searchFiles(projectId: string, query: string, limit = 20): string[] {
    if (!this.fixture.projects.some((p) => p.id === projectId)) throw new Error('Project not found.')
    const q = query.trim().toLowerCase()
    const name = (f: string) => f.slice(f.lastIndexOf('/') + 1).toLowerCase()
    const hits = DEMO_FILES.filter((f) => !q || f.toLowerCase().includes(q)).sort((a, b) => Number(name(b).startsWith(q)) - Number(name(a).startsWith(q)) || a.split('/').length - b.split('/').length || a.localeCompare(b))
    return hits.slice(0, Math.max(1, Math.min(limit, 50)))
  }

  private send(sessionId: string, text: string, busy: 'queue' | 'steer', attachments: Attachment[] = []): void {
    const s = this.need(sessionId)
    const body = text.trim()
    if (!body && attachments.length === 0) throw new Error('The message is empty.')
    const files = attachments.map((a) => ({ name: a.name, mediaType: a.mediaType }))
    const working = s.run === 'running' || s.run === 'starting'
    if (working) {
      if (busy === 'steer' && s.canSteer) {
        this.push(sessionId, this.lastTurn(sessionId), 'user', { text: body, steered: true, ...(files.length ? { attachments: files } : {}) })
        return
      }
      this.patch(s, { queue: [...s.queue, { id: `q${Date.now()}`, text: body }] })
      return
    }
    this.startTurn(sessionId, body, files)
  }

  private startTurn(sessionId: string, text: string, files: { name: string; mediaType: string }[] = []): void {
    const s = this.need(sessionId)
    const turnId = `${sessionId}-turn-${Date.now()}`
    this.push(sessionId, turnId, 'user', { text, ...(files.length ? { attachments: files } : {}) })
    this.patch(s, { run: 'running', activity: 'Thinking', unread: false, activityAt: Date.now() })
    this.simulate(sessionId, turnId, text)
  }

  /** A fake turn: reads, runs a command, replies in chunks and finishes. */
  private simulate(sessionId: string, turnId: string, prompt: string): void {
    const token = ++this.runToken
    this.running.set(sessionId, token)
    const alive = () => this.running.get(sessionId) === token && !this.disposed
    const s = this.need(sessionId)
    const started = Date.now()
    const tool = this.push(sessionId, turnId, 'tool', { tool: 'read', name: 'Read', title: 'Reads the project files', detail: null, status: 'running', output: null, endedAt: null })
    this.patch(s, { activity: 'Reads the project files' })
    this.after(1_100, () => {
      if (!alive()) return
      tool.status = 'done'
      tool.endedAt = Date.now()
      this.update(sessionId, tool)
      const cmd = this.push(sessionId, turnId, 'tool', { tool: 'command', name: 'Bash', title: 'Runs pnpm test', detail: 'pnpm test', status: 'running', output: null, endedAt: null })
      this.patch(s, { activity: 'Runs pnpm test' })
      this.after(1_400, () => {
        if (!alive()) return
        cmd.status = 'done'
        cmd.endedAt = Date.now()
        cmd.output = 'Tests: 13 passed'
        this.update(sessionId, cmd)
        const reply = `Here is what I found about “${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}”.\n\nThe change is small and self-contained:\n\n- the logic lives in one module\n- the tests cover the new behaviour\n- nothing else needs to change\n\nTell me if you want me to go further.`
        const msg = this.push(sessionId, turnId, 'assistant', { text: '', streaming: true })
        this.patch(s, { activity: null })
        this.streamText(sessionId, msg, reply, alive, () => this.endTurn(sessionId, turnId, started, 'completed'))
      })
    })
  }

  private streamText(sessionId: string, msg: Extract<ChatItem, { kind: 'assistant' }>, full: string, alive: () => boolean, done: () => void): void {
    const words = full.split(/(?<=\s)/)
    // `full` is only the text to append to what is already there.
    const base = msg.text
    let at = 0
    const tick = () => {
      if (!alive()) return
      const take = 2 + Math.floor(Math.random() * 3)
      at += take
      msg.text = base + words.slice(0, at).join('')
      const last = at >= words.length
      msg.streaming = !last
      this.update(sessionId, msg)
      if (last) done()
      else this.after(160, tick)
    }
    tick()
  }

  private endTurn(sessionId: string, turnId: string, started: number, status: 'completed' | 'interrupted'): void {
    const s = this.need(sessionId)
    if (!this.running.delete(sessionId)) return
    const tools = (this.items.get(sessionId) ?? []).filter((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool' && i.turnId === turnId)
    const count = (k: string) => tools.filter((t) => t.tool === k).length
    this.push(sessionId, turnId, 'turn-end', {
      status,
      durationMs: Date.now() - started,
      counts: { commands: count('command'), edits: count('edit'), reads: count('read'), searches: count('search') },
      files: [],
      error: null,
      costUsd: null
    })
    const queued = s.queue[0]
    this.patch(s, { run: 'idle', activity: null, waitingLabel: null, activityAt: Date.now(), unread: !this.watched.includes(sessionId), lastReadSeq: this.watched.includes(sessionId) ? (this.seqs.get(sessionId) ?? 0) : s.lastReadSeq })
    if (queued && status === 'completed') {
      this.patch(s, { queue: s.queue.slice(1) })
      this.after(800, () => this.startTurn(sessionId, queued.text))
    }
  }

  /** The fixtures' "running" session finishes its turn (autoplay). */
  private finishRunning(sessionId: string): void {
    const s = this.need(sessionId)
    if (s.run !== 'running') return
    const list = this.items.get(sessionId) ?? []
    const turnId = list[list.length - 1].turnId
    const token = ++this.runToken
    this.running.set(sessionId, token)
    const alive = () => this.running.get(sessionId) === token && !this.disposed
    for (const i of list) if (i.kind === 'tool' && i.status === 'running') {
      i.status = 'done'
      i.endedAt = Date.now()
      this.update(sessionId, i)
    }
    const msg = [...list].reverse().find((i): i is Extract<ChatItem, { kind: 'assistant' }> => i.kind === 'assistant' && i.streaming)
    const rest = ' and the suite is green: 13 tests passed, no regressions.'
    if (msg) this.streamText(sessionId, msg, rest, alive, () => this.endTurn(sessionId, turnId, Date.now() - 60_000, 'completed'))
    else this.endTurn(sessionId, turnId, Date.now() - 60_000, 'completed')
  }

  private interrupt(sessionId: string): void {
    const s = this.need(sessionId)
    const turnId = this.lastTurn(sessionId)
    this.running.set(sessionId, ++this.runToken)
    for (const i of this.items.get(sessionId) ?? []) {
      if (i.kind === 'assistant' && i.streaming) {
        i.streaming = false
        this.update(sessionId, i)
      }
      if (i.kind === 'tool' && i.status === 'running') {
        i.status = 'denied'
        i.endedAt = Date.now()
        this.update(sessionId, i)
      }
    }
    this.endTurn(sessionId, turnId, Date.now() - 20_000, 'interrupted')
    this.patch(s, { run: 'idle', queue: s.queue })
  }

  private respond(sessionId: string, requestId: string, response: { optionId: string; message?: string } | { answers: Record<string, string> }): void {
    const s = this.need(sessionId)
    const item = (this.items.get(sessionId) ?? []).find((i): i is RequestItem => i.kind === 'request' && i.requestId === requestId)
    if (!item) throw new Error('This request is no longer open.')
    if (item.state !== 'open') throw new Error('This request was already answered.')
    let approved = true
    if ('answers' in response) item.resolution = `Answered: ${Object.values(response.answers).join(' · ')}`
    else {
      const option = item.options.find((o) => o.id === response.optionId)
      approved = option?.kind !== 'deny'
      item.resolution = approved ? 'Approved' : response.message ? `Denied: ${response.message}` : 'Denied'
    }
    item.state = 'resolved'
    item.via = 'phone'
    this.update(sessionId, item)
    const open = (this.items.get(sessionId) ?? []).filter((i): i is RequestItem => i.kind === 'request' && i.state === 'open')
    this.patch(s, { openRequests: open.length, request: open[0] ?? null, waitingSince: open[0]?.at ?? null, ...(open.length ? {} : { run: 'running' as const, waitingLabel: null, activity: approved ? 'Continues' : 'Reads the new instructions' }) })
    if (open.length) return
    const turnId = item.turnId
    const token = ++this.runToken
    this.running.set(sessionId, token)
    const alive = () => this.running.get(sessionId) === token && !this.disposed
    const reason = 'message' in response ? response.message : undefined
    const text = approved ? 'Done. The change is applied and the checks pass.' : reason ? `Understood, I will do this instead: ${reason}` : 'Understood, I will not do that and will look for another way.'
    this.after(900, () => {
      if (!alive()) return
      const msg = this.push(sessionId, turnId, 'assistant', { text: '', streaming: true })
      this.streamText(sessionId, msg, text, alive, () => this.endTurn(sessionId, turnId, Date.now() - 30_000, 'completed'))
    })
  }

  private deliver(sessionId: string, id: string, how: 'steer' | 'now'): void {
    const s = this.need(sessionId)
    const q = s.queue.find((m) => m.id === id)
    if (!q) throw new Error('The message is no longer queued.')
    const working = s.run === 'running' || s.run === 'starting'
    if (working && how === 'steer' && !s.canSteer) throw new Error('This agent cannot take messages during a turn.')
    this.patch(s, { queue: s.queue.filter((m) => m.id !== id) })
    if (!working) return this.startTurn(sessionId, q.text)
    if (how === 'steer') {
      this.push(sessionId, this.lastTurn(sessionId), 'user', { text: q.text, steered: true })
      return
    }
    this.interrupt(sessionId)
    this.after(300, () => this.startTurn(sessionId, q.text))
  }

  private setPermission(sessionId: string, permission: PermissionLevel): { permission: PermissionLevel; appliesFrom: 'now' | 'next-turn' } {
    const s = this.need(sessionId)
    if (!LEVELS.includes(permission)) throw new Error('Unknown permission level.')
    const max = this.fixture.permissionMax[s.projectId]
    if (max && LEVELS.indexOf(permission) > LEVELS.indexOf(max)) throw new Error(`This project allows at most ${max}.`)
    const working = s.run === 'running' || s.run === 'starting' || s.run === 'waiting'
    if (s.agent === 'codex' && working) {
      this.patch(s, { permissionNext: permission })
      return { permission, appliesFrom: 'next-turn' }
    }
    this.patch(s, { permission, permissionNext: null })
    if (permission === 'full') {
      for (const i of this.items.get(sessionId) ?? []) {
        if (i.kind === 'request' && i.state === 'open' && i.requestType === 'permission') this.respond(sessionId, i.requestId, { optionId: 'allow' })
      }
    }
    return { permission, appliesFrom: 'now' }
  }
}
