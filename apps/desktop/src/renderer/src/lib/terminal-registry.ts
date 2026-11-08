// Istanze di xterm.js nel renderer, una per terminale dell'host. Restano vive quando la vista si smonta
// (cambio progetto, pannello chiuso): al rientro l'elemento torna nel DOM senza rileggere nulla.
// Dopo un ricaricamento o un riavvio dell'host lo schermo si ricostruisce con terminal.attach.
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { themeById, type ThemeInfo } from '@shared/themes.generated'
import { onHostConnect, request, send } from '@/lib/host-client'

interface Entry {
  id: string
  term: Terminal
  fit: FitAddon
  element: HTMLDivElement
  opened: boolean
  /** Fino alla risposta di attach l'output in arrivo è già nello stato ricostruito: si scarta. */
  state: 'idle' | 'attaching' | 'live'
  size: { cols: number; rows: number }
  selectionListeners: Set<(text: string) => void>
}

const entries = new Map<string, Entry>()
/** Il prossimo terminale montato prende il focus: solo quando lo apri tu, non al ripristino della finestra. */
let focusNext = false
let currentTheme: ThemeInfo = themeById(document.documentElement.dataset.theme ?? null)

export function routeTerminalData(id: string, data: string): void {
  const entry = entries.get(id)
  if (entry?.state === 'live') entry.term.write(data)
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

/** Colori ANSI dai token del tema: nei temi Mono escono grigi, come il resto dell'interfaccia. */
export function terminalTheme(theme: ThemeInfo): ITheme {
  const t = theme.tokens
  const dark = theme.appearance === 'dark'
  const bright = (color: string) => mix(color, dark ? '#FFFFFF' : '#000000', 0.18)
  const black = dark ? mix(t.background, t.text, 0.28) : t.text
  const white = dark ? t.text : mix(t.background, t.text, 0.35)
  const magenta = mix(t.accent, t.error, 0.45)
  const cyan = mix(t.accent, t.success, 0.5)
  return {
    background: t.background,
    foreground: t.text,
    cursor: t.accent,
    cursorAccent: t.background,
    selectionBackground: t.selection,
    selectionForeground: t.onSelection,
    selectionInactiveBackground: mix(t.selection, t.background, 0.4),
    black,
    red: t.error,
    green: t.success,
    yellow: t.waiting,
    blue: t.accent,
    magenta,
    cyan,
    white,
    brightBlack: t.textMuted,
    brightRed: bright(t.error),
    brightGreen: bright(t.success),
    brightYellow: bright(t.waiting),
    brightBlue: bright(t.accent),
    brightMagenta: bright(magenta),
    brightCyan: bright(cyan),
    brightWhite: dark ? mix(t.text, '#FFFFFF', 0.5) : mix(t.background, t.text, 0.18)
  }
}

export function setTerminalTheme(theme: ThemeInfo): void {
  currentTheme = theme
  for (const entry of entries.values()) entry.term.options.theme = terminalTheme(theme)
}

/** Monaspace Neon come nel codice e nei diff (DESIGN.md); SF Mono finché non è caricata. */
const TERMINAL_FONT = '"Monaspace Neon", "SF Mono", ui-monospace, Menlo, monospace'
// Il carattere si scarica solo quando serve: lo si chiede subito, perché xterm misura le celle all'apertura.
const fontReady = typeof document !== 'undefined' ? document.fonts.load('12px "Monaspace Neon"').catch(() => []) : Promise.resolve([])

function create(id: string): Entry {
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: TERMINAL_FONT,
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    // Con la tastiera italiana ⌥ scrive @ # [ ]: non va usato come Meta.
    macOptionIsMeta: false,
    theme: terminalTheme(currentTheme)
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  // Arrivato il carattere, xterm rimisura le celle e il terminale si riadatta.
  void fontReady.then(() => {
    term.options.fontFamily = TERMINAL_FONT
    try {
      fit.fit()
    } catch {
      // Terminale non ancora visibile: si adatta all'apertura.
    }
  })
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  // I link si aprono nel browser: il processo main gira window.open verso il browser predefinito.
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
  // Le scorciatoie con ⌘ restano all'app (⌘K, ⌘W, ⌘1…), come ⌃` che chiude il pannello;
  // al terminale vanno solo copia, incolla e seleziona tutto.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if (event.ctrlKey && event.code === 'Backquote') return false
    return !(event.metaKey && !['c', 'v', 'a'].includes(event.key.toLowerCase()))
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

/** Dimensiona il terminale sul contenitore e lo comunica all'host. */
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

/** Mette il terminale nel contenitore. Restituisce la funzione che lo stacca senza chiuderlo. */
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

// Host riavviato: lo stato dei terminali aperti si ricostruisce da capo.
onHostConnect(() => {
  for (const entry of entries.values()) if (entry.opened) attach(entry)
})

// Cambio di tema (anche da un'altra finestra): i terminali aperti prendono subito i nuovi colori.
new MutationObserver(() => {
  const theme = themeById(document.documentElement.dataset.theme ?? null)
  if (theme.id !== currentTheme.id) setTerminalTheme(theme)
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
