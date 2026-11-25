// Project file list for @ mentions: loaded once per project and refreshed
// when the picker opens if it is older than 30 seconds. Lowercase paths and names are precomputed.
import { useSyncExternalStore } from 'react'
import { request } from '@/lib/host-client'

export interface FileEntry {
  path: string
  lower: string
  base: string
  baseLower: string
  /** Folder with trailing slash, empty for files in the root. */
  dir: string
  depth: number
}

export interface FileIndex {
  entries: FileEntry[] | null
  /** Files sorted by depth and path: used when there is no text after @ yet. */
  shallow: FileEntry[]
  loading: boolean
  error: string | null
  at: number
}

const STALE_MS = 30_000
export const MAX_RESULTS = 12
const EMPTY: FileIndex = { entries: null, shallow: [], loading: false, error: null, at: 0 }
const cache = new Map<string, FileIndex>()
const inflight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function toEntry(path: string): FileEntry {
  const slash = path.lastIndexOf('/')
  const base = slash >= 0 ? path.slice(slash + 1) : path
  let depth = 0
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47) depth++
  return { path, lower: path.toLowerCase(), base, baseLower: base.toLowerCase(), dir: slash >= 0 ? path.slice(0, slash + 1) : '', depth }
}

/** Index from any list of paths (⌘P on the session folder). */
export function indexFromPaths(paths: string[]): FileIndex {
  return { ...build(paths), loading: false, error: null, at: Date.now() }
}

function build(paths: string[]): Pick<FileIndex, 'entries' | 'shallow'> {
  const entries = paths.map(toEntry)
  const shallow = entries
    .slice()
    .sort((a, b) => a.depth - b.depth || (a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0))
    .slice(0, MAX_RESULTS)
  return { entries, shallow }
}

function update(projectId: string, patch: Partial<FileIndex>): void {
  cache.set(projectId, { ...(cache.get(projectId) ?? EMPTY), ...patch })
  for (const listener of listeners) listener()
}

/** Loads the list if missing or older than 30 s. In-flight requests are not duplicated. */
export function refreshProjectFiles(projectId: string): void {
  const current = cache.get(projectId)
  if (current?.entries && Date.now() - current.at < STALE_MS) return
  if (inflight.has(projectId)) return
  update(projectId, { loading: true, error: null })
  const job = request<string[]>({ type: 'project.files', projectId })
    .then((paths) => update(projectId, { ...build(paths), loading: false, error: null, at: Date.now() }))
    .catch((error: Error) => update(projectId, { loading: false, error: error.message }))
    .finally(() => inflight.delete(projectId))
  inflight.set(projectId, job)
}

/** Only for the preview without a host: sets a list that never expires. */
export function seedProjectFiles(projectId: string, paths: string[]): void {
  update(projectId, { ...build(paths), loading: false, error: null, at: Number.POSITIVE_INFINITY })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useProjectFiles(projectId: string | null): FileIndex {
  return useSyncExternalStore(subscribe, () => (projectId ? (cache.get(projectId) ?? EMPTY) : EMPTY))
}

const BOUNDARY = new Set(['/', '-', '_', '.', ' '])

/** Subsequence match with bonuses for consecutive letters and word starts. -1 if it doesn't match. */
function fuzzy(target: string, query: string): number {
  let score = 0
  let ti = 0
  let prev = -2
  for (let qi = 0; qi < query.length; qi++) {
    const code = query.charCodeAt(qi)
    while (ti < target.length && target.charCodeAt(ti) !== code) ti++
    if (ti >= target.length) return -1
    if (ti === prev + 1) score += 8
    if (ti === 0 || BOUNDARY.has(target[ti - 1])) score += 6
    score -= Math.min(ti - prev - 1, 6)
    prev = ti
    ti++
  }
  return Math.max(0, score + 200)
}

/** Tiers: file name first (exact, prefix, contains, scattered), then the path. */
function score(entry: FileEntry, query: string, pathQuery: boolean): number {
  if (!pathQuery) {
    const base = entry.baseLower
    if (base === query) return 9_000_000
    if (base.startsWith(query)) return 8_000_000 - base.length
    const inBase = base.indexOf(query)
    if (inBase >= 0) return 7_000_000 - inBase * 100 - base.length
    const inPath = entry.lower.indexOf(query)
    if (inPath >= 0) return 5_000_000 - entry.lower.length
    const fuzzyBase = fuzzy(base, query)
    if (fuzzyBase >= 0) return 4_000_000 + fuzzyBase * 100 - base.length
  } else {
    if (entry.lower === query) return 9_000_000
    if (entry.lower.endsWith(query)) return 7_500_000 - entry.lower.length
    const inPath = entry.lower.indexOf(query)
    if (inPath >= 0) return 6_000_000 - inPath * 10 - entry.lower.length
  }
  const fuzzyPath = fuzzy(entry.lower, query)
  if (fuzzyPath >= 0) return 1_000_000 + fuzzyPath * 100 - entry.lower.length
  return -1
}

export function rankFiles(index: FileIndex, rawQuery: string, limit = MAX_RESULTS): FileEntry[] {
  const entries = index.entries
  if (!entries) return []
  const query = rawQuery.replace(/^"/, '').toLowerCase()
  if (!query) return index.shallow.slice(0, limit)
  const pathQuery = query.includes('/')
  const hits: { entry: FileEntry; score: number }[] = []
  for (const entry of entries) {
    const s = score(entry, query, pathQuery)
    if (s >= 0) hits.push({ entry, score: s })
  }
  hits.sort((a, b) => b.score - a.score || a.entry.depth - b.entry.depth || (a.entry.lower < b.entry.lower ? -1 : 1))
  return hits.slice(0, limit).map((h) => h.entry)
}

export interface Mention {
  /** Index of the @. */
  start: number
  /** Text between the @ and the cursor. */
  query: string
}

const SPACE = /\s/

/** Mention in progress: an @ at the start or after a space, followed by text without spaces up to the cursor. */
export function findMention(text: string, caret: number): Mention | null {
  let i = caret - 1
  while (i >= 0 && !SPACE.test(text[i])) i--
  const start = i + 1
  if (start >= caret || text[start] !== '@') return null
  return { start, query: text.slice(start + 1, caret) }
}

/** Text to insert: paths with spaces go in quotes. */
export function mentionToken(path: string): string {
  return SPACE.test(path) ? `@"${path}"` : `@${path}`
}
