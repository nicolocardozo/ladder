// `ladder` CLI: drives Ladder's sessions from the terminal by talking to the running app on its local socket.
// `run` touches neither the process nor the terminal: everything goes through `Io`, so it can be tested with a fake (scripts/cli.test.mts).
// Output is in English (it is a terminal tool). No path aliases.
import { realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { COMMANDS, commandHelp, exitCodeFor, mainHelp, parseArgs, type Parsed } from './args.ts'
import type { Conn } from './client.ts'
import { markOf } from './follow-mark.ts'
import { discoverSocket } from './socket-path.ts'
import type { AgentId, ChatItem, Effort, HostEvent, PermissionLevel, Project, SessionSummary, SessionWaitResult, TranscriptMark } from '../shared/protocol'

export interface Io {
  out(text: string): void
  /** Text without a trailing newline (the parts of the assistant text as they arrive). */
  write(text: string): void
  err(text: string): void
  /** All of standard input (for the "-" argument). */
  stdin(): Promise<string>
  env: Record<string, string | undefined>
  cwd: string
  connect(path: string): Promise<Conn>
  /** Ctrl-C: the function is called on the first interrupt. */
  onInterrupt(fn: () => void): void
}

interface Snapshot {
  projects: Project[]
  sessions: SessionSummary[]
  agents: { agent: AgentId; available: boolean; name: string }[]
  ui: Record<string, { defaults?: { agent?: AgentId | null; models?: Partial<Record<AgentId, string>>; efforts?: Partial<Record<AgentId, Effort>>; permission?: PermissionLevel | null }; lastAgent?: AgentId }>
}

class UsageError extends Error {}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const LEVELS = ['plan', 'ask', 'edit', 'full']
/** Sessions worth working on from the CLI: non-archived chats (a terminal session has no "end of work" to wait for). */
const usable = (s: SessionSummary): boolean => !s.archived && s.mode !== 'terminal'
const short = (id: string) => id.slice(0, 8)

function table(rows: string[][]): string {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)))
  return rows.map((r) => r.map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col]))).join('  ')).join('\n')
}

const stateOf = (s: SessionSummary): string => (s.run === 'waiting' ? `waiting${s.waitingLabel ? ` (${s.waitingLabel})` : ''}` : s.planWaiting && s.waitingLabel ? `idle (${s.waitingLabel})` : s.run)
const originOf = (s: SessionSummary): string => (s.origin?.kind === 'cli' ? 'cli' : s.origin?.kind === 'agent' ? `agent ${short(s.origin.sessionId)}` : '')

/** Project by name (case-insensitive), by folder, or "." / a relative folder: the project that contains it. */
export function findProject(projects: Project[], query: string, cwd: string): Project {
  const lower = query.toLowerCase()
  const byName = projects.filter((p) => p.name.toLowerCase() === lower)
  if (byName.length === 1) return byName[0]
  // A name without slashes is not a path ("." and "./sub" are, relative to the current folder). Real paths, not URLs:
  // spaces, accents and "#" are left as they were; with symlinks the real path is compared too.
  const isPath = query.startsWith('/') || query.startsWith('.') || query.includes('/')
  const real = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  const wanted = isPath ? [...new Set([resolvePath(cwd, query), real(resolvePath(cwd, query))])] : []
  const within = (path: string, root: string) => path === root || path.startsWith(root.replace(/\/$/, '') + '/')
  const inside = projects.filter((p) => wanted.some((path) => [p.path, real(p.path)].some((root) => within(path, root)))).sort((a, b) => b.path.length - a.path.length)
  if (inside.length) return inside[0]
  if (byName.length > 1) throw new Error(`Several projects are named "${query}": use the folder path.`)
  const known = projects.map((p) => `  ${p.name}  ${p.path}`).join('\n')
  throw new Error(`No Ladder project matches "${query}".${known ? `\nProjects:\n${known}` : ' Open the project in Ladder first.'}`)
}

/** Session by full id or by unique prefix. */
export function findSession(sessions: SessionSummary[], query: string): SessionSummary {
  const exact = sessions.find((s) => s.id === query)
  if (exact) return exact
  const matches = sessions.filter((s) => s.id.startsWith(query))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`"${query}" matches ${matches.length} sessions: ${matches.slice(0, 5).map((s) => short(s.id)).join(', ')}. Type more of the id.`)
  throw new Error(`No session matches "${query}". Run "ladder ls" to see them.`)
}

async function text(io: Io, arg: string): Promise<string> {
  const value = arg === '-' ? await io.stdin() : arg
  if (!value.trim()) throw new UsageError('The text is empty.')
  return value.replace(/\s+$/, '')
}

function seconds(flags: Parsed['flags']): number | undefined {
  const raw = flags['--timeout']
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1 || n > 3600) throw new UsageError('--timeout must be a number of seconds from 1 to 3600.')
  return Math.round(n * 1000)
}

