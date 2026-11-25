// Suggerimenti del composer (LAD-92): "/" per i comandi della sessione, "@" per i file del progetto. Solo logica pura,
// provata con node --test. Le regole sono quelle del composer della finestra (file-index.ts: findMention / mentionToken).
import type { SlashCommand } from '../../../desktop/src/shared/protocol.ts'

export type TriggerKind = 'command' | 'file'
export interface Trigger {
  kind: TriggerKind
  /** Testo dopo il simbolo, fino al cursore. */
  query: string
  /** Posizione del simbolo e fine del pezzo (il cursore). */
  start: number
  end: number
}

const SPACE = /\s/

/**
 * Il pezzo di testo prima del cursore, senza spazi, che inizia con "@" (in qualunque punto) o con "/" (solo come primo carattere
 * del messaggio, a meno di spazi iniziali). `allow` spegne un tipo: la nuova sessione non ha ancora comandi.
 */
export function findTrigger(text: string, cursor: number, allow: { command: boolean; file: boolean } = { command: true, file: true }): Trigger | null {
  const end = Math.max(0, Math.min(cursor, text.length))
  let i = end - 1
  while (i >= 0 && !SPACE.test(text[i])) i--
  const start = i + 1
  if (start >= end) return null
  const mark = text[start]
  if (mark === '@' && allow.file) return { kind: 'file', query: text.slice(start + 1, end).replace(/^"/, ''), start, end }
  if (mark === '/' && allow.command && text.slice(0, start).trim() === '') return { kind: 'command', query: text.slice(start + 1, end), start, end }
  return null
}

/** Testo da inserire per un file: i percorsi con spazi vanno tra virgolette. */
export const fileToken = (path: string): string => (SPACE.test(path) ? `@"${path}"` : `@${path}`)
export const commandToken = (name: string): string => `/${name}`

/** Sostituisce il pezzo con il suggerimento e uno spazio (senza raddoppiarlo). Restituisce il testo nuovo e dove va il cursore. */
export function applySuggestion(text: string, trigger: Trigger, token: string): { text: string; cursor: number } {
  const after = text.slice(trigger.end)
  const spaced = after.startsWith(' ')
  const next = `${text.slice(0, trigger.start)}${token}${spaced ? '' : ' '}${after}`
  return { text: next, cursor: trigger.start + token.length + 1 }
}

const norm = (s: string): string => s.toLowerCase()

/** Comandi che corrispondono alla ricerca: prima nome uguale, poi che inizia, alias, nome che contiene, descrizione. Stesso rango: ordine alfabetico. */
export function filterCommands(commands: readonly SlashCommand[], query: string, limit = 40): SlashCommand[] {
  const q = norm(query.trim().replace(/^\//, ''))
  if (!q) return [...commands].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit)
  const scored: { c: SlashCommand; rank: number }[] = []
  for (const c of commands) {
    const name = norm(c.name)
    let rank = -1
    if (name === q) rank = 0
    else if (name.startsWith(q)) rank = 1
    else if (c.aliases?.some((a) => norm(a).startsWith(q))) rank = 2
    else if (name.includes(q)) rank = 3
    else if (norm(c.description).includes(q)) rank = 4
    if (rank >= 0) scored.push({ c, rank })
  }
  return scored.sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name)).slice(0, limit).map((s) => s.c)
}

/** Nome del file e cartella di un percorso, per mostrarli su due livelli. */
export function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) }
}

/**
 * Il testo è un comando della sessione ("/review qualcosa")? Restituisce nome e argomenti se il nome è nell'elenco dei comandi
 * (maiuscole comprese: i nomi sono esatti), altrimenti null e il testo va come messaggio normale.
 */
export function parseCommandInput(text: string, names: readonly string[]): { name: string; args: string } | null {
  const m = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!m || !names.includes(m[1])) return null
  return { name: m[1], args: (m[2] ?? '').trim() }
}
