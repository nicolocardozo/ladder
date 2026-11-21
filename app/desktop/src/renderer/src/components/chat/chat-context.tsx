// Contesto stabile della chat: callback e stato aperto/chiuso delle sezioni.
// Lo stato vive fuori dalle righe perché la virtualizzazione le smonta e rimonta mentre scorri.
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { RequestResponse } from '@shared/protocol'

export interface ToggleStore {
  has: (key: string) => boolean
  set: (key: string, open: boolean) => void
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
  /** Clic: viewer nell'ispettore alla riga. ⌥clic (`external`): editor esterno. */
  openFile: (path: string, line?: number, external?: boolean) => void
  /** Pannello Modifiche sul diff di un turno, eventualmente su un file. */
  openDiff: (turnId: string, path?: string) => void
  respond: (requestId: string, response: RequestResponse) => void
  /** Vero quando il focus è nella chat o da nessuna parte: le card possono prenderlo. */
  canTakeFocus: () => boolean
  toggles: ToggleStore
  /** "In attesa" mostra le card fuori dalla chat: le modifiche lunghe hanno solo "Apri". */
  surface?: 'chat' | 'inbox'
  openSession?: () => void
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

/** Sezione apribile il cui stato sopravvive allo smontaggio della riga. */
export function useToggle(key: string) {
  const { toggles } = useContext(ChatContext)
  const subscribe = useCallback((listener: () => void) => toggles.subscribe(key, listener), [toggles, key])
  const open = useSyncExternalStore(subscribe, () => toggles.has(key))
  const toggle = useCallback(() => toggles.set(key, !toggles.has(key)), [toggles, key])
  return [open, toggle] as const
}

/** Ora corrente aggiornata a intervalli: per durate e "da 3 min". */
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
