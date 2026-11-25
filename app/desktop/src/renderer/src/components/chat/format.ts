// Short chat strings: durations, counts, paths.
import { localeTag, plural, t } from '@shared/i18n'
import type { TurnEndItem } from './turns'

/** 48 s · 2 min 41 s · 1 h 5 min */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return t('{s}s', { s: total })
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return m > 0 ? t('{h}h {m}m', { h, m }) : t('{h}h', { h })
  return s > 0 ? t('{m}m {s}s', { m, s }) : t('{m}m', { m })
}

/** Short duration for tool rows: 0.4 s · 12 s · 2 min */
export function formatShortDuration(ms: number): string {
  if (ms < 1000) {
    const s = (ms / 1000).toLocaleString(localeTag(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    return t('{s}s', { s })
  }
  if (ms < 60_000) return t('{s}s', { s: Math.round(ms / 1000) })
  return formatDuration(ms)
}

/** for 3 min · for 40 s · for 1 h */
export function formatSince(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return t('{n}s ago', { n: Math.max(1, s) })
  if (s < 3600) return t('{n}m ago', { n: Math.floor(s / 60) })
  return t('{n}h ago', { n: Math.floor(s / 3600) })
}

/** "Worked for 2 min 41 s · 6 commands · 3 files changed" */
export function turnSummary(end: TurnEndItem): string {
  const parts = [t('Worked for {duration}', { duration: formatDuration(end.durationMs) })]
  const { commands, edits, reads, searches } = end.counts
  if (commands > 0) parts.push(plural(commands, '{n} command', '{n} commands'))
  const changed = end.files.length > 0 ? end.files.length : edits
  if (changed > 0) parts.push(plural(changed, '{n} file changed', '{n} files changed'))
  if (commands === 0 && changed === 0) {
    if (reads > 0) parts.push(plural(reads, '{n} file read', '{n} files read'))
    if (searches > 0) parts.push(plural(searches, '{n} search', '{n} searches'))
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

// Common expressions that look like file names: `console.log`, `res.json`, `process.env`.
const NOT_FILE_STEMS = new Set(
  'console process window document res req response request module exports json math object array this self globalthis navigator location'.split(' ')
)

export interface FileRef {
  path: string
  line?: number
}

/**
 * Recognizes a file reference in inline code: it has a slash or a known extension,
 * with an optional line (`src/app.ts:42`, `http.ts:41:7`, `package.json`).
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
      // Without an extension we need at least two levels or a trailing slash: `feat/login` is a branch,
      // `/auth/refresh` a route, `src/features/payments/` a folder.
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

/** Relative links like `[app.ts](src/app.ts#L42)` that the agent uses to cite files. */
export function parseFileHref(href: string): FileRef | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) return null
  let value = href
  try {
    value = decodeURI(href)
  } catch {
    // Keep the original value if the encoding is invalid.
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
