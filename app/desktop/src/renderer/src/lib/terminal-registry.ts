// xterm.js instances in the renderer, one per host terminal. They stay alive when the view unmounts
// (project change, panel closed): on return the element goes back to the DOM without rereading anything.
// After a reload or a host restart the screen is rebuilt with terminal.attach.
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { themeById, type ThemeInfo } from '@shared/themes.generated'
import { onHostConnect, request, send } from '@/lib/host-client'
import { findBinding, matchesCommand, TERMINAL_NATIVE_KEYS } from '@shared/shortcuts'

interface Entry {
  id: string
  term: Terminal
  fit: FitAddon
  element: HTMLDivElement
  opened: boolean
  /** Until the attach reply, incoming output is already in the rebuilt state: it is discarded. */
  state: 'idle' | 'attaching' | 'live'
  size: { cols: number; rows: number }
  selectionListeners: Set<(text: string) => void>
}

const entries = new Map<string, Entry>()
/** The next mounted terminal takes focus: only when you open it, not when the window is restored. */
let focusNext = false
let currentTheme: ThemeInfo = themeById(document.documentElement.dataset.theme ?? null)

export function routeTerminalData(id: string, data: string): void {
  const entry = entries.get(id)
  if (entry?.state === 'live') entry.term.write(data)
}

/** The host cleared its copy of the screen: this window also clears that terminal's xterm, if it has one. */
export function routeTerminalCleared(id: string): void {
  const entry = entries.get(id)
  if (entry) clearAfterWrites(entry.term)
}

// write() parses deferred, clear() acts immediately: the clear is queued behind the writes, or the output that just arrived reappears.
// On the alternate buffer (vim, less, an agent's CLI) clearing would break the interface.
function clearAfterWrites(term: Terminal): void {
  term.write('', () => {
    if (term.buffer.active.type !== 'alternate') term.clear()
  })
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0')
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`
}

/** ANSI colors from the theme tokens; Mono themes have their own, because there accent and states are gray. */
export function terminalTheme(theme: ThemeInfo): ITheme {
  const t = theme.tokens
  const dark = theme.appearance === 'dark'
  const bright = (color: string) => mix(color, dark ? '#FFFFFF' : '#000000', 0.18)
  const black = dark ? mix(t.background, t.text, 0.28) : t.text
  const white = dark ? t.text : mix(t.background, t.text, 0.35)
  const own = theme.syntax?.terminal
  const red = own?.red ?? t.error
  const green = own?.green ?? t.success
  const yellow = own?.yellow ?? t.waiting
  const blue = own?.blue ?? t.accent
  const magenta = own?.magenta ?? mix(t.accent, t.error, 0.45)
  const cyan = own?.cyan ?? mix(t.accent, t.success, 0.5)
  return {
    background: t.background,
    foreground: t.text,
    cursor: t.accent,
    cursorAccent: t.background,
    selectionBackground: t.selection,
    selectionForeground: t.onSelection,
    selectionInactiveBackground: mix(t.selection, t.background, 0.4),
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack: t.textMuted,
    brightRed: bright(red),
    brightGreen: bright(green),
    brightYellow: bright(yellow),
    brightBlue: bright(blue),
    brightMagenta: bright(magenta),
    brightCyan: bright(cyan),
    brightWhite: dark ? mix(t.text, '#FFFFFF', 0.5) : mix(t.background, t.text, 0.18)
  }
}

export function setTerminalTheme(theme: ThemeInfo): void {
  currentTheme = theme
  for (const entry of entries.values()) entry.term.options.theme = terminalTheme(theme)
}

/** Monaspace Neon as in code and diffs (DESIGN.md); SF Mono until it is loaded. */
const TERMINAL_FONT = '"Monaspace Neon", "SF Mono", ui-monospace, Menlo, monospace'
// The font is downloaded only when needed: it is requested right away, because xterm measures cells on open.
const fontReady = typeof document !== 'undefined' ? document.fonts.load('12px "Monaspace Neon"').catch(() => []) : Promise.resolve([])

function create(id: string): Entry {
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: TERMINAL_FONT,
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    // With the Italian keyboard ⌥ types @ # [ ]: it must not be used as Meta.
    macOptionIsMeta: false,
    theme: terminalTheme(currentTheme)
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  // Once the font arrives, xterm remeasures the cells and the terminal refits.
  void fontReady.then(() => {
    term.options.fontFamily = TERMINAL_FONT
    try {
      fit.fit()
    } catch {
      // Terminal not visible yet: it fits on open.
    }
  })
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  // Links open in the browser: the main process runs window.open towards the default browser.
  term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)))
  const element = document.createElement('div')
  element.className = 'h-full w-full'
  const entry: Entry = { id, term, fit, element, opened: false, state: 'idle', size: { cols: 0, rows: 0 }, selectionListeners: new Set() }
  term.onData((data) => send({ type: 'terminal.input', id, data }))
  term.onBinary((data) => send({ type: 'terminal.input', id, data }))
  term.onSelectionChange(() => {
    const text = term.getSelection()
    for (const listener of entry.selectionListeners) listener(text)
  })
  // ⌘ shortcuts stay with the app (⌘K, ⌘W, ⌘1…), like ⌃` which closes the panel;
  // only copy, paste and select all go to the terminal.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if (matchesCommand(event, 'terminal.toggle')) return false
    // Clears screen and scrollback (the prompt stays). stopPropagation: the global listener must not open the palette.
    if (matchesCommand(event, 'terminal.clear')) {
      event.preventDefault()
      event.stopPropagation()
      // On the alternate buffer the event is just consumed.
      if (term.buffer.active.type !== 'alternate') {
        clearAfterWrites(term)
        send({ type: 'terminal.clear', id })
      }
      return false
    }
    if (event.metaKey && !TERMINAL_NATIVE_KEYS.includes(event.key.toLowerCase())) return false
    // A global shortcut with ⌃ (⌃Tab to switch tabs) belongs to the app: xterm would swallow it as a terminal key.
    // Those without ⌃ or ⌘ stay with the terminal, so typing isn't intercepted.
    const binding = event.ctrlKey ? findBinding(event, 'global') : null
    return !binding
  })
  entries.set(id, entry)
  return entry
}

