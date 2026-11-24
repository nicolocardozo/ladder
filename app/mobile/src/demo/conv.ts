// Costruttore di conversazioni per le fixture: item con id, seq e orari coerenti. Adattato da
// app/desktop/src/renderer/src/dev/fixtures.ts (ConversationBuilder), ridotto a ciò che serve al telefono.
// Solo import di tipi: gira anche con `node` (harness) senza alias.
import type { ChatItem, FileChange, Question, RequestOption, ToolKind } from '@shared/protocol'

type Kind<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>

export const defaultOptions = (rule: string): RequestOption[] => [
  { id: 'allow', label: 'Approve', kind: 'allow' },
  { id: 'allow-always', label: `Always allow ${rule}`, kind: 'allow-always' },
  { id: 'deny', label: 'Deny', kind: 'deny' }
]

export class Conv {
  items: ChatItem[] = []
  private seq = 0
  private turnId = 't0'
  private turns = 0
  /** Orario dell'ultimo item: si cammina in avanti e poi `shiftToNow` allinea la fine. */
  clock = 0
  private readonly prefix: string

  constructor(prefix: string, start = 0) {
    this.prefix = prefix
    this.clock = start
  }

  private push<K extends ChatItem['kind']>(kind: K, fields: Omit<Kind<K>, 'id' | 'turnId' | 'seq' | 'at' | 'kind'>, advanceMs: number): Kind<K> {
    this.clock += advanceMs
    const seq = ++this.seq
    const item = { id: `${this.prefix}-${seq}`, turnId: this.turnId, seq, at: this.clock, kind, ...fields } as unknown as Kind<K>
    this.items.push(item)
    return item
  }

  turn() {
    this.turnId = `${this.prefix}-turn-${++this.turns}`
    return this
  }

  user(text: string, gapMs = 90_000) {
    return this.push('user', { text }, gapMs)
  }

  assistant(text: string, streaming = false, afterMs = 4_000) {
    return this.push('assistant', { text, streaming }, afterMs)
  }

  tool(tool: ToolKind, name: string, title: string, detail: string | null, opts: { status?: Kind<'tool'>['status']; output?: string | null; ms?: number } = {}) {
    const status = opts.status ?? 'done'
    const ms = opts.ms ?? 1_400
    const item = this.push('tool', { tool, name, title, detail, status, output: opts.output ?? null, endedAt: null }, 900)
    if (status !== 'running') {
      item.endedAt = item.at + ms
      this.clock += ms
    }
    return item
  }

  permission(f: { toolName: string; title: string; command?: string | null; path?: string | null; reason?: string | null; preview?: string; state?: Kind<'request'>['state']; resolution?: string | null; rule?: string }) {
    return this.push(
      'request',
      {
        requestId: `${this.prefix}-req-${this.seq + 1}`,
        requestType: 'permission',
        toolName: f.toolName,
        title: f.title,
        command: f.command ?? null,
        path: f.path ?? null,
        reason: f.reason ?? null,
        options: defaultOptions(f.rule ?? f.toolName),
        questions: null,
        state: f.state ?? 'open',
        resolution: f.resolution ?? null,
        preview: f.preview ? { text: f.preview, lines: f.preview.split('\n').length, truncated: false } : null
      },
      1_200
    )
  }

  question(questions: Question[], state: Kind<'request'>['state'] = 'open', resolution: string | null = null) {
    return this.push(
      'request',
      {
        requestId: `${this.prefix}-req-${this.seq + 1}`,
        requestType: 'question',
        toolName: 'AskUserQuestion',
        title: 'Claude Code has a question',
        command: null,
        path: null,
        reason: null,
        options: [{ id: 'deny', label: 'Deny', kind: 'deny' }],
        questions,
        state,
        resolution
      },
      1_500
    )
  }

  end(f: { durationMs: number; status?: Kind<'turn-end'>['status']; files?: FileChange[]; error?: string | null }) {
    const tools = this.items.filter((i): i is Kind<'tool'> => i.kind === 'tool' && i.turnId === this.turnId)
    const count = (k: ToolKind) => tools.filter((t) => t.tool === k).length
    return this.push(
      'turn-end',
      {
        status: f.status ?? 'completed',
        durationMs: f.durationMs,
        counts: { commands: count('command'), edits: count('edit'), reads: count('read'), searches: count('search') },
        files: f.files ?? [],
        error: f.error ?? null,
        costUsd: null
      },
      600
    )
  }

  notice(text: string, tone: 'info' | 'error' = 'info') {
    return this.push('notice', { text, tone }, 2_000)
  }

  /** Sposta tutti gli orari in modo che l'ultimo item sia di `agoMs` fa. */
  shiftTo(now: number, agoMs: number): ChatItem[] {
    const delta = now - agoMs - this.clock
    for (const item of this.items) {
      item.at += delta
      if (item.kind === 'tool' && item.endedAt !== null) item.endedAt += delta
    }
    this.clock += delta
    return this.items
  }
}
