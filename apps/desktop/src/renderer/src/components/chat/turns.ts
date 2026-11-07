// Raggruppa gli elementi della chat in turni e mantiene gli oggetti stabili tra un aggiornamento e l'altro,
// così le righe memorizzate non si ridisegnano quando cambia solo il messaggio in streaming.
import type { ChatItem } from '@shared/protocol'

export type UserItem = Extract<ChatItem, { kind: 'user' }>
export type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>
export type ToolItem = Extract<ChatItem, { kind: 'tool' }>
export type RequestItem = Extract<ChatItem, { kind: 'request' }>
export type TurnEndItem = Extract<ChatItem, { kind: 'turn-end' }>
export type NoticeItem = Extract<ChatItem, { kind: 'notice' }>

export interface Turn {
  id: string
  /** Elementi del turno in ordine di seq. */
  items: ChatItem[]
  user: UserItem | null
  /** Tutto ciò che sta tra il messaggio dell'utente e la risposta finale (o la fine, se il turno è in corso). */
  steps: ChatItem[]
  /** Ultimo messaggio dell'agente, solo a turno finito. */
  final: AssistantItem | null
  /** Avvisi del turno finito: restano visibili anche quando i passaggi sono chiusi. */
  notices: NoticeItem[]
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
  const notices: NoticeItem[] = []
  const open: RequestItem[] = []
  for (const item of items) {
    if (item === user || item === end || item === final) continue
    if (item.kind === 'request' && item.state === 'open') open.push(item)
    else if (end && item.kind === 'notice') notices.push(item)
    else steps.push(item)
  }

  return { id, items, user, steps, final, notices, open, end, toolCount, startedAt: items[0]?.at ?? 0 }
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

/** Stima dell'altezza di un turno prima della misura reale: riduce i salti dello scroll. */
export function estimateTurnHeight(turn: Turn): number {
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
  if (turn.user) h += Math.min(6, Math.ceil(turn.user.text.length / 70) + turn.user.text.split('\n').length - 1) * 19.5 + 28
  if (turn.end) {
    if (turn.toolCount > 0) h += 34
    if (turn.final) h += textHeight(turn.final.text, 23.2, 86) * 0.8
    if (turn.end.files.length > 0) h += 52 + turn.end.files.length * 27
    if (turn.end.status !== 'completed') h += 30
  } else {
    for (const step of turn.steps) {
      if (step.kind === 'tool') h += 24
      else if (step.kind === 'assistant') h += textHeight(step.text, 23.2, 86) * 0.8 + 12
      else h += 26
    }
    h += turn.open.length * 190 + 32
  }
  return Math.round(h)
}
