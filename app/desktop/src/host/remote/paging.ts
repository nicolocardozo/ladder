// Paginazione della chat per il client remoto (LAD-49), separata da Host così si prova con un database vero.
import type { DatabaseSync } from 'node:sqlite'
import type { ChatItem, RemotePage } from '../../shared/protocol.ts'

export const PAGE_DEFAULT = 60
export const PAGE_MAX = 200

/**
 * Una pagina dalla fine all'indietro. `before`: seq esclusivo. Con la sessione in memoria (`live`, ha anche gli item non ancora
 * salvati) si taglia da lì; altrimenti si legge dal database solo la pagina, mai tutta la chat.
 */
export function pageItems(db: Pick<DatabaseSync, 'prepare'>, live: Map<string, ChatItem> | undefined, sessionId: string, before?: number, limit?: number): RemotePage {
  const size = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit as number), 1), PAGE_MAX) : PAGE_DEFAULT
  const upTo = before !== undefined && Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER
  let older: ChatItem[]
  if (live) {
    // La mappa è quasi sempre già in ordine di seq (gli item nuovi si aggiungono in fondo): si ordina solo se non lo è.
    const all = [...live.values()]
    for (let i = 1; i < all.length; i++) {
      if (all[i - 1].seq > all[i].seq) {
        all.sort((a, b) => a.seq - b.seq)
        break
      }
    }
    // Ricerca binaria del primo item con seq >= upTo: la pagina sta subito prima.
    let lo = 0
    let hi = all.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (all[mid].seq < upTo) lo = mid + 1
      else hi = mid
    }
    older = all.slice(Math.max(0, lo - (size + 1)), lo).reverse()
  } else {
    const rows = db.prepare('select json from items where session_id = ? and seq < ? order by seq desc limit ?').all(sessionId, upTo, size + 1) as { json: string }[]
    older = rows.map((r) => JSON.parse(r.json) as ChatItem)
  }
  // size + 1 righe lette: la in più dice solo se c'è altro più indietro.
  return { sessionId, items: older.slice(0, size).reverse(), hasMore: older.length > size }
}
