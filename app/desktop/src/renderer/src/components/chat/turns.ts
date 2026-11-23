// Raggruppa gli elementi della chat in turni e mantiene gli oggetti stabili tra un aggiornamento e l'altro,
// così le righe memorizzate non si ridisegnano quando cambia solo il messaggio in streaming.
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

export interface Turn {
  id: string
  /** Elementi del turno in ordine di seq. */
  items: ChatItem[]
  user: UserItem | null
  /** Tutto ciò che sta tra il messaggio dell'utente e la risposta finale (o la fine, se il turno è in corso). */
  steps: ChatItem[]
  /** Ultimo messaggio dell'agente, solo a turno finito. */
  final: AssistantItem | null
  /** Comandi / del turno: righe di sistema che aprono il turno al posto del messaggio dell'utente, sempre visibili. */
  commands: CommandItem[]
  /** Riga di sistema dei turni aperti dall'agente, al posto del messaggio dell'utente. */
  start: AgentStartItem | null
  /** Fine dei sotto-agenti in background con il coordinatore fermo: sta in fondo al turno, mai dentro il riepilogo. */
  finished: AgentsFinishedItem[]
  /** Avvisi e compattazioni del turno finito: restano visibili anche quando i passaggi sono chiusi. */
  notices: (NoticeItem | CompactedItem)[]
  /** Richieste aperte: non si chiudono mai nel riepilogo. */
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

/** Uguaglianza per contenuto: regge anche se il chiamante ricrea gli oggetti (per esempio dopo l'IPC). */
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
  const open: RequestItem[] = []
  const finished: AgentsFinishedItem[] = []
  for (const item of items) {
    if (item === user || item === end || item === final) continue
    if (item.kind === 'agent-start') {
      start ??= item
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

  return { id, items, user, start, commands, steps, final, notices, open, finished, end, toolCount, startedAt: items[0]?.at ?? 0 }
}

export interface TurnCache {
  byId: Map<string, ChatItem>
  turns: Map<string, Turn>
  list: Turn[]
}

export function createTurnCache(): TurnCache {
  return { byId: new Map(), turns: new Map(), list: [] }
}

/**
 * Raggruppa per turnId (nell'ordine della prima apparizione) riusando gli oggetti precedenti
 * quando il contenuto non è cambiato. Restituisce la stessa lista se nulla è cambiato.
 */
export function groupTurns(items: ChatItem[], cache: TurnCache): Turn[] {
  const byId = new Map<string, ChatItem>()
  const groups = new Map<string, ChatItem[]>()
  for (const raw of items) {
    const prev = cache.byId.get(raw.id)
    const item = prev && sameItem(prev, raw) ? prev : raw
    byId.set(item.id, item)
    let group = groups.get(item.turnId)
    if (!group) {
      group = []
      groups.set(item.turnId, group)
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

/** Larghezza del testo della chat (Impostazioni, Aspetto): prefs.chatWidth. */
export type ChatWidth = AppPrefs['chatWidth']

/** Metriche per font della chat: corpo, interlinea e larghezza in em del "0" (l'unità ch) e di un carattere medio di testo. */
const FONT_METRICS: Record<ChatFont, { size: number; line: number; ch: number; avg: number }> = {
  'system-mono': { size: 14, line: 23.1, ch: 0.6, avg: 0.6 },
  'monaspace-neon': { size: 14, line: 23.1, ch: 0.6, avg: 0.6 },
  'system-sans': { size: 15, line: 24, ch: 0.6, avg: 0.5 },
  'mona-sans': { size: 15, line: 24, ch: 0.6, avg: 0.49 }
}

/** Passo in px di ogni dimensione del testo (stesse cifre di --chat-step in globals.css). */
const TEXT_STEP: Record<TextSize, number> = { small: -1, default: 0, large: 2, xlarge: 4 }

/** Limite del testo in px per ogni impostazione (stesse cifre di --chat-measure in chat.css). */
const MEASURE_PX: Record<ChatWidth, number> = { comfortable: 820, wide: 1100, full: Infinity }

export interface ChatColumn {
  /** Caratteri per riga della risposta e della bolla utente, secondo la larghezza effettiva della colonna di testo. */
  chars: number
  userChars: number
  line: number
}

/**
 * Colonna di testo effettiva: la vista meno i margini, limitata a 820 o 1100 px (tutta con 'full'); i caratteri per riga vengono dalle metriche del font.
 * `viewport` è la larghezza della zona che scorre; 0 se non è ancora misurata.
 */
export function chatColumn(font: ChatFont, width: ChatWidth, viewport: number, compact: boolean, size: TextSize = 'default'): ChatColumn {
  const base = FONT_METRICS[font]
  // Corpo e interlinea crescono insieme (--chat-step in globals.css somma px al corpo; l'interlinea resta proporzionale).
  const body = base.size + TEXT_STEP[size]
  const m = { ...base, size: body, line: base.line * (body / base.size) }
  const room = Math.max(160, (viewport > 0 ? viewport : 900) - (compact ? 24 : 48))
  const text = Math.min(room, MEASURE_PX[width])
  // La bolla sta all'82% della colonna, al massimo 100 ch, con 12 px di padding per lato.
  const bubble = Math.min(text * 0.82, 100 * m.ch * m.size) - 24
  const chars = (px: number) => Math.max(12, Math.floor(px / (m.avg * m.size)))
  return { chars: chars(text), userChars: chars(bubble), line: m.line }
}

const DEFAULT_COLUMN = chatColumn('system-sans', 'comfortable', 0, false)

/** Stima dell'altezza di un turno prima della misura reale: riduce i salti dello scroll. */
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
  h += turn.commands.length * 26 + (turn.start ? 26 : 0)
  // Messaggi inseriti nel turno: righe a sé, anche dopo il riepilogo.
  const userHeight = (text: string, steered?: boolean) => Math.min(6, Math.ceil(text.length / m.userChars) + text.split('\n').length - 1) * m.line + 28 + (steered ? 18 : 0)
  if (turn.end) {
    for (const step of turn.steps) if (step.kind === 'user') h += userHeight(step.text, step.steered)
    if (turn.toolCount > 0) h += 34
    if (turn.final) h += textHeight(turn.final.text, m.line, m.chars) * 0.8
    // Riga unica, chiusa per default: aperta, l'elenco la allunga e la misura reale sostituisce la stima.
    if (turn.end.files.length > 0) h += 36
    if (turn.end.status !== 'completed') h += 30
    // Avviso "si è fermato senza chiedere": una riga e il suggerimento sotto.
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
  // Righe di fine agenti: "waiting" con pulsante e spiegazione (due righe), "continued" una riga; 'resumed' di solito è nascosta dalla riga di avvio e 'dismissed' non si vede.
  for (const f of turn.finished) {
    if (f.state === 'waiting') h += 62
    else if (f.state === 'continued') h += 26
  }
  return Math.round(h)
}
