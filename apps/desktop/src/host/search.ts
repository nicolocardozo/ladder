// Ricerca di ⌘K nelle conversazioni di tutti i progetti: messaggi, risposte, comandi e file toccati.
// LIKE di SQLite restringe le righe, poi il filtro vero (senza accenti e maiuscole) lavora sul testo leggibile.
import type { ChatItem, SearchHit } from '@shared/protocol'
import type { Db, SessionRow } from './db'

const MAX_SESSIONS = 20
const MAX_ROWS = 600

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

/** Testo cercabile di un elemento e tipo di corrispondenza. */
function searchable(item: ChatItem): { text: string; kind: SearchHit['kind'] }[] {
  switch (item.kind) {
    case 'user':
      return [{ text: item.text, kind: 'message' }]
    case 'assistant':
      return [{ text: item.text, kind: 'reply' }]
    case 'tool':
      return [{ text: [item.title, item.detail].filter(Boolean).join(' · '), kind: item.tool === 'command' ? 'command' : item.tool === 'edit' || item.tool === 'read' ? 'file' : 'reply' }]
    case 'request':
      return [{ text: [item.title, item.command, item.path].filter(Boolean).join(' · '), kind: item.command ? 'command' : 'file' }]
    case 'turn-end':
      return item.files.map((f) => ({ text: f.path, kind: 'file' as const }))
    default:
      return []
  }
}

function snippet(text: string, token: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = normalize(flat).indexOf(token)
  if (at < 0 || flat.length <= 120) return flat.slice(0, 120)
  const start = Math.max(0, at - 40)
  const end = Math.min(flat.length, at + token.length + 70)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

export function searchItems(db: Db, rows: Map<string, SessionRow>, query: string): SearchHit[] {
  const tokens = normalize(query).split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0 || tokens.every((t) => t.length < 2)) return []
  const live = new Set([...rows.values()].filter((r) => !r.archived).map((r) => r.id))
  // Il JSON contiene il testo così com'è (UTF-8) e LIKE ignora le maiuscole solo per l'ASCII.
  // Le vocali diventano "_" (un carattere qualunque): "perche" trova anche "perché". Il filtro dopo è quello esatto.
  const likes = tokens.map((t) => `%${t.replace(/[%_\\]/g, (c) => `\\${c}`).replace(/[aeiou]/g, '_')}%`)
  const where = likes.map(() => `json like ? escape '\\'`).join(' and ')
  const candidates = db
    .prepare(`select session_id, json from items where ${where} order by rowid desc limit ${MAX_ROWS}`)
    .all(...likes) as { session_id: string; json: string }[]

  const best = new Map<string, SearchHit>()
  for (const { session_id, json } of candidates) {
    if (!live.has(session_id) || best.has(session_id)) continue
    const item = JSON.parse(json) as ChatItem
    for (const part of searchable(item)) {
      const haystack = normalize(part.text)
      if (!tokens.every((t) => haystack.includes(t))) continue
      best.set(session_id, { sessionId: session_id, itemId: item.id, snippet: snippet(part.text, tokens[0]), kind: part.kind, at: item.at })
      break
    }
    if (best.size >= MAX_SESSIONS) break
  }
  return [...best.values()].sort((a, b) => b.at - a.at)
}
