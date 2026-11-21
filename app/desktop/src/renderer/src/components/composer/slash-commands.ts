// Comandi / del composer: quelli dell'agente (dall'host) più i tre di Ladder, che gestisce la UI.
import { t } from '@shared/i18n'
import type { SlashCommand } from '@shared/protocol'

export type CommandSource = SlashCommand['source'] | 'ladder'

/** Comandi che Ladder risolve da sé: aprono i selettori o cambiano sessione, non vanno all'agente. */
export type LadderCommandName = 'model' | 'effort' | 'new'

export interface CommandEntry {
  name: string
  description: string
  hint: string | null
  source: CommandSource
  aliases?: string[]
}

// Testi in inglese: si mostrano con commandDescription(), che ha le chiavi t() letterali.
const LADDER_COMMANDS: (CommandEntry & { name: LadderCommandName })[] = [
  { name: 'model', description: 'Choose the model, or set it with /model <name>', hint: '<model>', source: 'ladder' },
  { name: 'effort', description: 'Choose the effort, or set it with /effort <level>', hint: '<level>', source: 'ladder' },
  { name: 'new', description: 'Start a new session in this project', hint: null, source: 'ladder' }
]

/** Descrizione da mostrare: quelle di Ladder passano dal catalogo, quelle dell'agente arrivano già nella sua lingua. */
export function commandDescription(entry: CommandEntry): string {
  if (entry.source !== 'ladder') return entry.description
  switch (entry.name) {
    case 'model':
      return t('Choose the model, or set it with /model <name>')
    case 'effort':
      return t('Choose the effort, or set it with /effort <level>')
    case 'new':
      return t('Start a new session in this project')
    default:
      return entry.description
  }
}

export const isLadderCommand = (entry: Pick<CommandEntry, 'source'>) => entry.source === 'ladder'

/** Elenco completo: prima Ladder, poi l'agente. Un comando dell'agente con lo stesso nome di uno di Ladder è nascosto. */
export function mergeCommands(agent: SlashCommand[] | undefined, available: Record<LadderCommandName, boolean>): CommandEntry[] {
  const own = LADDER_COMMANDS.filter((c) => available[c.name])
  const taken = new Set(LADDER_COMMANDS.map((c) => c.name.toLowerCase()))
  const rest = (agent ?? [])
    .filter((c) => !taken.has(c.name.toLowerCase()))
    .map<CommandEntry>((c) => ({ name: c.name, description: c.description, hint: c.hint, source: c.source, aliases: c.aliases }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...own, ...rest]
}

/** Filtro per prefisso su nome e alias: prima chi inizia col nome, poi chi corrisponde per alias. */
export function rankCommands(list: CommandEntry[], query: string): CommandEntry[] {
  const q = query.toLowerCase()
  if (!q) return list
  const byName: CommandEntry[] = []
  const byAlias: CommandEntry[] = []
  for (const entry of list) {
    if (entry.name.toLowerCase().startsWith(q)) byName.push(entry)
    else if (entry.aliases?.some((alias) => alias.toLowerCase().startsWith(q))) byAlias.push(entry)
  }
  return [...byName, ...byAlias]
}

export interface SlashTrigger {
  /** Sempre 0: il comando sta all'inizio del messaggio. */
  start: 0
  /** Testo tra la / e il cursore. */
  query: string
  /** Fine del primo token (prima dello spazio o in fondo al testo). */
  end: number
}

const SPACE = /\s/

/** Comando in corso: la / è il primo carattere e il cursore è ancora dentro il primo token. */
export function findSlash(text: string, caret: number): SlashTrigger | null {
  if (text[0] !== '/' || caret < 1) return null
  let end = 1
  while (end < text.length && !SPACE.test(text[end])) end++
  if (caret > end) return null
  return { start: 0, query: text.slice(1, caret), end }
}

/** Testo che inizia con "/nome" noto (nome o alias, senza distinguere le maiuscole): comando e argomenti. */
export function parseSlash(text: string, list: CommandEntry[]): { entry: CommandEntry; args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const name = match[1].toLowerCase()
  const entry = list.find((c) => c.name.toLowerCase() === name) ?? list.find((c) => c.aliases?.some((alias) => alias.toLowerCase() === name))
  return entry ? { entry, args: (match[2] ?? '').trim() } : null
}

/** Argomenti già scritti dopo il primo token, per eseguire il comando evidenziato con Invio. */
export function argsAfterToken(text: string, trigger: SlashTrigger): string {
  return text.slice(trigger.end).trim()
}
