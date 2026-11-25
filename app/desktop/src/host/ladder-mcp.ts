// Ladder's MCP server (executable plans): HTTP on 127.0.0.1 with an ephemeral port and a secret token per session, the same
// security model as the agent's browser (browser-mcp.ts): loopback only, no Origin, host check against
// DNS rebinding, token in the Authorization header, limited body. One server for all sessions and all agents.
//
// The tools depend on the session's role:
// - coordinator (any chat that is not a plan task): `propose_plan` and `revise_plan`;
// - plan task: `report_result`.
// No tool blocks: they answer right away and the agent ends its turn. The server does not know what a plan is: it passes the arguments
// to `LadderMcpHooks.call` (plans.ts) and returns the text.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { PLAN_INPUT_SCHEMA, RESULT_INPUT_SCHEMA } from '../shared/plan.ts'

export type LadderRole = 'coordinator' | 'task'
export type LadderTool = 'propose_plan' | 'revise_plan' | 'report_result' | 'ladder_list_sessions' | 'ladder_start_session' | 'ladder_send' | 'ladder_wait'

export interface LadderMcpHooks {
  /** The session's current role; null = the session no longer exists (no tools). Read on every call. */
  role(sessionId: string): LadderRole | null
  /** Runs the tool. The text is for the agent (English); `isError` flags it as a tool error. */
  /** `signal` fires if the client closes the connection (a `ladder_wait` can last minutes). */
  call(sessionId: string, tool: LadderTool, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }>
}

export interface LadderToolsHandle {
  url: string
  token: string
}

export const LADDER_LIMITS = {
  /** A plan of 20 tasks of 8000 characters fits comfortably. */
  bodyBytes: 512 * 1024,
  callsPerMinute: 30
}

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

interface ToolDef {
  name: LadderTool
  role: LadderRole
  description: string
  inputSchema: object
}

const REVISE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['planId', 'plan', 'reason'],
  properties: {
    planId: { type: 'string', description: 'Id of the plan to change, as returned by propose_plan.' },
    plan: PLAN_INPUT_SCHEMA,
    reason: { type: 'string', maxLength: 500, description: 'One sentence for the user: why the plan changes.' }
  }
} as const

const TOOLS: ToolDef[] = [
  {
    name: 'propose_plan',
    role: 'coordinator',
    description:
      "Propose an executable plan to the user in Ladder. This is Ladder's own plan, not your internal todo list: Ladder shows it as a card in the chat, the user reviews and edits it, and once approved Ladder runs each task in its own agent session (each with the executor, model and permission level you choose), in dependency order, with pauses where you ask for them. Use it when the work splits into steps worth reviewing or for different agents (for example: one agent plans, another implements, a third reviews). Do not start the work yourself. After calling it, end your turn: the plan is shown to the user, and the answer arrives later as a message.",
    inputSchema: PLAN_INPUT_SCHEMA
  },
  {
    name: 'revise_plan',
    role: 'coordinator',
    description:
      "Change a plan you proposed earlier in Ladder (executable plan, not a todo list). A plan still waiting for approval is replaced. For a plan already running only tasks that have not started can change; changing the executor, model, effort or permission of a pending task, or adding tasks, needs the user to confirm. Send the whole plan, not a patch. After calling it, end your turn.",
    inputSchema: REVISE_SCHEMA
  },
  {
    name: 'report_result',
    role: 'task',
    description:
      "Report the result of your task to Ladder. You are running one task of an executable plan: call this exactly once, when you are done, then end your turn. Report honestly: use status \"blocked\" when you need a decision from the user and \"failed\" when the task cannot be done. List the checks you ran, the decisions later tasks must respect, and any command with effects outside the folder (installs, migrations) so that nobody repeats it.",
    inputSchema: RESULT_INPUT_SCHEMA
  }
]

const SESSION_ID = { type: 'string', description: 'Id of a session you started with ladder_start_session.' }

