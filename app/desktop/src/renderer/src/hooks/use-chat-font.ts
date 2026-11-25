import type { AppPrefs, ChatFont, CodeFont, TextSize } from '@shared/protocol'
import { useApp } from '@/store/app-store'

export const DEFAULT_CHAT_FONT: ChatFont = 'system-sans'
/** Event before the chat font or width change: the chat captures its reading position there, with the layout still old. */
export const CHAT_LAYOUT_WILL_CHANGE = 'ladder:chat-layout-will-change'
export const DEFAULT_CHAT_WIDTH: AppPrefs['chatWidth'] = 'comfortable'
export const DEFAULT_TEXT_SIZE: TextSize = 'default'
export const DEFAULT_EDITOR_TEXT_SIZE = 12
export const DEFAULT_CODE_FONT: CodeFont = 'system-mono'
export const DEFAULT_SIDEBAR_DENSITY: AppPrefs['sidebarDensity'] = 'comfortable'
export const EDITOR_TEXT_SIZE_RANGE = { min: 10, max: 24 } as const

/**
 * Mirrors the reading preferences onto <html>: chatFont, chatWidth and chatTextSize as data-chat-font, data-chat-width and
 * data-chat-size (globals.css derives --font-chat, --chat-size and chat.css --chat-measure from them, for the chat only); editorFont as
 * data-code-font (code font: file editor and chat code blocks) and editorTextSize as --editor-size (file editor only); sidebarDensity as data-sidebar-density.
 */
export function useChatFont(): void {
  const font = useApp((s) => s.prefs?.chatFont) ?? DEFAULT_CHAT_FONT
  const width = useApp((s) => s.prefs?.chatWidth) ?? DEFAULT_CHAT_WIDTH
  const size = useApp((s) => s.prefs?.chatTextSize) ?? DEFAULT_TEXT_SIZE
  const codeFont = useApp((s) => s.prefs?.editorFont) ?? DEFAULT_CODE_FONT
  const editorSize = useApp((s) => s.prefs?.editorTextSize) ?? DEFAULT_EDITOR_TEXT_SIZE
  const density = useApp((s) => s.prefs?.sidebarDensity) ?? DEFAULT_SIDEBAR_DENSITY
  // Written during render, not in an effect: the children's layout effects (the chat restoring its reading position
  // after a change) run before those of whoever mounted them and must already see the new layout. It is idempotent.
  const root = document.documentElement
  if (root.dataset.chatFont !== font || root.dataset.chatWidth !== width || root.dataset.chatSize !== size) {
    if (root.dataset.chatFont !== undefined) window.dispatchEvent(new Event(CHAT_LAYOUT_WILL_CHANGE))
    root.dataset.chatFont = font
    root.dataset.chatWidth = width
    root.dataset.chatSize = size
  }
  root.dataset.codeFont = codeFont
  root.dataset.sidebarDensity = density
  const px = `${Math.min(EDITOR_TEXT_SIZE_RANGE.max, Math.max(EDITOR_TEXT_SIZE_RANGE.min, Math.round(editorSize)))}px`
  if (root.style.getPropertyValue('--editor-size') !== px) root.style.setProperty('--editor-size', px)
}
