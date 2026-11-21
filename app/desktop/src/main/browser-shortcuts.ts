// Quali tasti premuti nella pagina nativa del browser (LAD-57) vanno inoltrati al renderer.
// Le scorciatoie dell'app vengono dal registro centrale (shared/shortcuts.ts): seguono preset e personalizzazioni.
import { findBinding } from '../shared/shortcuts'

/** Il minimo di Electron.Input che serve qui: così la funzione si prova senza Electron. */
export interface ShortcutInput {
  type: string
  key: string
  code: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

/**
 * ⌘+tasto (senza altri modificatori) che resta sempre alla pagina, anche se un comando dell'app ci è legato:
 * grassetto e salva (⌘B, ⌘S), copia/incolla/taglia/seleziona tutto/annulla (⌘C ⌘V ⌘X ⌘A ⌘Z), cerca e ricarica (⌘F, ⌘R).
 * Se l'utente rimappa un comando su uno di questi, vince la pagina; le varianti con ⇧, ⌥ o ⌃ restano all'app.
 */
const PAGE_KEYS = new Set(['b', 's', 'c', 'v', 'x', 'a', 'z', 'f', 'r'])

/** ⌘L porta il cursore nell'indirizzo: lo gestisce la vista del browser, non è un comando del registro. */
const ADDRESS_KEY = 'l'

export function isAppShortcut(input: ShortcutInput): boolean {
  if (input.type !== 'keyDown') return false
  const key = input.key.toLowerCase()
  if (input.meta && !input.control && !input.alt && !input.shift) {
    if (PAGE_KEYS.has(key)) return false
    if (key === ADDRESS_KEY) return true
  }
  return findBinding({ key: input.key, code: input.code, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, metaKey: input.meta }, 'global') !== null
}

/**
 * ⌘R (senza altri modificatori) sulla pagina nativa: la pagina lo vede, ma il menu dell'app non deve eseguirlo. Senza questo
 * il ruolo `reload` del menu View (⌘R) ricaricherebbe la finestra dell'app, non la pagina. Vale per keyDown e keyUp.
 */
export function pageKeepsReload(input: ShortcutInput): boolean {
  return input.meta && !input.control && !input.alt && !input.shift && input.key.toLowerCase() === 'r'
}
