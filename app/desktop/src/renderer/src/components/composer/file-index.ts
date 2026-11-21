// Elenco dei file del progetto per le citazioni con @: si carica una volta per progetto e si aggiorna
// all'apertura del selettore se ha più di 30 secondi. Percorsi e nomi in minuscolo sono precalcolati.
import { useSyncExternalStore } from 'react'
import { request } from '@/lib/host-client'

export interface FileEntry {
  path: string
  lower: string
  base: string
  baseLower: string
  /** Cartella con la barra finale, vuota per i file nella radice. */
  dir: string
  depth: number
}

export interface FileIndex {
  entries: FileEntry[] | null
  /** File ordinati per profondità e percorso: servono quando dopo @ non c'è ancora testo. */
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

/** Indice da un elenco qualunque di percorsi (⌘P sulla cartella della sessione). */
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

/** Carica l'elenco se manca o se è più vecchio di 30 s. Le richieste in corso non si duplicano. */
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

/** Solo per l'anteprima senza host: imposta un elenco che non scade. */
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

/** Sottosequenza con premi per lettere consecutive e inizi di parola. -1 se non corrisponde. */
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

/** Fasce: prima il nome del file (esatto, inizio, contenuto, sparso), poi il percorso. */
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
  /** Indice della @. */
  start: number
  /** Testo tra la @ e il cursore. */
  query: string
}

const SPACE = /\s/

/** Citazione in corso: una @ all'inizio o dopo uno spazio, seguita da testo senza spazi fino al cursore. */
export function findMention(text: string, caret: number): Mention | null {
  let i = caret - 1
  while (i >= 0 && !SPACE.test(text[i])) i--
  const start = i + 1
  if (start >= caret || text[start] !== '@') return null
  return { start, query: text.slice(start + 1, caret) }
}

/** Testo da inserire: i percorsi con spazi vanno tra virgolette. */
export function mentionToken(path: string): string {
  return SPACE.test(path) ? `@"${path}"` : `@${path}`
}
