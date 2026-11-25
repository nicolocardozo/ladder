// "/" and "@" in the composer: which suggestion is open, where to search and what happens on tap.
// Commands: `session.commands` (one read per session, cached); files: `project.files.search` with a short debounce on every key.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SlashCommand } from '@shared/protocol'
import { request } from '@/host/controller'
import { applySuggestion, commandToken, fileToken, filterCommands, findTrigger, type Trigger } from '@/lib/composer-suggest'

const DEBOUNCE_MS = 150
const COMMANDS_TTL_MS = 60_000
const FILE_LIMIT = 20

const commandCache = new Map<string, { at: number; list: SlashCommand[] }>()

/** Names of the commands already read for the session (empty if not yet known). */
export const cachedCommandNames = (sessionId: string): string[] => commandCache.get(sessionId)?.list.map((c) => c.name) ?? []

/** Forgets the cached commands (change of Mac or of world). */
export const clearSuggestCache = (): void => commandCache.clear()

export interface Selection {
  start: number
  end: number
}

interface Options {
  /** Session (for commands). Without it, commands are off (new session: it doesn't exist yet). */
  sessionId?: string | null
  /** Project (for files). Without it, files are off. */
  projectId?: string | null
  text: string
  selection: Selection
  setText: (text: string) => void
  /** Off (offline, session working with an open request…): no suggestions. */
  enabled?: boolean
}

export function useSuggest({ sessionId, projectId, text, selection, setText, enabled = true }: Options) {
  const trigger = useMemo<Trigger | null>(() => {
    if (!enabled || selection.start !== selection.end) return null
    return findTrigger(text, selection.start, { command: !!sessionId, file: !!projectId })
  }, [enabled, text, selection.start, selection.end, sessionId, projectId])
  // Closed by hand: stays closed until the token changes.
  const [dismissed, setDismissed] = useState<string | null>(null)
  const key = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : null
  const active = trigger && key !== dismissed ? trigger : null

  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const seq = useRef(0)

  // Commands: from cache right away, and re-read if stale.
  const kind = active?.kind ?? null
  useEffect(() => {
    if (kind !== 'command' || !sessionId) return
    const hit = commandCache.get(sessionId)
    if (hit) setCommands(hit.list)
    if (hit && Date.now() - hit.at < COMMANDS_TTL_MS) return
    let live = true
    setLoading(!hit)
    request<SlashCommand[]>({ type: 'session.commands', sessionId })
      .then((list) => {
        commandCache.set(sessionId, { at: Date.now(), list })
        if (live) {
          setCommands(list)
          setFailed(false)
        }
      })
      .catch(() => live && setFailed(true))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [kind, sessionId])

  // Files: one search every 150 ms of quiet; an old response doesn't win over a new one.
  const query = active?.kind === 'file' ? active.query : null
  useEffect(() => {
    if (query === null || !projectId) {
      setFiles([])
      return
    }
    const mine = ++seq.current
    setLoading(true)
    const timer = setTimeout(() => {
      request<string[]>({ type: 'project.files.search', projectId, query, limit: FILE_LIMIT })
        .then((list) => {
          if (mine !== seq.current) return
          setFiles(list)
          setFailed(false)
        })
        .catch(() => mine === seq.current && setFailed(true))
        .finally(() => mine === seq.current && setLoading(false))
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, projectId])

  const shownCommands = useMemo(() => (active?.kind === 'command' ? filterCommands(commands, active.query) : []), [active, commands])

  /** Inserts the suggestion; returns where the cursor goes. */
  const choose = useCallback(
    (value: string, as: 'command' | 'file'): number | null => {
      if (!active) return null
      const out = applySuggestion(text, active, as === 'command' ? commandToken(value) : fileToken(value))
      setText(out.text)
      return out.cursor
    },
    [active, text, setText]
  )

  return { trigger: active, commands: shownCommands, files: active?.kind === 'file' ? files : [], loading, failed, choose, close: () => key && setDismissed(key) }
}