function attach(entry: Entry): void {
  entry.state = 'attaching'
  const { cols, rows } = entry.term
  request<{ data: string }>({ type: 'terminal.attach', id: entry.id, cols, rows })
    .then(({ data }) => {
      entry.term.reset()
      entry.term.write(data)
      entry.state = 'live'
    })
    .catch(() => {
      entry.state = 'idle'
    })
}

/** Sizes the terminal to the container and tells the host. */
export function fitTerminal(id: string): void {
  const entry = entries.get(id)
  if (!entry?.opened || !entry.element.isConnected || entry.element.clientWidth === 0) return
  try {
    entry.fit.fit()
  } catch {
    return
  }
  const { cols, rows } = entry.term
  if (cols !== entry.size.cols || rows !== entry.size.rows) {
    entry.size = { cols, rows }
    send({ type: 'terminal.resize', id, cols, rows })
  }
}

/** Puts the terminal in the container. Returns the function that detaches it without closing it. */
export function mountTerminal(id: string, container: HTMLElement): () => void {
  const entry = entries.get(id) ?? create(id)
  container.appendChild(entry.element)
  if (!entry.opened) {
    entry.term.open(entry.element)
    entry.opened = true
    fitTerminal(id)
    attach(entry)
  } else {
    requestAnimationFrame(() => fitTerminal(id))
  }
  if (focusNext) {
    focusNext = false
    requestAnimationFrame(() => entry.term.focus())
  }
  const observer = new ResizeObserver(() => fitTerminal(id))
  observer.observe(container)
  return () => {
    observer.disconnect()
    if (entry.element.parentElement === container) container.removeChild(entry.element)
  }
}

export function focusNextTerminal(): void {
  focusNext = true
}

export function focusTerminal(id: string): void {
  entries.get(id)?.term.focus()
}

export function clearTerminalSelection(id: string): void {
  entries.get(id)?.term.clearSelection()
}

export function onTerminalSelection(id: string, listener: (text: string) => void): () => void {
  const entry = entries.get(id) ?? create(id)
  entry.selectionListeners.add(listener)
  return () => entry.selectionListeners.delete(listener)
}

export function disposeTerminal(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.term.dispose()
  entry.element.remove()
  entries.delete(id)
}

// Host restarted: the state of open terminals is rebuilt from scratch.
onHostConnect(() => {
  for (const entry of entries.values()) if (entry.opened) attach(entry)
})

// Theme change (also from another window): open terminals pick up the new colors right away.
new MutationObserver(() => {
  const theme = themeById(document.documentElement.dataset.theme ?? null)
  if (theme.id !== currentTheme.id) setTerminalTheme(theme)
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
