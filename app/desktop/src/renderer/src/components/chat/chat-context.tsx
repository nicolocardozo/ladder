// Stable chat context: callbacks and open/closed state of the sections.
// The state lives outside the rows because virtualization unmounts and remounts them as you scroll.
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { RequestResponse } from '@shared/protocol'

export interface ToggleStore {
  has: (key: string) => boolean
  set: (key: string, open: boolean) => void
  /** Closes all sections whose keys start with one of the prefixes. */
  closeAll: (prefixes: string[]) => void
  subscribe: (key: string, listener: () => void) => () => void
}

export function createToggleStore(): ToggleStore {
  const open = new Set<string>()
  const listeners = new Map<string, Set<() => void>>()
  return {
    has: (key) => open.has(key),
    set: (key, value) => {
      if (value === open.has(key)) return
      if (value) open.add(key)
      else open.delete(key)
      listeners.get(key)?.forEach((l) => l())
    },
    closeAll: (prefixes) => {
      for (const key of [...open]) if (prefixes.some((p) => key.startsWith(p))) {
        open.delete(key)
        listeners.get(key)?.forEach((l) => l())
      }
    },
    subscribe: (key, listener) => {
      let set = listeners.get(key)
      if (!set) {
        set = new Set()
        listeners.set(key, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(key)
      }
    }
  }
}

export interface ChatActions {
  /** Click: viewer in the inspector at the line. ⌥click (`external`): external editor. */
  openFile: (path: string, line?: number, external?: boolean) => void
  /** Changes panel on the diff of a turn, optionally on a file. */
  openDiff: (turnId: string, path?: string) => void
  respond: (requestId: string, response: RequestResponse) => void
  /** True when focus is in the chat or nowhere: cards may take it. */
  canTakeFocus: () => boolean
  toggles: ToggleStore
  /** "Pending" shows the cards outside the chat: long changes only have "Open". */
  surface?: 'chat' | 'inbox'
  /** Narrow column (below about 420 px): reduced margins and tool cards closed. */
  compact?: boolean
  openSession?: () => void
  /** "Continue" on the row of finished subagents: sends session.continue. Rejects with the host's message. */
  continueSession?: (itemId: string) => Promise<unknown>
  /** Puts the text in the composer without sending it. */
  prefill?: (text: string) => void
  /** Chat session: the subagent rows need it to find their data and open the detail. */
  sessionId?: string
}

const noop = () => {}

export const ChatContext = createContext<ChatActions>({
  openFile: noop,
  openDiff: noop,
  respond: noop,
  canTakeFocus: () => false,
  toggles: createToggleStore()
})

export function useChatActions() {
  return useContext(ChatContext)
}

/** Collapsible section whose state survives the row being unmounted. */
export function useToggle(key: string) {
  const { toggles } = useContext(ChatContext)
  const subscribe = useCallback((listener: () => void) => toggles.subscribe(key, listener), [toggles, key])
  const open = useSyncExternalStore(subscribe, () => toggles.has(key))
  const toggle = useCallback(() => toggles.set(key, !toggles.has(key)), [toggles, key])
  return [open, toggle] as const
}

/** Current time updated at intervals: for durations and "for 3 min". */
export function useNow(intervalMs: number, enabled = true) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, enabled])
  return now
}

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
