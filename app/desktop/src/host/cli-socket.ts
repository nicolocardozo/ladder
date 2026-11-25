// Local socket for the `ladder` CLI: the host listens on a Unix socket in the app data folder (folder 0700, socket
// 0600: user only). Protocol: JSON, one line per message, with the same shapes as ToHost/FromHost of the UI channel
// (`{ rid, command }` → `{ kind: 'result', rid, … }`). Plus `{ rid, subscribe: sessionId | null }`: from then on the client receives
// the `session.items` and `session.upsert` events of that session. Only a fixed list of commands is allowed from the CLI.
//
// Security boundary: the socket belongs to the user (0600), there is no other authentication. Anything running with the user's permissions, for example an
// agent with Bash, can therefore use `ladder new … --permission full` and skip the MCP tool rules (caller's permission,
// Ask card, limits): only the project's maximum permission applies, which `session.create` always enforces. The same agent could
// do anyway with the shell everything the session it starts can do; so the boundary is "same user" and nothing more is pretended.
// No path aliases and no translation of end-user texts: the CLI shows the error as is (English).
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { FromHost, HostCommand, HostEvent } from '../shared/protocol'

/** Commands the CLI may send: listing and creating sessions, messages, stop, wait and reading a chat. Everything else is rejected. */
export const CLI_ALLOWED: ReadonlySet<string> = new Set(['hello', 'agents.defaults', 'session.create', 'session.send', 'session.interrupt', 'session.wait', 'session.transcript'])

/** A line longer than this closes the connection. */
const MAX_LINE = 8 * 1024 * 1024
/** A client that does not read (ladder attach suspended with Ctrl-Z) must not grow the host's memory: beyond this the connection is closed. */
const MAX_PENDING_WRITE = 4 * 1024 * 1024

export interface CliSocketDeps {
  /** Runs the command as a CLI request (created sessions get origin cli). */
  /** `signal` fires when the client closes the connection: a long wait (session.wait) stops. */
  handle: (command: HostCommand, signal: AbortSignal) => Promise<unknown>
}

/** Check of the command before running it: null if fine, otherwise the reason (English, read by the CLI). */
export function checkCliCommand(command: unknown): string | null {
  if (!command || typeof command !== 'object' || typeof (command as { type?: unknown }).type !== 'string') return 'Invalid command.'
  const c = command as HostCommand
  if (!CLI_ALLOWED.has(c.type)) return `Command "${c.type}" is not available from the command line.`
  if (c.type === 'session.create') {
    // No terminal sessions, shell commands, sources or attachments from the CLI.
    if ((c.mode ?? 'chat') !== 'chat' || c.command !== undefined) return 'The command line can only start chat sessions.'
    if (c.attachments?.length) return 'Attachments are not supported from the command line.'
    if (typeof c.text !== 'string' || !c.text.trim()) return 'The prompt is empty.'
  }
  if (c.type === 'session.send' && (c.attachments?.length || typeof c.text !== 'string' || !c.text.trim())) return 'The message is empty.'
  return null
}

export class CliSocket {
  private server: Server | null = null
  private readonly clients = new Map<Socket, { subscribed: string | null; gone: AbortController }>()

  private readonly path: string
  private readonly deps: CliSocketDeps

  constructor(path: string, deps: CliSocketDeps) {
    this.path = path
    this.deps = deps
  }

  /** Path it listens on, or null if it is not listening. */
  get socket(): string | null {
    return this.server?.listening ? this.path : null
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(this.path), 0o700)
    if (existsSync(this.path)) {
      // Another Ladder is already listening: its socket is not removed. Otherwise it is a leftover from an abrupt shutdown.
      if (await this.alive()) throw new Error('another Ladder is already listening on the socket')
      unlinkSync(this.path)
    }
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    chmodSync(this.path, 0o600)
    this.server = server
  }

  private alive(): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = createConnection(this.path)
      probe.once('connect', () => (probe.destroy(), resolve(true)))
      probe.once('error', () => resolve(false))
    })
  }

  /** A host event: goes to the clients subscribed to its session. */
  publish(event: HostEvent): void {
    const sessionId = event.type === 'session.items' ? event.sessionId : event.type === 'session.upsert' ? event.session.id : null
    if (!sessionId) return
    for (const [socket, state] of this.clients) if (state.subscribed === sessionId) this.write(socket, { kind: 'event', event })
  }

  close(): void {
    for (const [socket, state] of this.clients) {
      state.gone.abort()
      socket.destroy()
    }
    this.clients.clear()
    this.server?.close()
    this.server = null
    try {
      unlinkSync(this.path)
    } catch {
      // Already removed.
    }
  }

  private write(socket: Socket, message: FromHost): void {
    if (socket.destroyed) return
    // The cap applies to events piling up for a client that does not read; a reply to a command is always written.
    if (message.kind === 'event' && socket.writableLength > MAX_PENDING_WRITE) return void socket.destroy()
    socket.write(`${JSON.stringify(message)}\n`)
  }

  private accept(socket: Socket): void {
    this.clients.set(socket, { subscribed: null, gone: new AbortController() })
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE) return socket.destroy()
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (line.trim()) void this.message(socket, line)
      }
    })
    socket.on('close', () => {
      this.clients.get(socket)?.gone.abort()
      this.clients.delete(socket)
    })
    socket.on('error', () => socket.destroy())
  }

  private async message(socket: Socket, line: string): Promise<void> {
    let frame: { rid?: unknown; command?: unknown; subscribe?: unknown }
    try {
      frame = JSON.parse(line) as typeof frame
    } catch {
      return this.write(socket, { kind: 'result', rid: '', ok: false, error: 'Invalid message.' })
    }
    const rid = typeof frame.rid === 'string' ? frame.rid : ''
    const reply = (ok: true | string, data?: unknown) => rid && this.write(socket, ok === true ? { kind: 'result', rid, ok: true, data } : { kind: 'result', rid, ok: false, error: ok })
    if ('subscribe' in frame) {
      const state = this.clients.get(socket)
      if (state) state.subscribed = typeof frame.subscribe === 'string' ? frame.subscribe : null
      return void reply(true)
    }
    const problem = checkCliCommand(frame.command)
    if (problem) return void reply(problem)
    try {
      reply(true, await this.deps.handle(frame.command as HostCommand, this.clients.get(socket)?.gone.signal ?? new AbortController().signal))
    } catch (error) {
      reply(error instanceof Error ? error.message : String(error))
    }
  }
}