/** Prints the outcome of a wait and returns the exit code. */
function report(io: Io, result: SessionWaitResult, json: boolean): number {
  if (json) io.out(JSON.stringify(result))
  else {
    if (result.text) io.out(result.text)
    if (result.status === 'error') io.err(`The session stopped because of an error: ${result.error ?? 'unknown'}`)
    else if (result.status === 'interrupted') io.err('The session was interrupted.')
    else if (result.status === 'needs-user') io.err(`The session is waiting for you in Ladder${result.waitingLabel ? ` (${result.waitingLabel})` : ''}. Answer it there, then run "ladder wait ${short(result.sessionId)}" again.`)
    else if (result.status === 'timeout') io.err('Timed out: the session is still working. Run "ladder wait" again to keep waiting.')
    else if (result.status === 'idle') io.err('The session has not run a turn yet.')
  }
  return exitCodeFor(result.status)
}

// ── Attach ──────────────────────────────────────────────────────────────────

/** Chat lines as readable text; keeps track of what it has already printed. */
export class Follower {
  private readonly printed = new Map<string, number>()
  /** Events that arrived before the history: replayed afterwards. */
  private queued: HostEvent[] = []
  private baseline = false
  private open = false
  private readonly out: (text: string) => void
  constructor(out: (text: string) => void) {
    this.out = out
  }

  private line(text: string): void {
    if (this.open) this.out('\n')
    this.open = false
    this.out(`${text}\n`)
  }

  /** The current history (answer of `session.transcript`): it is not reprinted, and from here only new content is printed. */
  start(history: TranscriptMark[]): void {
    this.baseline = true
    for (const { id, mark } of history) this.printed.set(id, mark)
    const early = this.queued
    this.queued = []
    for (const event of early) this.handle(event)
  }

  handle(event: HostEvent): void {
    if (event.type !== 'session.items') return
    if (!this.baseline) {
      this.queued.push(event)
      return
    }
    for (const item of [...event.items].sort((a, b) => a.seq - b.seq)) this.item(item)
  }

