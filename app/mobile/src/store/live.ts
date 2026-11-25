// Sessions opened or written from this phone during this run: auto-start of the Live Activity applies to them.
// In memory and observable: the chat header button redraws when the session gets marked. Cleared on "Forget Mac".
import { create } from 'zustand'

interface LiveState {
  opened: Record<string, true>
  mark: (sessionId: string) => void
  clear: () => void
}

export const useLive = create<LiveState>((set, get) => ({
  opened: {},
  mark: (sessionId) => {
    if (get().opened[sessionId]) return
    set((s) => ({ opened: { ...s.opened, [sessionId]: true } }))
  },
  clear: () => set({ opened: {} })
}))
