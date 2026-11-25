// Solo sviluppo: pilota le schermate per gli screenshot e le prove (deep link ladder://dev?...), senza toccare lo schermo.
import { create } from 'zustand'

export type DevSheet = 'request' | 'permission' | 'turn' | 'switch' | 'full' | null

interface DevState {
  sheet: DevSheet
  /** Solo sviluppo: il campo del messaggio di "Nuova sessione" prende il focus (tastiera su) senza un tocco. */
  focusNewSession: boolean
  /** Solo sviluppo: stato iniziale del modulo "Nuova sessione" (opzioni aperte, scelta aperta, invio subito). */
  newSession: { expand?: boolean; step?: string; send?: boolean; project?: string; agent?: string } | null
  setSheet: (s: DevSheet) => void
  /** La chat aperta si registra qui per lasciarsi scorrere dal driver (solo sviluppo). */
  scrollChat: ((offset: number) => void) | null
  setScrollChat: (fn: ((offset: number) => void) | null) => void
}

export const useDev = create<DevState>((set) => ({ focusNewSession: false, newSession: null, sheet: null, setSheet: (sheet) => set({ sheet }), scrollChat: null, setScrollChat: (scrollChat) => set({ scrollChat }) }))
