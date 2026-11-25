// Solo sviluppo: pilota le schermate per gli screenshot e le prove (deep link ladder://dev?...), senza toccare lo schermo.
import { create } from 'zustand'

/** Solo sviluppo: comandi del driver per il composer (testo, immagini da file, cursore). */
export interface DevComposerCmd {
  text?: string
  /** File immagine locali da allegare come se fossero scelti dalla libreria. */
  images?: string[]
  /** Invia il messaggio come con il tasto Invia. */
  send?: boolean
  /** Porta il focus nel campo (tastiera su). */
  focus?: boolean
  /** Avvia la dettatura come il tocco sul microfono. */
  dictate?: boolean
}

/** Solo sviluppo: stato forzato della dettatura, per vederne l'interfaccia dove il microfono non c'è (simulatore). */
export type DevDictation = 'listening' | 'downloading' | 'denied' | 'not-installed' | 'unsupported' | null

export type DevSheet = 'request' | 'permission' | 'turn' | 'switch' | 'full' | null

interface DevState {
  sheet: DevSheet
  /** Solo sviluppo: lo sheet della richiesta si apre con il campo di testo aperto (motivo del rifiuto o "Altro…"). */
  reasonField: boolean
  /** Solo sviluppo: il campo di ricerca della Home prende il focus. */
  focusSearch: boolean
  /** Solo sviluppo: lo sheet nativo aperto si registra qui per lasciarsi scorrere dal driver. */
  scrollSheet: ((y: number) => void) | null
  /** Solo sviluppo: il campo del messaggio di "Nuova sessione" prende il focus (tastiera su) senza un tocco. */
  focusNewSession: boolean
  /** Solo sviluppo: stato iniziale del modulo "Nuova sessione" (opzioni aperte, scelta aperta, invio subito). */
  newSession: { expand?: boolean; step?: string; send?: boolean; project?: string; agent?: string } | null
  setSheet: (s: DevSheet) => void
  /** Il composer aperto (chat o nuova sessione) si registra qui per i comandi del driver (solo sviluppo). */
  composer: ((cmd: DevComposerCmd) => void) | null
  setComposer: (fn: ((cmd: DevComposerCmd) => void) | null) => void
  dictation: DevDictation
  /** Solo sviluppo: variante della schermata Welcome (capsule o riga sola). */
  welcome: 'chips' | 'caption'
  /** La chat aperta si registra qui per lasciarsi scorrere dal driver (solo sviluppo). */
  scrollChat: ((offset: number) => void) | null
  setScrollChat: (fn: ((offset: number) => void) | null) => void
}

export const useDev = create<DevState>((set) => ({ composer: null, setComposer: (composer) => set({ composer }), dictation: null, welcome: 'chips', focusNewSession: false, reasonField: false, focusSearch: false, scrollSheet: null, newSession: null, sheet: null, setSheet: (sheet) => set({ sheet }), scrollChat: null, setScrollChat: (scrollChat) => set({ scrollChat }) }))
