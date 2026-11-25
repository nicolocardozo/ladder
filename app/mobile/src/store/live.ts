// Sessioni aperte o scritte da questo telefono in questa esecuzione (LAD-93): per loro l'avvio automatico della Live Activity vale.
// In memoria e osservabile: il pulsante dell'header della chat si ridisegna quando la sessione viene segnata. Si svuota a "Forget Mac".
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
