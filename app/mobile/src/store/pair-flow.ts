// Stato in memoria dell'abbinamento in corso (QR → conferma → password → nome del dispositivo). LAD-51 lo riempirà dal
// codice QR vero e verificherà la password; per ora il formato del codice è provvisorio (vedi lib/pairing-url).
import { create } from 'zustand'

export interface PairDraft {
  macKey: string
  wsUrl: string
  macName: string
  password: string
  device: string
}

export const usePairFlow = create<{ draft: PairDraft; set: (patch: Partial<PairDraft>) => void; reset: () => void }>((set) => ({
  draft: { macKey: '', wsUrl: '', macName: '', password: '', device: '' },
  set: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
  reset: () => set({ draft: { macKey: '', wsUrl: '', macName: '', password: '', device: '' } })
}))
