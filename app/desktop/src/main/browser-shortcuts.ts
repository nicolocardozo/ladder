// Which keys pressed in the native browser page are forwarded to the renderer.
// App shortcuts come from the central registry (shared/shortcuts.ts): they follow presets and customizations.
import { findBinding } from '../shared/shortcuts'

/** The minimum of Electron.Input needed here: so the function can be tested without Electron. */
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
  * ⌘+key (no other modifiers) that always stays with the page, even if an app command is bound to it:
  * bold and save (⌘B, ⌘S), copy/paste/cut/select all/undo (⌘C ⌘V ⌘X ⌘A ⌘Z), find and reload (⌘F, ⌘R).
  * If the user remaps a command to one of these, the page wins; variants with ⇧, ⌥ or ⌃ stay with the app.
 */
const PAGE_KEYS = new Set(['b', 's', 'c', 'v', 'x', 'a', 'z', 'f', 'r'])

/** ⌘L moves the cursor to the address bar: handled by the browser view, it is not a registry command. */
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
  * ⌘R (no other modifiers) on the native page: the page sees it, but the app menu must not run it. Without this
  * the View menu's `reload` role (⌘R) would reload the app window, not the page. Applies to keyDown and keyUp.
 */
export function pageKeepsReload(input: ShortcutInput): boolean {
  return input.meta && !input.control && !input.alt && !input.shift && input.key.toLowerCase() === 'r'
}
