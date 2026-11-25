// "Ask for a review from…": another agent reads the session's diff read-only, with the project's review prompt,
// and replies with structured comments (file, line, text) that go back into the Changes panel.
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import { getLocale, t } from '@shared/i18n'
import type { AgentId, DiffScope, RequestResponse, ReviewNote, ReviewState } from '@shared/protocol'
import type { AdapterEvents, AgentSession, SessionOptions, UserRequest } from './agents/common'
import { git } from './git'

const MAX_DIFF = 150_000
const TIMEOUT_MS = 6 * 60_000

/** Response schema: Codex applies it with outputSchema, the others are asked in words. */
export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, line: { type: 'integer' }, body: { type: 'string' } },
        required: ['path', 'line', 'body'],
        additionalProperties: false
      }
    }
  },
  required: ['summary', 'comments'],
  additionalProperties: false
}

export async function patchText(root: string, from: string, to: string): Promise<string> {
  const text = await git(root, ['diff', '--relative', '--no-color', '-U3', from, to])
  return text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n${t('… (diff truncated)')}` : text
}

export function reviewPrompt(base: string, patch: string): string {
  // Instructions for the agent: English by default, Italian if the app language is Italian.
  if (getLocale() === 'it') {
    return `${base}

Rispondi solo con un oggetto JSON, senza altro testo prima o dopo:
{"summary": "giudizio in una o due frasi", "comments": [{"path": "percorso/relativo", "line": 12, "body": "problema e proposta"}]}
"line" è il numero di riga nel file dopo le modifiche. Se non trovi problemi, "comments" è un elenco vuoto.

Modifiche da rivedere (diff unificato):
\`\`\`diff
${patch}
\`\`\``
  }
  return `${base}

Reply only with a JSON object, with no other text before or after it:
{"summary": "verdict in one or two sentences", "comments": [{"path": "relative/path", "line": 12, "body": "problem and suggested fix"}]}
"line" is the line number in the file after the changes. If you find no problems, "comments" is an empty list.

Changes to review (unified diff):
\`\`\`diff
${patch}
\`\`\``
}

/** Extracts { summary, comments } from the agent's final text, even inside a code block. */
export function parseReview(text: string, root: string): { summary: string | null; comments: ReviewNote[] } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(t('The review is not a JSON object.'))
  const data = JSON.parse(text.slice(start, end + 1)) as { summary?: unknown; comments?: unknown }
  const comments: ReviewNote[] = []
  for (const raw of Array.isArray(data.comments) ? data.comments : []) {
    const c = raw as { path?: unknown; line?: unknown; body?: unknown }
    if (typeof c.path !== 'string' || typeof c.body !== 'string') continue
    const path = isAbsolute(c.path) ? relative(root, c.path) : c.path.replace(/^\.\//, '')
    comments.push({ path, line: Math.max(1, Math.round(Number(c.line) || 1)), body: c.body.trim() })
  }
  return { summary: typeof data.summary === 'string' ? data.summary.trim() : null, comments }
}

export interface ReviewDeps {
  create: (agent: AgentId, options: SessionOptions & { outputSchema?: unknown }, events: AdapterEvents) => AgentSession
  publish: (review: ReviewState) => void
}

/** A review in progress: short-lived adapter, read-only, closed at the end of the turn. */
export class ReviewRun {
  readonly state: ReviewState
  private adapter: AgentSession | null = null
  private timer: NodeJS.Timeout | null = null
  private finalText = ''

  constructor(
    private readonly deps: ReviewDeps,
    init: { sessionId: string; agent: AgentId; agentName: string; scope: DiffScope }
  ) {
    this.state = { id: randomUUID(), ...init, state: 'running', summary: null, comments: [], error: null, startedAt: Date.now() }
  }

  start(cwd: string, prompt: string): void {
    const texts = new Map<string, string>()
    const events: AdapterEvents = {
      init: () => undefined,
      assistant: (id, text) => {
        texts.set(id, text)
        this.finalText = text
      },
      tool: () => undefined,
      activity: () => undefined,
      subagent: () => undefined,
      usage: () => undefined,
      commands: () => undefined,
      compacted: () => undefined,
      // Read-only needs no approvals: every request is rejected.
      request: async (request: UserRequest): Promise<RequestResponse> => {
        const deny = request.options.find((o) => o.kind === 'deny')
        return deny ? { optionId: deny.id, message: t('Read-only review: no edits and no commands that change files.') } : { answers: {} }
      },
      turnEnd: (result) => {
        if (this.state.state !== 'running') return
        if (result.status !== 'completed') return this.finish({ state: result.status === 'interrupted' ? 'cancelled' : 'error', error: result.error ?? t('The review stopped.') })
        try {
          const parsed = parseReview(this.finalText || [...texts.values()].at(-1) || '', cwd)
          this.finish({ state: 'done', summary: parsed.summary, comments: parsed.comments })
        } catch (error) {
          this.finish({ state: 'error', error: t('{error} Reply: {reply}', { error: (error as Error).message, reply: this.finalText.slice(0, 200) }) })
        }
      },
      notice: (tone, text) => {
        if (tone === 'error' && this.state.state === 'running' && /non è partito|failed to start/.test(text)) this.finish({ state: 'error', error: text })
      },
      account: () => undefined,
      exit: (error) => {
        if (error && this.state.state === 'running') this.finish({ state: 'error', error })
      }
    }
    const { outputSchema, agent } = { outputSchema: REVIEW_SCHEMA, agent: this.state.agent }
    this.adapter = this.deps.create(agent, { cwd, model: null, effort: null, permission: 'plan', resume: null, outputSchema }, events)
    this.adapter.start()
    this.adapter.send(prompt)
    this.timer = setTimeout(() => this.finish({ state: 'error', error: t('The review took more than 6 minutes.') }), TIMEOUT_MS)
    this.deps.publish(this.state)
  }

  cancel(): void {
    if (this.state.state === 'running') this.finish({ state: 'cancelled' })
  }

  private finish(patch: Partial<ReviewState>): void {
    if (this.state.state !== 'running') return
    Object.assign(this.state, patch)
    if (this.timer) clearTimeout(this.timer)
    const adapter = this.adapter
    this.adapter = null
    // Closed after the response: the agent must not stay running.
    setTimeout(() => adapter?.close(), 100)
    this.deps.publish(this.state)
  }
}
