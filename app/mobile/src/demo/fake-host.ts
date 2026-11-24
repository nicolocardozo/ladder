// Host finto: parla il protocollo del canale remoto (RemoteCommand → risultati ed eventi) su dati locali.
// Due usi: la modalità demo dell'app (nessuna rete, anche in produzione: sarà la demo per App Review, LAD-55) e l'harness
// e2e in Node (scripts/e2e-host.ts), che lo mette dietro il vero RemoteGateway dell'host. Niente API di React Native né
// alias: solo import di tipi, così gira con `node` direttamente. Ogni azione cambia lo stato locale ed emette gli stessi eventi del Mac.
import type { ChatItem, PermissionLevel, QueuedMessage, RemoteCommand, RemoteEvent, RemotePage, RemoteSnapshot, SessionSummary, SubagentInfo } from '@shared/protocol'
import { buildFixture, type Fixture } from './fixtures.ts'

type RequestItem = Extract<ChatItem, { kind: 'request' }>
const LEVELS: PermissionLevel[] = ['plan', 'ask', 'edit', 'full']

export interface FakeHostOptions {
  fixture?: Fixture
  /** Moltiplicatore dei tempi della simulazione: 1 = naturale, 0.1 = dieci volte più veloce (prove). */
  speed?: number
  /** Fa partire da sola la sessione "in corso" della fixture (demo): termina dopo qualche secondo. */
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
  /** Turni simulati in corso per sessione (si annullano con Stop). */
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

  /** Esegue un comando come farebbe l'host: stesso risultato, stessi eventi. */
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
        return this.send(command.sessionId, command.text, command.busy ?? 'queue')
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
      case 'device.push.set':
        return null
      case 'subagent.list':
        return structuredClone(this.fixture.subagents[command.sessionId] ?? ([] as SubagentInfo[]))
      default:
        throw new Error('Not available.')
    }
  }

  /** Sessioni archiviate di un progetto, dalla più recente per `updatedAt`; meno di `limit` risultati = finite. */
  private archived(projectId: string, before?: number, limit = 30) {
    if (!this.fixture.projects.some((p) => p.id === projectId)) throw new Error('Project not found.')
    return [...this.sessions.values()]
      .filter((s) => s.archived && s.projectId === projectId && (before === undefined || s.updatedAt < before))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.min(limit, 100))
      .map((s) => structuredClone(s))
  }

  // ── Stato ──

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

  // ── Azioni ──

  private send(sessionId: string, text: string, busy: 'queue' | 'steer'): void {
    const s = this.need(sessionId)
    const body = text.trim()
    if (!body) throw new Error('The message is empty.')
    const working = s.run === 'running' || s.run === 'starting'
    if (working) {
      if (busy === 'steer' && s.canSteer) {
        this.push(sessionId, this.lastTurn(sessionId), 'user', { text: body, steered: true })
        return
      }
      this.patch(s, { queue: [...s.queue, { id: `q${Date.now()}`, text: body }] })
      return
    }
    this.startTurn(sessionId, body)
  }

  private startTurn(sessionId: string, text: string): void {
    const s = this.need(sessionId)
    const turnId = `${sessionId}-turn-${Date.now()}`
    this.push(sessionId, turnId, 'user', { text })
    this.patch(s, { run: 'running', activity: 'Thinking', unread: false, activityAt: Date.now() })
    this.simulate(sessionId, turnId, text)
  }

  /** Un turno finto: legge, esegue un comando, risponde a pezzi e chiude. */
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
    // `full` è solo il testo da aggiungere a quello già presente.
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

  /** La sessione "in corso" delle fixture chiude il suo turno (autoplay). */
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
