// From the flat list of chat items to the rows of the Session screen: finished turns collapse into one row
// ("Edited 2 files and ran 3 commands") with the final answer in plain view; the ongoing turn stays open with the current step.
// Rewrite designed for the phone (for the idea, see Paseo's turn collapsing and the desktop chat). Pure logic only.
import type { ChatItem, FileChange, RunState } from '@shared/protocol'

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>
export type RequestItem = Extract<ChatItem, { kind: 'request' }>
export type TurnEndItem = Extract<ChatItem, { kind: 'turn-end' }>

export interface TurnCounts {
  edits: number
  commands: number
  reads: number
  searches: number
  other: number
}

export interface TurnSummary {
  turnId: string
  /** Tools, requests and intermediate texts of the turn, in order: for the steps sheet. */
  steps: ChatItem[]
  counts: TurnCounts
  files: FileChange[]
  end: TurnEndItem | null
  running: boolean
  /** The turn is waiting for you (open request): no spinning ring. */
  waiting: boolean
  /** Current step of the ongoing turn: the tool that is running. */
  current: ToolItem | null
  startedAt: number
}

export type ChatRow =
  | { kind: 'user'; key: string; item: Extract<ChatItem, { kind: 'user' }> }
  | { kind: 'assistant'; key: string; item: Extract<ChatItem, { kind: 'assistant' }> }
  | { kind: 'turn'; key: string; turn: TurnSummary }
  | { kind: 'note'; key: string; tone: 'info' | 'error'; text: string; at: number }
  | { kind: 'stopped'; key: string; end: TurnEndItem }

export function countTools(items: ChatItem[]): TurnCounts {
  const c: TurnCounts = { edits: 0, commands: 0, reads: 0, searches: 0, other: 0 }
  for (const i of items) {
    if (i.kind !== 'tool') continue
    if (i.tool === 'edit') c.edits++
    else if (i.tool === 'command') c.commands++
    else if (i.tool === 'read') c.reads++
    else if (i.tool === 'search') c.searches++
    else c.other++
  }
  return c
}

/** Open requests (even from several turn sessions): shown in the foreground above the composer, not in the list. */
export function openRequests(items: ChatItem[]): RequestItem[] {
  return items.filter((i): i is RequestItem => i.kind === 'request' && i.state === 'open')
}

export function buildChatRows(items: ChatItem[], run: RunState = 'running'): ChatRow[] {
  const sorted = [...items].sort((a, b) => a.seq - b.seq)
  const turnOrder: string[] = []
  const byTurn = new Map<string, ChatItem[]>()
  for (const item of sorted) {
    if (!byTurn.has(item.turnId)) {
      byTurn.set(item.turnId, [])
      turnOrder.push(item.turnId)
    }
    byTurn.get(item.turnId)!.push(item)
  }
  const rows: ChatRow[] = []
  turnOrder.forEach((turnId, index) => {
    const list = byTurn.get(turnId)!
    const end = list.find((i): i is TurnEndItem => i.kind === 'turn-end') ?? null
    const isLast = index === turnOrder.length - 1
    // A turn without turn-end is in progress only if it is the last one (and still has something open).
    // With the session idle or in error a turn without turn-end is over (host restart, interruption).
    const running = !end && isLast && run !== 'idle' && run !== 'error'
    for (const item of list) if (item.kind === 'user') rows.push({ kind: 'user', key: item.id, item })
    for (const item of list) {
      if (item.kind === 'notice') rows.push({ kind: 'note', key: item.id, tone: item.tone, text: item.text, at: item.at })
      else if (item.kind === 'command') rows.push({ kind: 'note', key: item.id, tone: item.status === 'error' ? 'error' : 'info', text: `/${item.name}${item.args ? ` ${item.args}` : ''}${item.error ? `: ${item.error}` : ''}`, at: item.at })
    }
    const tools = list.filter((i): i is ToolItem => i.kind === 'tool')
    const assistants = list.filter((i): i is Extract<ChatItem, { kind: 'assistant' }> => i.kind === 'assistant')
    const final = assistants[assistants.length - 1]
    const hasSteps = tools.length > 0 || list.some((i) => i.kind === 'request')
    const counts = countTools(list)
    const summary: TurnSummary = {
      turnId,
      // Steps: tools, requests and, once the turn is over, the intermediate texts (the final answer stays outside).
      steps: list.filter((i) => i.kind === 'tool' || i.kind === 'request' || (i.kind === 'assistant' && (running || i !== final))),
      counts,
      files: end?.files ?? [],
      end,
      running,
      waiting: running && run === 'waiting',
      current: running ? ([...tools].reverse().find((t) => t.status === 'running') ?? null) : null,
      startedAt: list[0]?.at ?? 0
    }
    if (running) {
      // The ongoing turn stays open: agent texts in plain view, then the current step row.
      for (const a of assistants) rows.push({ kind: 'assistant', key: a.id, item: a })
      if (hasSteps || assistants.length === 0) rows.push({ kind: 'turn', key: `turn-${turnId}`, turn: summary })
    } else {
      if (hasSteps) rows.push({ kind: 'turn', key: `turn-${turnId}`, turn: summary })
      if (final) rows.push({ kind: 'assistant', key: final.id, item: final })
      if (end && end.status !== 'completed') rows.push({ kind: 'stopped', key: end.id, end })
    }
  })
  return rows
}

export interface SummaryPart {
  key: 'edits' | 'commands' | 'reads' | 'searches'
  n: number
}

/** The parts of the summary sentence, in order of importance. The UI (i18n) composes the text. */
export function summaryParts(counts: TurnCounts, files: FileChange[]): SummaryPart[] {
  const parts: SummaryPart[] = []
  const edits = files.length > 0 ? files.length : counts.edits
  if (edits > 0) parts.push({ key: 'edits', n: edits })
  if (counts.commands > 0) parts.push({ key: 'commands', n: counts.commands })
  if (counts.reads > 0) parts.push({ key: 'reads', n: counts.reads })
  if (counts.searches > 0) parts.push({ key: 'searches', n: counts.searches })
  return parts
}
