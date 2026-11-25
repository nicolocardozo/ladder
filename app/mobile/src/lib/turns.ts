// Dalla lista piatta di item della chat alle righe della schermata Session: i turni conclusi si chiudono in una riga
// ("Edited 2 files and ran 3 commands") con la risposta finale in chiaro; il turno in corso resta aperto con il passaggio attuale.
// Riscrittura pensata per il telefono (vedi, per l'idea, il collasso dei turni di Paseo e la chat del desktop). Solo logica pura.
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
  /** Strumenti, richieste e testi intermedi del turno, in ordine: per lo sheet dei passaggi. */
  steps: ChatItem[]
  counts: TurnCounts
  files: FileChange[]
  end: TurnEndItem | null
  running: boolean
  /** Il turno aspetta te (richiesta aperta): niente anello che gira. */
  waiting: boolean
  /** Passaggio attuale del turno in corso: lo strumento che sta girando. */
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

/** Richieste aperte (anche di più sessioni di turno): le sta in primo piano sopra il composer, non nella lista. */
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
    // Un turno senza turn-end è in corso solo se è l'ultimo (e ha ancora qualcosa di aperto).
    // Con la sessione ferma o in errore un turno senza turn-end è finito (riavvio dell'host, interruzione).
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
      // Passaggi: strumenti, richieste e, a turno concluso, i testi intermedi (la risposta finale sta fuori).
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
      // Il turno in corso resta aperto: testi dell'agente in chiaro, poi la riga del passaggio attuale.
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

/** Le parti della frase riassuntiva, in ordine di importanza. Il testo lo compone la UI (i18n). */
export function summaryParts(counts: TurnCounts, files: FileChange[]): SummaryPart[] {
  const parts: SummaryPart[] = []
  const edits = files.length > 0 ? files.length : counts.edits
  if (edits > 0) parts.push({ key: 'edits', n: edits })
  if (counts.commands > 0) parts.push({ key: 'commands', n: counts.commands })
  if (counts.reads > 0) parts.push({ key: 'reads', n: counts.reads })
  if (counts.searches > 0) parts.push({ key: 'searches', n: counts.searches })
  return parts
}
