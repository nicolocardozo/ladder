// Tasto che invia nei composer (AppPrefs.sendKey): un solo punto, così vale ovunque si scriva un messaggio.
import type { SendKey } from '@shared/protocol'
import { useApp } from '@/store/app-store'

interface KeyEventLike {
  key: string
  keyCode?: number
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  nativeEvent?: { isComposing?: boolean }
}

/** macOS: il tasto "mod" è ⌘; sulle altre piattaforme Ctrl. */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Tasto di invio scelto, in tempo reale; senza preferenze (anteprima, avvio) vale 'enter'. */
export function useSendKey(): SendKey {
  return useApp((s) => s.prefs?.sendKey ?? 'enter')
}

/**
 * Dice se l'evento di tastiera deve inviare. Mai durante la composizione (accenti, IME).
 * 'enter': Invio invia, ⇧Invio va a capo (⌘Invio invia lo stesso).
 * 'mod-enter': solo ⌘Invio (Ctrl altrove) invia, Invio va a capo.
 */
export function isSendKey(event: KeyEventLike, mode: SendKey): boolean {
  if (event.nativeEvent?.isComposing || event.keyCode === 229) return false
  if (event.key !== 'Enter') return false
  const mod = isMac ? event.metaKey : event.ctrlKey
  if (mode === 'mod-enter') return mod && !event.shiftKey && !event.altKey
  return mod || (!event.shiftKey && !event.altKey)
}

/** Combinazioni da mostrare con <Kbd>: "↵" e "⇧↵", oppure "⌘↵" e "↵" (Ctrl↵ fuori da macOS). */
export function sendKeyCombos(mode: SendKey): { send: string; newline: string } {
  const mod = isMac ? '⌘' : 'Ctrl'
  return mode === 'mod-enter' ? { send: `${mod}↵`, newline: '↵' } : { send: '↵', newline: '⇧↵' }
}

/**
 * Tasto di invio con ⌥ (Alt) in più: durante un turno fa l'altra azione tra "inserisci nel turno" e "accoda".
 * 'enter': ⌥Invio. 'mod-enter': ⌘⌥Invio (Ctrl+Alt+Invio altrove).
 */
export function isAltSendKey(event: KeyEventLike, mode: SendKey): boolean {
  if (event.nativeEvent?.isComposing || event.keyCode === 229) return false
  if (event.key !== 'Enter' || !event.altKey || event.shiftKey) return false
  const mod = isMac ? event.metaKey : event.ctrlKey
  return mode === 'mod-enter' ? mod : true
}

/** Combinazione da mostrare con <Kbd> per l'invio alternativo: "⌥↵" oppure "⌘⌥↵". */
export function altSendCombo(mode: SendKey): string {
  const alt = isMac ? '⌥' : 'Alt'
  return mode === 'mod-enter' ? `${isMac ? '⌘' : 'Ctrl'}${alt}↵` : `${alt}↵`
}

/** Azione effettiva di un invio durante il turno: "inserisci" ricade su "accoda" se l'agente non lo permette. */
export type BusyAction = 'queue' | 'steer'
export function resolveBusy(wanted: BusyAction, canSteer: boolean): BusyAction {
  return wanted === 'steer' && !canSteer ? 'queue' : wanted
}
