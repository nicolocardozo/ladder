// Composer suggestions: "/" for session commands, "@" for project files. Pure logic only,
// tested with node --test. The rules are those of the window composer (file-index.ts: findMention / mentionToken).
import type { SlashCommand } from '../../../desktop/src/shared/protocol.ts'

export type TriggerKind = 'command' | 'file'
export interface Trigger {
  kind: TriggerKind
  /** Text after the symbol, up to the cursor. */
  query: string
  /** Position of the symbol and end of the piece (the cursor). */
  start: number
  end: number
}

const SPACE = /\s/

/**
 * The piece of text before the cursor, without spaces, that starts with "@" (anywhere) or "/" (only as the first character
 * of the message, ignoring leading spaces). `allow` turns off a kind: a new session has no commands yet.
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

/** Text to insert for a file: paths with spaces go in quotes. */
export const fileToken = (path: string): string => (SPACE.test(path) ? `@"${path}"` : `@${path}`)
export const commandToken = (name: string): string => `/${name}`

/** Replaces the piece with the suggestion and a space (without doubling it). Returns the new text and where the cursor goes. */
export function applySuggestion(text: string, trigger: Trigger, token: string): { text: string; cursor: number } {
  const after = text.slice(trigger.end)
  const spaced = after.startsWith(' ')
  const next = `${text.slice(0, trigger.start)}${token}${spaced ? '' : ' '}${after}`
  return { text: next, cursor: trigger.start + token.length + 1 }
}

const norm = (s: string): string => s.toLowerCase()

/** Commands matching the search: exact name first, then starts with, alias, name contains, description. Same rank: alphabetical order. */
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

/** File name and folder of a path, to show them on two levels. */
export function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) }
}

/**
 * Is the text a session command ("/review something")? Returns name and arguments if the name is in the command list
 * (case-sensitive: names are exact), otherwise null and the text goes as a normal message.
 */
export function parseCommandInput(text: string, names: readonly string[]): { name: string; args: string } | null {
  const m = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!m || !names.includes(m[1])) return null
  return { name: m[1], args: (m[2] ?? '').trim() }
}
