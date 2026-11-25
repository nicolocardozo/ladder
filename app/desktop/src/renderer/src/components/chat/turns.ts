// Groups chat items into turns and keeps objects stable between updates,
// so memoized rows don't redraw when only the streaming message changes.
import type { AppPrefs, ChatFont, ChatItem, TextSize } from '@shared/protocol'

export type UserItem = Extract<ChatItem, { kind: 'user' }>
export type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>
export type ToolItem = Extract<ChatItem, { kind: 'tool' }>
export type RequestItem = Extract<ChatItem, { kind: 'request' }>
export type TurnEndItem = Extract<ChatItem, { kind: 'turn-end' }>
export type NoticeItem = Extract<ChatItem, { kind: 'notice' }>
export type CommandItem = Extract<ChatItem, { kind: 'command' }>
export type AgentStartItem = Extract<ChatItem, { kind: 'agent-start' }>
export type AgentsFinishedItem = Extract<ChatItem, { kind: 'agents-finished' }>
export type CompactedItem = Extract<ChatItem, { kind: 'compacted' }>
export type HandoffChatItem = Extract<ChatItem, { kind: 'handoff' }>
export type AdviceChatItem = Extract<ChatItem, { kind: 'advice' }>
export type ResumeChatItem = Extract<ChatItem, { kind: 'resume' }>
export type LimitChatItem = Extract<ChatItem, { kind: 'limit' }>
export type PlanItem = Extract<ChatItem, { kind: 'plan' }>

export interface Turn {
  id: string
  /** Turn items in seq order. */
  items: ChatItem[]
  user: UserItem | null
  /** Everything between the user message and the final reply (or the end, if the turn is in progress). */
  steps: ChatItem[]
  /** Ultimo messaggio dell'agente, solo a turno finito. */
  final: AssistantItem | null
  /** Commands / of the turn: system rows that open the turn in place of the user message, always visible. */
  commands: CommandItem[]
  /** System row of turns opened by the agent, in place of the user message. */
  start: AgentStartItem | null
  /** Agent handoff separator that opens the turn in place of the user message. */
  handoff: HandoffChatItem | null
  /** Cards of /advisor and /committee: system rows, each with its own turn (see groupTurns). */
  advice: AdviceChatItem[]
  /** System cards for resuming a delegation and for the plan limit: each has its own group and stays visible even with collapsed steps. */
  cards: (ResumeChatItem | LimitChatItem)[]
  /** End of background sub-agents with the coordinator idle: it sits at the bottom of the turn, never inside the summary. */
  finished: AgentsFinishedItem[]
  /** Notices and compactions of the finished turn: they stay visible even when the steps are closed. */
  notices: (NoticeItem | CompactedItem)[]
  /** Open requests: they are never closed into the summary. */
  open: RequestItem[]
  end: TurnEndItem | null
  toolCount: number
  startedAt: number
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false
    return true
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

/** Equality by content: it holds even if the caller recreates the objects (for example after IPC). */
export function sameItem(a: ChatItem, b: ChatItem): boolean {
  return a === b || sameValue(a, b)
}

function buildTurn(id: string, items: ChatItem[]): Turn {
  let user: UserItem | null = null
  let end: TurnEndItem | null = null
  let lastAssistant = -1
  let toolCount = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'user' && !user) user = item
    else if (item.kind === 'turn-end') end = item
    else if (item.kind === 'assistant') lastAssistant = i
    else if (item.kind === 'tool') toolCount++
  }

  const final = end && lastAssistant >= 0 ? (items[lastAssistant] as AssistantItem) : null
  const steps: ChatItem[] = []
  const notices: (NoticeItem | CompactedItem)[] = []
  const commands: CommandItem[] = []
  let start: AgentStartItem | null = null
  let handoff: HandoffChatItem | null = null
  const advice: AdviceChatItem[] = []
  const cards: (ResumeChatItem | LimitChatItem)[] = []
  const open: RequestItem[] = []
  const finished: AgentsFinishedItem[] = []
  for (const item of items) {
    if (item === user || item === end || item === final) continue
    if (item.kind === 'agent-start') {
      start ??= item
      continue
    }
    if (item.kind === 'handoff') {
      handoff ??= item
      continue
    }
    if (item.kind === 'advice') {
      advice.push(item)
      continue
    }
    if (item.kind === 'resume' || item.kind === 'limit') {
      cards.push(item)
      continue
    }
    if (item.kind === 'agents-finished') {
      finished.push(item)
      continue
    }
    if (item.kind === 'request' && item.state === 'open') open.push(item)
    else if (item.kind === 'command') commands.push(item)
    else if (end && (item.kind === 'notice' || item.kind === 'compacted')) notices.push(item)
    else steps.push(item)
  }

  return { id, items, user, start, handoff, advice, cards, commands, steps, final, notices, open, finished, end, toolCount, startedAt: items[0]?.at ?? 0 }
}

