import type { AppPrefs, ChatFont, CodeFont, TextSize } from '@shared/protocol'
import { useApp } from '@/store/app-store'

export const DEFAULT_CHAT_FONT: ChatFont = 'system-sans'
/** Evento prima che font o larghezza della chat cambino: la chat prende lì la posizione di lettura, con il layout ancora vecchio. */
export const CHAT_LAYOUT_WILL_CHANGE = 'ladder:chat-layout-will-change'
export const DEFAULT_CHAT_WIDTH: AppPrefs['chatWidth'] = 'comfortable'
export const DEFAULT_TEXT_SIZE: TextSize = 'default'
export const DEFAULT_EDITOR_TEXT_SIZE = 12
export const DEFAULT_CODE_FONT: CodeFont = 'system-mono'
export const DEFAULT_SIDEBAR_DENSITY: AppPrefs['sidebarDensity'] = 'comfortable'
export const EDITOR_TEXT_SIZE_RANGE = { min: 10, max: 24 } as const

/**
 * Riflette le preferenze di lettura su <html>: chatFont, chatWidth e chatTextSize come data-chat-font, data-chat-width e
 * data-chat-size (globals.css ne ricava --font-chat, --chat-size e chat.css --chat-measure, solo per la chat); editorFont come
 * data-code-font (font del codice: editor dei file e blocchi di codice della chat) e editorTextSize come --editor-size (solo editor dei file); sidebarDensity come data-sidebar-density.
 */
export function useChatFont(): void {
  const font = useApp((s) => s.prefs?.chatFont) ?? DEFAULT_CHAT_FONT
  const width = useApp((s) => s.prefs?.chatWidth) ?? DEFAULT_CHAT_WIDTH
  const size = useApp((s) => s.prefs?.chatTextSize) ?? DEFAULT_TEXT_SIZE
  const codeFont = useApp((s) => s.prefs?.editorFont) ?? DEFAULT_CODE_FONT
  const editorSize = useApp((s) => s.prefs?.editorTextSize) ?? DEFAULT_EDITOR_TEXT_SIZE
  const density = useApp((s) => s.prefs?.sidebarDensity) ?? DEFAULT_SIDEBAR_DENSITY
  // Scritti durante il render, non in un effetto: gli effetti di layout dei figli (la chat che ritrova la posizione di lettura
  // dopo un cambio) girano prima di quelli di chi li ha montati e devono già vedere il nuovo layout. È idempotente.
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