/** Tools to make other agents work. Same server, coordinator role (any chat that is not a plan task). */
TOOLS.push(
  {
    name: 'ladder_list_sessions',
    role: 'coordinator',
    description: 'List the sessions of this Ladder project (id, title, agent, model, state, who started it). Read-only. Use it to see what is already running before starting another session.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'ladder_start_session',
    role: 'coordinator',
    description:
      'Start a new agent session in this Ladder project, with the agent you choose, and give it a prompt. Use it to delegate work to another agent or provider: for example ask Codex for a second opinion or a review, or have a cheaper agent do a self-contained task. The session works on its own and shows up in Ladder like any other. It returns a sessionId: call ladder_wait with it to get the answer and use that answer in your work. The new session never has more permission than you have (a read-only session can only start read-only sessions); in Ask mode the user is asked to approve each start. Limits: 5 sessions at work at once, 20 starts per hour, and sessions started by agents can nest 2 levels.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['agent', 'prompt'],
      properties: {
        agent: { type: 'string', description: '"claude-code", "codex" or "acp:<id>". It must be allowed in the project and available.' },
        prompt: { type: 'string', description: 'The complete instructions for the other agent. It does not see your conversation: include the context it needs.' },
        model: { type: ['string', 'null'], description: 'Model id, or omit for the agent default.' },
        effort: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'xhigh', 'max', null], description: 'Reasoning effort, or omit for the default.' },
        permission: { type: 'string', enum: ['plan', 'ask', 'edit', 'full'], description: '"plan" = read-only. Default: your own level, at most "edit". Never above your own level or the project maximum.' },
        worktree: { type: 'boolean', description: 'Work in its own git worktree. Default in a git project: true when the session can write files (permission "edit" or "full"), false for "plan" and "ask". Pass false to share your folder, but two agents writing in one folder conflict with each other. Without git the session always shares your folder.' },
        title: { type: 'string', maxLength: 120, description: 'Short title shown in Ladder.' }
      }
    }
  },
  {
    name: 'ladder_send',
    role: 'coordinator',
    description: 'Send a follow-up message to a session you started with ladder_start_session. If it is busy, the message waits for the end of its current turn. Then call ladder_wait to get the answer.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['sessionId', 'message'], properties: { sessionId: SESSION_ID, message: { type: 'string', description: 'What to tell the session.' } } }
  },
  {
    name: 'ladder_wait',
    role: 'coordinator',
    description:
      'Wait for a session you started to finish its work and return its final answer. It blocks up to timeoutSec (default 300, max 600). The result says the status: completed (with the answer), error, interrupted, needs-user (the session waits for the user in Ladder: tell the user), or timeout (still working: call ladder_wait again). Use the answer in your own work.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId: SESSION_ID, timeoutSec: { type: 'integer', minimum: 1, maximum: 600, description: 'How long to wait in this call (default 300).' } } }
  }
)

const toolSchema = (tool: ToolDef) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: { readOnlyHint: tool.name === 'ladder_list_sessions', destructiveHint: false, idempotentHint: false, openWorldHint: false }
})

interface Ctx {
  sessionId: string
  revoked: boolean
  calls: number[]
  /** Calls in progress: closing the session stops them. */
  inflight: Set<AbortController>
  /** For `notifications/cancelled`: JSON-RPC id → cancels that call. */
  cancels: Map<string | number, () => void>
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const result = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })

export class LadderMcpServer {
  private server: Server | null = null
  private starting: Promise<void> | null = null
  private port = 0
  private readonly tokens = new Map<string, Ctx>()
  private readonly sessions = new Map<string, { ctx: Ctx; hash: string }>()
  private readonly hooks: LadderMcpHooks

  constructor(hooks: LadderMcpHooks) {
    this.hooks = hooks
  }