/** Group key: the turnId, except for advice cards (system rows that belong to no turn). */
export const turnKey = (item: ChatItem): string =>
  item.kind === 'advice' || item.kind === 'resume' || item.kind === 'limit' ? `${item.kind}:${item.id}` : item.kind === 'handoff' && item.turnId === 'system' ? `handoff:${item.id}` : item.turnId

/** The turn is only a system row (advice card, or 'implement' handoff with turnId 'system'): it is never "the running turn". */
export const isAdviceTurn = (turn: Turn): boolean => (turn.advice.length > 0 && turn.items.length === turn.advice.length) || (turn.cards.length > 0 && turn.items.length === turn.cards.length) || (turn.items.length === 1 && turn.handoff !== null && turn.id.startsWith('handoff:'))

export interface TurnCache {
  byId: Map<string, ChatItem>
  turns: Map<string, Turn>
  list: Turn[]
}

export function createTurnCache(): TurnCache {
  return { byId: new Map(), turns: new Map(), list: [] }
}

/**
 * Groups by turnId (in order of first appearance) reusing the previous objects
 * when the content hasn't changed. Returns the same list if nothing changed.
 */
export function groupTurns(items: ChatItem[], cache: TurnCache): Turn[] {
  const byId = new Map<string, ChatItem>()
  const groups = new Map<string, ChatItem[]>()
  for (const raw of items) {
    const prev = cache.byId.get(raw.id)
    const item = prev && sameItem(prev, raw) ? prev : raw
    byId.set(item.id, item)
    // Advice cards have turnId 'system': each gets its own group, otherwise they would all merge into the first one.
    const key = turnKey(item)
    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
    }
    group.push(item)
  }

  const turns = new Map<string, Turn>()
  const list: Turn[] = []
  let changed = cache.list.length !== groups.size
  let index = 0
  for (const [id, group] of groups) {
    const prev = cache.turns.get(id)
    let turn: Turn
    if (prev && prev.items.length === group.length && prev.items.every((it, i) => it === group[i])) turn = prev
    else turn = buildTurn(id, group)
    if (cache.list[index] !== turn) changed = true
    turns.set(id, turn)
    list.push(turn)
    index++
  }

  cache.byId = byId
  cache.turns = turns
  if (changed) cache.list = list
  return cache.list
}

/** Chat text width (Settings, Appearance): prefs.chatWidth. */
export type ChatWidth = AppPrefs['chatWidth']

/** Metrics per chat font: body, line height and width in em of the "0" (the ch unit) and of an average text character. */
const FONT_METRICS: Record<ChatFont, { size: number; line: number; ch: number; avg: number }> = {
  'system-mono': { size: 14, line: 23.1, ch: 0.6, avg: 0.6 },
  'monaspace-neon': { size: 14, line: 23.1, ch: 0.6, avg: 0.6 },
  'system-sans': { size: 15, line: 24, ch: 0.6, avg: 0.5 },
  'mona-sans': { size: 15, line: 24, ch: 0.6, avg: 0.49 }
}

/** Step in px of each text size (same figures as --chat-step in globals.css). */
const TEXT_STEP: Record<TextSize, number> = { small: -1, default: 0, large: 2, xlarge: 4 }

/** Text limit in px for each setting (same figures as --chat-measure in chat.css). */
const MEASURE_PX: Record<ChatWidth, number> = { comfortable: 820, wide: 1100, full: Infinity }