  private item(item: ChatItem): void {
    const seen = this.printed.get(item.id)
    switch (item.kind) {
      case 'user':
        if (seen === undefined) this.line(`> ${item.text.split('\n').join('\n  ')}`)
        break
      case 'assistant': {
        const from = seen ?? 0
        if (item.text.length > from) {
          if (from === 0 && this.open) this.out('\n')
          this.out(item.text.slice(from))
          this.open = !item.text.endsWith('\n')
        }
        if (!item.streaming && this.open) (this.out('\n'), (this.open = false))
        break
      }
      case 'tool':
        if (seen === undefined) this.line(`• ${item.title}`)
        else if (seen === 1 && item.status === 'error') this.line(`  failed: ${item.title}`)
        break
      case 'request':
        if (item.state === 'open' && !seen) this.line(`! Waiting for you in Ladder: ${item.title}`)
        else if (item.state !== 'open' && seen === 0) this.line(`  ${item.resolution ?? item.state}`)
        break
      case 'turn-end':
        if (seen === undefined) this.line(`-- Turn ${item.status}${item.error ? `: ${item.error}` : ''} (${(item.durationMs / 1000).toFixed(1)}s) --`)
        break
      case 'notice':
        if (seen === undefined) this.line(`[${item.tone}] ${item.text}`)
        break
      default:
        break
    }
    this.printed.set(item.id, markOf(item))
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function execute(io: Io, parsed: Parsed, conn: Conn): Promise<number> {
  const { command, args, flags } = parsed
  const json = flags['--json'] === true
  const snapshot = async () => (await conn.request({ type: 'hello' })) as Snapshot

  switch (command.name) {
    case 'projects': {
      const { projects } = await snapshot()
      if (json) io.out(JSON.stringify(projects.map((p) => ({ id: p.id, name: p.name, path: p.path, branch: p.branch }))))
      else io.out(projects.length ? table([['NAME', 'BRANCH', 'PATH'], ...projects.map((p) => [p.name, p.branch ?? '-', p.path])]) : 'No projects. Open a folder in Ladder first.')
      return 0
    }
    case 'ls': {
      const snap = await snapshot()
      const project = typeof flags['--project'] === 'string' ? findProject(snap.projects, flags['--project'], io.cwd) : null
      const names = new Map(snap.projects.map((p) => [p.id, p.name]))
      const rows = snap.sessions.filter((s) => !s.archived && s.mode !== 'terminal' && (!project || s.projectId === project.id)).sort((a, b) => b.activityAt - a.activityAt)
      if (json) io.out(JSON.stringify(rows.map((s) => ({ id: s.id, projectId: s.projectId, project: names.get(s.projectId) ?? null, title: s.title, agent: s.agent, model: s.model, state: stateOf(s), origin: s.origin ?? null }))))
      else io.out(rows.length ? table([['ID', 'PROJECT', 'AGENT', 'STATE', 'FROM', 'TITLE'], ...rows.map((s) => [short(s.id), names.get(s.projectId) ?? '-', s.agent, stateOf(s), originOf(s) || '-', s.title])]) : 'No sessions.')
      return 0
    }
    case 'new': {
      const snap = await snapshot()
      const project = findProject(snap.projects, args[0], io.cwd)
      const prompt = await text(io, args[1])
      const ui = snap.ui[project.id]
      const availableAgents = snap.agents.filter((a) => a.available)
      const wanted = (flags['--agent'] as string | undefined) ?? ui?.defaults?.agent ?? ui?.lastAgent ?? availableAgents[0]?.agent
      if (!wanted) throw new Error('No agent is available. Sign in to an agent in Ladder first.')
      if (!availableAgents.some((a) => a.agent === wanted)) throw new UsageError(`Agent "${wanted}" is not available. Available: ${availableAgents.map((a) => a.agent).join(', ') || 'none'}.`)
      const agent = wanted as AgentId
      const effort = (flags['--effort'] as string | undefined) ?? ui?.defaults?.efforts?.[agent] ?? null
      if (effort !== null && !EFFORTS.includes(effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}.`)
      const permission = (flags['--permission'] as string | undefined) ?? ui?.defaults?.permission ?? 'edit'
      if (!LEVELS.includes(permission)) throw new UsageError(`--permission must be one of ${LEVELS.join(', ')}.`)
      const timeoutMs = flags['--wait'] ? seconds(flags) : undefined
      const created = (await conn.request({
        type: 'session.create',
        projectId: project.id,
        agent,
        text: prompt,
        model: (flags['--model'] as string | undefined) ?? ui?.defaults?.models?.[agent] ?? null,
        effort: effort as Effort | null,
        permission: permission as PermissionLevel,
        ...(flags['--worktree'] ? { worktree: true } : {})
      })) as SessionSummary
      if (!flags['--wait']) {
        io.out(json ? JSON.stringify({ sessionId: created.id, project: project.name, agent }) : created.id)
        return 0
      }
      if (!json) io.err(`Started ${short(created.id)} (${agent}) in ${project.name}. Waiting...`)
      return report(io, (await conn.request({ type: 'session.wait', sessionId: created.id, ...(timeoutMs ? { timeoutMs } : {}) })) as SessionWaitResult, json)
    }
    case 'send': {
      const snap = await snapshot()
      const session = findSession(snap.sessions.filter(usable), args[0])
      const message = await text(io, args[1])
      const timeoutMs = flags['--wait'] ? seconds(flags) : undefined
      await conn.request({ type: 'session.send', sessionId: session.id, text: message })
      if (!flags['--wait']) {
        if (json) io.out(JSON.stringify({ sessionId: session.id, sent: true }))
        return 0
      }
      return report(io, (await conn.request({ type: 'session.wait', sessionId: session.id, ...(timeoutMs ? { timeoutMs } : {}) })) as SessionWaitResult, json)
    }
    case 'wait': {
      const snap = await snapshot()
      const session = findSession(snap.sessions.filter(usable), args[0])
      const timeoutMs = seconds(flags)
      return report(io, (await conn.request({ type: 'session.wait', sessionId: session.id, ...(timeoutMs ? { timeoutMs } : {}) })) as SessionWaitResult, json)
    }
    case 'stop': {
      const snap = await snapshot()
      const session = findSession(snap.sessions.filter(usable), args[0])
      await conn.request({ type: 'session.interrupt', sessionId: session.id })
      io.out(`Stopped ${short(session.id)}.`)
      return 0
    }
    case 'attach': {
      const snap = await snapshot()
      const session = findSession(snap.sessions.filter(usable), args[0])
      const follower = new Follower((chunk) => io.write(chunk))
      return new Promise<number>((resolve) => {
        io.onInterrupt(() => {
          io.err('\nDetached. The session keeps running.')
          conn.close()
          resolve(0)
        })
        conn.onClose(() => {
          io.err('Ladder closed the connection.')
          resolve(1)
        })
        void (async () => {
          await conn.subscribe(session.id, (event) => follower.handle(event))
          follower.start((await conn.request({ type: 'session.transcript', sessionId: session.id })) as TranscriptMark[])
          io.err(`Attached to "${session.title}" (${short(session.id)}, ${stateOf(session)}). New activity follows; Ctrl-C detaches.`)
        })().catch((error: Error) => {
          io.err(error.message)
          resolve(1)
        })
      })
    }
  }
  return 0
}

/** Entry point: arguments already without node and the script. Returns the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    if (parsed.help) {
      const spec = parsed.error.startsWith('help:') ? COMMANDS.find((c) => c.name === parsed.error.slice(5)) : undefined
      io.out(spec ? commandHelp(spec) : mainHelp())
      return 0
    }
    io.err(parsed.error)
    return 64
  }
  let conn: Conn | null = null
  try {
    conn = await io.connect(discoverSocket(io.env))
    return await execute(io, parsed.value, conn)
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return error instanceof UsageError ? 64 : 1
  } finally {
    conn?.close()
  }
}