  /** Starts on first need (before a chat's first runtime). */
  start(): Promise<void> {
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res))
      server.requestTimeout = 60_000
      server.headersTimeout = 10_000
      server.on('error', (error) => {
        if (!this.server) this.starting = null
        reject(error)
      })
      // IPv4 loopback only: never an interface reachable from the network.
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port
        this.server = server
        resolve()
      })
    })
    return this.starting
  }

  get started(): boolean {
    return this.server !== null
  }

  /** A new token for the session; the old one stops being valid. Null if the server has not started. */
  register(sessionId: string): LadderToolsHandle | null {
    if (!this.server) return null
    this.revoke(sessionId)
    const token = randomBytes(32).toString('hex')
    const ctx: Ctx = { sessionId, revoked: false, calls: [], inflight: new Set(), cancels: new Map() }
    const hash = sha(token)
    this.tokens.set(hash, ctx)
    this.sessions.set(sessionId, { ctx, hash })
    return { url: `http://127.0.0.1:${this.port}/mcp`, token }
  }

  revoke(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.ctx.revoked = true
    for (const controller of entry.ctx.inflight) controller.abort()
    this.tokens.delete(entry.hash)
    this.sessions.delete(sessionId)
  }

  async close(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.revoke(id)
    const server = this.server
    this.server = null
    this.starting = null
    if (server) await new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections()))
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private reply(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    if (res.headersSent) return
    const payload = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers, ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) })
    res.end(payload)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // A web page always sends Origin: no browser needs this server.
      if (req.headers.origin !== undefined) return this.reply(res, 403, { error: 'forbidden' })
      // DNS rebinding defense: the requested host must be loopback with our port.
      const host = String(req.headers.host ?? '')
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.reply(res, 403, { error: 'forbidden' })
      const auth = /^Bearer ([0-9a-f]{64})$/.exec(String(req.headers.authorization ?? ''))
      const ctx = auth ? this.tokens.get(sha(auth[1])) : undefined
      if (!ctx || ctx.revoked) return this.reply(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/mcp') return this.reply(res, 404, { error: 'not found' })
      if (req.method !== 'POST') return this.reply(res, 405, { error: 'method not allowed' }, { Allow: 'POST' })

      const raw = await this.body(req)
      if (raw === null) return this.reply(res, 413, { error: 'too large' })
      let message: unknown
      try {
        message = JSON.parse(raw)
      } catch {
        return this.reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      }
      const messages = Array.isArray(message) ? message : [message]
      if (messages.length === 0 || messages.length > 8) return this.reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })
      // A client closing the connection (agent Stop) also ends a long wait.
      const gone = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) gone.abort()
      })
      const out: unknown[] = []
      for (const item of messages) {
        const answer = await this.rpc(ctx, item, gone.signal)
        if (answer) out.push(answer)
      }
      if (out.length === 0) return this.reply(res, 202)
      this.reply(res, 200, Array.isArray(message) ? out : out[0])
    } catch {
      this.reply(res, 500, { error: 'internal error' })
    }
  }

  private body(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > LADDER_LIMITS.bodyBytes) {
          resolve(null)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(null))
    })
  }

  // ── JSON-RPC ─────────────────────────────────────────────────────────────

  private async rpc(ctx: Ctx, raw: unknown, gone: AbortSignal): Promise<object | null> {
    const m = raw as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
    const hasId = typeof m.id === 'string' || typeof m.id === 'number'
    const ok = (value: unknown) => (hasId ? { jsonrpc: '2.0', id: m.id, result: value } : null)
    const fail = (code: number, message: string) => (hasId ? { jsonrpc: '2.0', id: m.id, error: { code, message } } : null)
    const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>
    switch (m.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return ok({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ladder', version: '1.0.0' } })
      }
      case 'ping':
        return ok({})
      case 'tools/list': {
        const role = this.hooks.role(ctx.sessionId)
        return ok({ tools: role ? TOOLS.filter((tool) => tool.role === role).map(toolSchema) : [] })
      }
      case 'tools/call': {
        const role = this.hooks.role(ctx.sessionId)
        const tool = TOOLS.find((candidate) => candidate.name === params.name && candidate.role === role)
        if (!tool) return fail(-32602, 'Unknown tool')
        // Each call has its own signal: it fires if the client closes the connection, cancels with notifications/cancelled, or the session closes.
        const own = new AbortController()
        const cancel = () => own.abort()
        gone.addEventListener('abort', cancel, { once: true })
        ctx.inflight.add(own)
        if (hasId) ctx.cancels.set(m.id as string | number, cancel)
        try {
          return ok(await this.call(ctx, tool, params.arguments, own.signal))
        } finally {
          gone.removeEventListener('abort', cancel)
          ctx.inflight.delete(own)
          if (hasId) ctx.cancels.delete(m.id as string | number)
        }
      }
      case 'notifications/cancelled': {
        const id = params.requestId
        if (typeof id === 'string' || typeof id === 'number') ctx.cancels.get(id)?.()
        return null
      }
      default:
        // Notifications (initialized, cancelled…) are accepted and ignored.
        return hasId ? fail(-32601, 'Method not found') : null
    }
  }

  private async call(ctx: Ctx, tool: ToolDef, args: unknown, gone: AbortSignal): Promise<ToolResult> {
    if (ctx.revoked) return result('This session is closed.', true)
    const now = Date.now()
    ctx.calls = ctx.calls.filter((at) => now - at < 60_000)
    if (ctx.calls.length >= LADDER_LIMITS.callsPerMinute) return result('Too many calls in a minute. Wait a little before the next one.', true)
    ctx.calls.push(now)
    try {
      const answer = await this.hooks.call(ctx.sessionId, tool.name, args ?? {}, gone)
      return result(answer.text, answer.isError)
    } catch (error) {
      return result(`The tool failed: ${(error as Error).message.slice(0, 300)}`, true)
    }
  }
}
