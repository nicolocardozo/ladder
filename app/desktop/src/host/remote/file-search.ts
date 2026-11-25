// Ricerca di file per le menzioni `@` del telefono (LAD-92): pura, gira sul Mac sull'elenco di `project.files`.
import { REMOTE_FILE_SEARCH_MAX } from '../../shared/protocol.ts'

export const FILE_SEARCH_DEFAULT = 20
export const FILE_SEARCH_MAX_QUERY = 200

/** Solo percorsi relativi alla radice, senza `..`, caratteri di controllo o separatori di Windows. */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false
  return !path.split('/').some((part) => part === '..' || part === '' )
}

const isSubsequence = (needle: string, haystack: string): boolean => {
  let i = 0
  for (let j = 0; j < haystack.length && i < needle.length; j++) if (haystack[j] === needle[i]) i++
  return i === needle.length
}

/** Punteggio (più basso = meglio) o null se non corrisponde: prefisso del nome < nome contiene < percorso contiene < sottosequenza. */
function rank(path: string, query: string): number | null {
  const lower = path.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  if (base.startsWith(query)) return 0
  if (base.includes(query)) return 1
  if (lower.includes(query)) return 2
  if (isSubsequence(query, lower)) return 3
  return null
}

const depth = (path: string): number => path.split('/').length

/** I migliori `limit` percorsi (al massimo REMOTE_FILE_SEARCH_MAX) per `query`; a parità conta la profondità, poi l'ordine alfabetico. */
export function searchFiles(files: readonly string[], query: string, limit?: number): string[] {
  const max = Math.max(1, Math.min(Math.floor(limit ?? FILE_SEARCH_DEFAULT) || FILE_SEARCH_DEFAULT, REMOTE_FILE_SEARCH_MAX))
  const q = query.trim().toLowerCase()
  const scored: { path: string; rank: number; depth: number }[] = []
  for (const path of files) {
    if (typeof path !== 'string' || !isSafeRelativePath(path)) continue
    const r = q ? rank(path, q) : 0
    if (r !== null) scored.push({ path, rank: r, depth: depth(path) })
  }
  scored.sort((a, b) => a.rank - b.rank || a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return scored.slice(0, max).map((s) => s.path)
}
