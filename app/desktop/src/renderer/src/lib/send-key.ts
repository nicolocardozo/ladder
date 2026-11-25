// Key that sends in composers (AppPrefs.sendKey): a single place, so it applies wherever a message is written.
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

/** macOS: the "mod" key is ⌘; on other platforms Ctrl. */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Chosen send key, in real time; with no preferences (preview, startup) it is 'enter'. */
export function useSendKey(): SendKey {
  return useApp((s) => s.prefs?.sendKey ?? 'enter')
}

/**
 * Tells whether the keyboard event should send. Never during composition (accents, IME).
 * 'enter': Enter sends, ⇧Enter inserts a newline (⌘Enter sends too).
 * 'mod-enter': only ⌘Enter (Ctrl elsewhere) sends, Enter inserts a newline.
 */
export function isSendKey(event: KeyEventLike, mode: SendKey): boolean {
  if (event.nativeEvent?.isComposing || event.keyCode === 229) return false
  if (event.key !== 'Enter') return false
  const mod = isMac ? event.metaKey : event.ctrlKey
  if (mode === 'mod-enter') return mod && !event.shiftKey && !event.altKey
  return mod || (!event.shiftKey && !event.altKey)
}

/** Combinations to show with <Kbd>: "↵" and "⇧↵", or "⌘↵" and "↵" (Ctrl↵ outside macOS). */
export function sendKeyCombos(mode: SendKey): { send: string; newline: string } {
  const mod = isMac ? '⌘' : 'Ctrl'
  return mode === 'mod-enter' ? { send: `${mod}↵`, newline: '↵' } : { send: '↵', newline: '⇧↵' }
}

/**
 * Send key with ⌥ (Alt) added: during a turn it does the other action between "insert into the turn" and "queue".
 * 'enter': ⌥Invio. 'mod-enter': ⌘⌥Invio (Ctrl+Alt+Invio altrove).
 */
export function isAltSendKey(event: KeyEventLike, mode: SendKey): boolean {
  if (event.nativeEvent?.isComposing || event.keyCode === 229) return false
  if (event.key !== 'Enter' || !event.altKey || event.shiftKey) return false
  const mod = isMac ? event.metaKey : event.ctrlKey
  return mode === 'mod-enter' ? mod : true
}

/** Combination to show with <Kbd> for the alternate send: "⌥↵" or "⌘⌥↵". */
export function altSendCombo(mode: SendKey): string {
  const alt = isMac ? '⌥' : 'Alt'
  return mode === 'mod-enter' ? `${isMac ? '⌘' : 'Ctrl'}${alt}↵` : `${alt}↵`
}

/** Actual action of a send during the turn: "insert" falls back to "queue" if the agent doesn't allow it. */
export type BusyAction = 'queue' | 'steer'
export function resolveBusy(wanted: BusyAction, canSteer: boolean): BusyAction {
  return wanted === 'steer' && !canSteer ? 'queue' : wanted
}
