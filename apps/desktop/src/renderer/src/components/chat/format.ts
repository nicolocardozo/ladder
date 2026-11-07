// Testi brevi della chat: durate, conteggi, percorsi.
import type { TurnEndItem } from './turns'

/** 48 s · 2 min 41 s · 1 h 5 min */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} s`
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`
  return s > 0 ? `${m} min ${s} s` : `${m} min`
}

/** Durata breve per le righe degli strumenti: 0,4 s · 12 s · 2 min */
export function formatShortDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  return formatDuration(ms)
}

/** da 3 min · da 40 s · da 1 h */
export function formatSince(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `da ${Math.max(1, s)} s`
  if (s < 3600) return `da ${Math.floor(s / 60)} min`
  return `da ${Math.floor(s / 3600)} h`
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

/** "Ha lavorato per 2 min 41 s · 6 comandi · 3 file modificati" */
export function turnSummary(end: TurnEndItem): string {
  const parts = [`Ha lavorato per ${formatDuration(end.durationMs)}`]
  const { commands, edits, reads, searches } = end.counts
  if (commands > 0) parts.push(plural(commands, 'comando', 'comandi'))
  const changed = end.files.length > 0 ? end.files.length : edits
  if (changed > 0) parts.push(plural(changed, 'file modificato', 'file modificati'))
  if (commands === 0 && changed === 0) {
    if (reads > 0) parts.push(plural(reads, 'file letto', 'file letti'))
    if (searches > 0) parts.push(plural(searches, 'ricerca', 'ricerche'))
  }
  return parts.join(' · ')
}

export function basename(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const i = clean.lastIndexOf('/')
  return i >= 0 ? clean.slice(i + 1) : clean
}

const KNOWN_EXT = new Set(
  (
    'ts tsx mts cts js jsx mjs cjs json jsonc md mdx css scss sass less html htm vue svelte astro ' +
    'yml yaml toml ini lock txt csv xml svg png jpg jpeg gif webp ico py rb rs go java kt swift ' +
    'c h cc cpp hpp cs php sh bash zsh fish sql graphql gql prisma proto patch diff'
  ).split(' ')
)

// Espressioni comuni che sembrano nomi di file: `console.log`, `res.json`, `process.env`.
const NOT_FILE_STEMS = new Set(
  'console process window document res req response request module exports json math object array this self globalthis navigator location'.split(' ')
)

export interface FileRef {
  path: string
  line?: number
}

/**
 * Riconosce un riferimento a file nel codice inline: ha una barra o un'estensione nota,
 * con riga facoltativa (`src/app.ts:42`, `http.ts:41:7`, `package.json`).
 */
export function parseFileRef(text: string): FileRef | null {
  const value = text.trim()
  if (value.length < 3 || value.length > 240) return null
  if (/\s/.test(value) || value.includes('://') || value.startsWith('@')) return null
  const match = /^([\w.\-~/+[\]]+?)(?::(\d+)(?::\d+)?(?:-\d+)?)?$/.exec(value)
  if (!match) return null
  const path = match[1]
  if (!/[\w]/.test(path) || /^\.+$/.test(path) || path.includes('//')) return null
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const hasKnownExt = KNOWN_EXT.has(ext)
  const isDotfile = name.startsWith('.') && /\w/.test(name)
  if (path.includes('/')) {
    if (ext && !/^[a-z][a-z0-9]{0,9}$/i.test(ext)) return null
    if (!ext && !isDotfile) {
      // Senza estensione servono almeno due livelli o la barra finale: `feat/login` è un branch,
      // `/auth/refresh` una rotta, `src/features/payments/` una cartella.
      const slashes = path.split('/').length - 1
      if (path.startsWith('/') || (slashes < 2 && !path.endsWith('/'))) return null
    }
  } else if (isDotfile) {
    // .env, .gitignore, .env.local
  } else if (!hasKnownExt || NOT_FILE_STEMS.has(name.slice(0, dot).toLowerCase())) {
    return null
  }
  const line = match[2] ? Number(match[2]) : undefined
  return { path, line }
}

/** Link relativi del tipo `[app.ts](src/app.ts#L42)` che l'agente usa per citare i file. */
export function parseFileHref(href: string): FileRef | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) return null
  let value = href
  try {
    value = decodeURI(href)
  } catch {
    // Lasciamo il valore originale se la codifica non è valida.
  }
  const hash = /#L(\d+)(?:-L?\d+)?$/.exec(value)
  if (hash) {
    const path = value.slice(0, hash.index)
    return path ? { path, line: Number(hash[1]) } : null
  }
  const ref = parseFileRef(value)
  if (ref) return ref
  return value.includes('/') && !value.includes('?') ? { path: value } : null
}