export interface ChatColumn {
  /** Characters per line of the reply and of the user bubble, according to the effective width of the text column. */
  chars: number
  userChars: number
  line: number
}

/**
 * Effective text column: the view minus margins, capped at 820 or 1100 px (all of it with 'full'); characters per line come from the font metrics.
 * `viewport` is the width of the scrolling area; 0 if not measured yet.
 */
export function chatColumn(font: ChatFont, width: ChatWidth, viewport: number, compact: boolean, size: TextSize = 'default'): ChatColumn {
  const base = FONT_METRICS[font]
  // Body and line height grow together (--chat-step in globals.css adds px to the body; line height stays proportional).
  const body = base.size + TEXT_STEP[size]
  const m = { ...base, size: body, line: base.line * (body / base.size) }
  const room = Math.max(160, (viewport > 0 ? viewport : 900) - (compact ? 24 : 48))
  const text = Math.min(room, MEASURE_PX[width])
  // The bubble sits at 82% of the column, at most 100 ch, with 12 px of padding per side.
  const bubble = Math.min(text * 0.82, 100 * m.ch * m.size) - 24
  const chars = (px: number) => Math.max(12, Math.floor(px / (m.avg * m.size)))
  return { chars: chars(text), userChars: chars(bubble), line: m.line }
}

const DEFAULT_COLUMN = chatColumn('system-sans', 'comfortable', 0, false)

/** Estimate of a turn's height before the real measurement: reduces scroll jumps. */
export function estimateTurnHeight(turn: Turn, m: ChatColumn = DEFAULT_COLUMN): number {
  const textHeight = (text: string, lineHeight: number, charsPerLine: number) => {
    let h = 0
    let inCode = false
    for (const line of text.split('\n')) {
      if (line.startsWith('```')) {
        inCode = !inCode
        h += inCode ? 40 : 14
        continue
      }
      h += inCode ? 19.5 : Math.max(1, Math.ceil(line.length / charsPerLine)) * lineHeight
    }
    return h
  }
  let h = 28
  if (turn.user) h += Math.min(6, Math.ceil(turn.user.text.length / m.userChars) + turn.user.text.split('\n').length - 1) * m.line + 28
  h += turn.commands.length * 26 + (turn.start ? 26 : 0) + (turn.handoff ? (turn.handoff.direction === 'in' ? 90 : 26) : 0)
  h += turn.cards.length * 100
  for (const a of turn.advice) h += 56 + (a.entries.length > 1 ? 210 : 180) + 40
  // Messages inserted into the turn: rows of their own, even after the summary.
  const userHeight = (text: string, steered?: boolean) => Math.min(6, Math.ceil(text.length / m.userChars) + text.split('\n').length - 1) * m.line + 28 + (steered ? 18 : 0)
  if (turn.end) {
    for (const step of turn.steps) if (step.kind === 'user') h += userHeight(step.text, step.steered)
    if (turn.toolCount > 0) h += 34
    if (turn.final) h += textHeight(turn.final.text, m.line, m.chars) * 0.8
    // Single row, closed by default: when open, the list lengthens it and the real measurement replaces the estimate.
    if (turn.end.files.length > 0) h += 36
    if (turn.end.status !== 'completed') h += 30
    // "It stopped without asking" notice: one row and the hint below.
    if (turn.end.stalled && turn.end.status === 'completed') h += 44
  } else {
    for (const step of turn.steps) {
      if (step.kind === 'tool') h += 24
      else if (step.kind === 'user') h += userHeight(step.text, step.steered)
      else if (step.kind === 'assistant') h += textHeight(step.text, m.line, m.chars) * 0.8 + 12
      else h += 26
    }
    h += turn.open.length * 190 + 32
  }
  // Agents-finished rows: "waiting" with a button and explanation (two lines), "continued" one line; 'resumed' is usually hidden by the start row and 'dismissed' isn't shown.
  // Plan card: tall while in review or running (the measured height replaces the estimate), one row once closed.
  h += turn.items.filter((i) => i.kind === 'plan').length * 260
  for (const f of turn.finished) {
    if (f.state === 'waiting') h += 62
    else if (f.state === 'continued') h += 26
  }
  return Math.round(h)
}
