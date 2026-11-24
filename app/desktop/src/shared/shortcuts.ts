// Registro delle scorciatoie: un comando ha un id stabile, una scorciatoia predefinita (stringa in sintassi VS Code,
// per esempio "cmd+shift+p") e i contesti in cui vale. Qui non ci sono azioni: stanno nel renderer (lib/shortcuts.ts),
// così il processo main può importare lo stesso registro per gli acceleratori del menu.
// Pensato per la personalizzazione (keybindings.json come in VS Code: [{ "key": "cmd+shift+p", "command": "…" }]):
// le scorciatoie dell'utente sovrascrivono quelle predefinite tramite setKeybindingOverrides.

/** Dove vale un comando: finestra intera, composer, editor di codice, terminale o menu dell'app (acceleratore nativo). */
export type ShortcutContext = 'global' | 'composer' | 'editor' | 'terminal' | 'menu'

export type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta'

/** Il minimo che serve di un KeyboardEvent (anche quello di React): il main non ha il DOM. */
export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** Una scorciatoia letta: modificatori e tasto in forma canonica (minuscolo, "left" e non "ArrowLeft"). */
export interface Chord {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  key: string
}

type ProjectSelectId = `project.select${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

export type CommandId =
  | 'palette.toggle'
  | 'quickOpen.toggle'
  | 'sidebar.toggle'
  | 'nav.back'
  | 'nav.forward'
  | 'chat.new'
  | 'chat.newFrom'
  | 'chat.split'
  | ProjectSelectId
  | 'column.focusLeft'
  | 'column.focusRight'
  | 'tab.moveLeft'
  | 'tab.moveRight'
  | 'tab.close'
  | 'tab.next'
  | 'tab.previous'
  | 'tab.reopenClosed'
  | 'search.project'
  | 'inspector.changes'
  | 'inspector.files'
  | 'inspector.history'
  | 'inspector.merge'
  | 'inspector.toggle'
  | 'terminal.toggle'
  | 'file.save'
  | 'session.nextWaiting'
  | 'session.interrupt'
  | 'composer.cyclePermission'
  | 'composer.stop'
  | 'app.openSettings'
  | 'window.close'

interface CommandSpec {
  /** Scorciatoia predefinita, sintassi VS Code; vuota se il comando non ne ha di sue (le danno i preset o l'utente). */
  key: string
  contexts: readonly ShortcutContext[]
  /**
   * Modificatori che la scorciatoia predefinita ignora (per esempio ⌥ su ⌘W). Esiste per non cambiare il comportamento
   * di prima; le scorciatoie scelte dall'utente si confrontano sempre in modo esatto.
   */
  loose?: readonly Modifier[]
}

const spec = (key: string, contexts: readonly ShortcutContext[] = ['global'], loose?: readonly Modifier[]): CommandSpec => ({ key, contexts, loose })

const projectCommands = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`project.select${n}`, spec(`cmd+${n}`)])) as Record<ProjectSelectId, CommandSpec>

/** Ordine = priorità a parità di corrispondenza. */
export const COMMANDS: Record<CommandId, CommandSpec> = {
  'palette.toggle': spec('cmd+k'),
  'quickOpen.toggle': spec('cmd+p'),
  'sidebar.toggle': spec('cmd+b'),
  // Su tastiere dove [ e ] richiedono ⌥ (per esempio quella italiana) event.key resta la parentesi: ⌥ non conta.
  'nav.back': spec('cmd+[', ['global'], ['alt']),
  'nav.forward': spec('cmd+]', ['global'], ['alt']),
  'chat.new': spec('cmd+n', ['global'], ['alt']),
  'chat.newFrom': spec('cmd+shift+n'),
  'chat.split': spec('cmd+\\'),
  ...projectCommands,
  // Con ⌥ event.key cambia carattere: i tasti con ⌥ si confrontano sul tasto fisico (event.code).
  'column.focusLeft': spec('cmd+alt+left'),
  'column.focusRight': spec('cmd+alt+right'),
  'tab.moveLeft': spec('cmd+alt+shift+left'),
  'tab.moveRight': spec('cmd+alt+shift+right'),
  'tab.close': spec('cmd+w', ['global'], ['alt']),
  // Nuovi (LAD-20): senza scorciatoia propria, la danno i preset "vscode" e "cursor" (PRESET_BINDINGS).
  'tab.next': spec('', ['global']),
  'tab.previous': spec('', ['global']),
  'tab.reopenClosed': spec('', ['global']),
  'search.project': spec('', ['global']),
  'inspector.changes': spec('cmd+alt+1'),
  'inspector.files': spec('cmd+alt+2'),
  'inspector.history': spec('cmd+alt+3'),
  'inspector.merge': spec('cmd+alt+4'),
  // Apre e chiude il pannello di destra sull'ultima scheda usata (⌘⌥B come la barra laterale secondaria di VS Code).
  'inspector.toggle': spec('cmd+alt+b'),
  // ⌃` non richiede ⌘ e vale anche con ⇧ o ⌥; il terminale la lascia passare all'app.
  'terminal.toggle': spec('ctrl+`', ['global', 'terminal'], ['shift', 'alt']),
  // ⌘S salva anche se il cursore non è nel testo, per esempio dopo un clic su un avviso.
  'file.save': spec('cmd+s', ['global', 'editor'], ['alt']),
  'session.nextWaiting': spec('cmd+shift+a', ['global'], ['alt']),
  'session.interrupt': spec('cmd+.', ['global'], ['shift', 'alt']),
  // ⇧Tab cicla i livelli di permesso, come nel CLI di Claude Code.
  'composer.cyclePermission': spec('shift+tab', ['composer'], ['ctrl', 'alt', 'meta']),
  'composer.stop': spec('escape', ['composer'], ['ctrl', 'alt', 'shift', 'meta']),
  // Menu dell'app: li gestisce Electron con l'acceleratore, non il renderer.
  'app.openSettings': spec('cmd+,', ['menu']),
  'window.close': spec('cmd+shift+w', ['menu'])
}

// ---------------------------------------------------------------------------------------------------------------------
// Preset

/** Insieme di partenza delle scorciatoie. "ladder" = i predefiniti del registro; gli altri li completano con quelle di VS Code e Cursor. */
export type ShortcutPreset = 'ladder' | 'vscode' | 'cursor'

export const SHORTCUT_PRESETS: readonly ShortcutPreset[] = ['ladder', 'vscode', 'cursor']
export const DEFAULT_SHORTCUT_PRESET: ShortcutPreset = 'ladder'

export const isShortcutPreset = (value: unknown): value is ShortcutPreset => typeof value === 'string' && (SHORTCUT_PRESETS as readonly string[]).includes(value)

/** Cosa aggiunge ogni preset ai predefiniti (più voci per lo stesso comando = più scorciatoie attive: ⌘K resta e ⌘⇧P si aggiunge). */
const VSCODE_LIKE: Keybinding[] = [
  { key: 'cmd+shift+p', command: 'palette.toggle' },
  { key: 'ctrl+tab', command: 'tab.next' },
  { key: 'ctrl+shift+tab', command: 'tab.previous' },
  { key: 'cmd+shift+t', command: 'tab.reopenClosed' },
  { key: 'cmd+shift+f', command: 'search.project' }
]

export const PRESET_BINDINGS: Record<ShortcutPreset, readonly Keybinding[]> = {
  ladder: [],
  vscode: VSCODE_LIKE,
  // Oggi identico a vscode: i nomi restano distinti per poter divergere.
  cursor: VSCODE_LIKE
}

/** Tasti con ⌘ che il terminale tiene per sé (copia, incolla, seleziona tutto); gli altri ⌘ restano all'app. */
export const TERMINAL_NATIVE_KEYS: readonly string[] = ['c', 'v', 'a']

// ---------------------------------------------------------------------------------------------------------------------
// Sintassi

const MODIFIER_ALIASES: Record<string, Modifier> = {
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
  win: 'meta',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift'
}

/** Nomi alternativi dei tasti (VS Code scrive "backquote", "oem_5" e simili) verso la forma canonica. */
const KEY_ALIASES: Record<string, string> = {
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  backquote: '`',
  backslash: '\\',
  bracketleft: '[',
  bracketright: ']',
  comma: ',',
  period: '.',
  minus: '-',
  equal: '=',
  slash: '/',
  semicolon: ';',
  quote: "'",
  plus: '+'
}

/** Tasti con nome: valore di event.key (minuscolo) e di event.code. */
const NAMED: Record<string, { key: string; code: string }> = {
  left: { key: 'arrowleft', code: 'ArrowLeft' },
  right: { key: 'arrowright', code: 'ArrowRight' },
  up: { key: 'arrowup', code: 'ArrowUp' },
  down: { key: 'arrowdown', code: 'ArrowDown' },
  enter: { key: 'enter', code: 'Enter' },
  escape: { key: 'escape', code: 'Escape' },
  tab: { key: 'tab', code: 'Tab' },
  backspace: { key: 'backspace', code: 'Backspace' },
  delete: { key: 'delete', code: 'Delete' },
  space: { key: ' ', code: 'Space' },
  home: { key: 'home', code: 'Home' },
  end: { key: 'end', code: 'End' },
  pageup: { key: 'pageup', code: 'PageUp' },
  pagedown: { key: 'pagedown', code: 'PageDown' }
}

const PUNCTUATION_CODES: Record<string, string> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  '`': 'Backquote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '-': 'Minus',
  '=': 'Equal'
}

/** Tasti che si riconoscono anche dalla posizione fisica: stanno in posti diversi nelle tastiere. */
const PHYSICAL = new Set(['`', '\\'])

/** Tasto fisico (event.code) di un tasto canonico, se si sa qual è. */
function codeOf(key: string): string | undefined {
  if (NAMED[key]) return NAMED[key].code
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (/^f([1-9]|1[0-2])$/.test(key)) return key.toUpperCase()
  return PUNCTUATION_CODES[key]
}

/** Legge "cmd+shift+p". null se non è una scorciatoia valida (le sequenze a più accordi, "cmd+k cmd+s", non sono supportate). */
export function parseShortcut(shortcut: string): Chord | null {
  const text = shortcut.trim().toLowerCase()
  if (!text || /\s/.test(text)) return null
  // Il tasto può essere "+" stesso ("cmd++").
  const plusKey = text.endsWith('+') && text.length > 1
  const parts = (plusKey ? text.slice(0, -1) : text).split('+')
  if (plusKey) parts.pop()
  const chord: Chord = { ctrl: false, alt: false, shift: false, meta: false, key: plusKey ? '+' : '' }
  for (const [index, part] of parts.entries()) {
    const modifier = MODIFIER_ALIASES[part]
    if (modifier && (plusKey || index < parts.length - 1)) {
      chord[modifier] = true
      continue
    }
    // L'ultimo elemento non modificatore è il tasto, uno solo.
    if (plusKey || index !== parts.length - 1 || chord.key) return null
    chord.key = KEY_ALIASES[part] ?? part
  }
  if (!chord.key) return null
  const known = chord.key.length === 1 || NAMED[chord.key] || /^f([1-9]|1[0-2])$/.test(chord.key)
  return known ? chord : null
}

/**
 * Senza ⌃, ⌘ o ⌥ una scorciatoia intercetterebbe la scrittura: ammessi solo i tasti funzione. È l'unica regola, per la
 * schermata delle impostazioni e per la lettura di keybindings.json (i predefiniti, come ⇧Tab o Esc nel composer, non passano da qui).
 */
export const hasAnchor = (chord: Chord): boolean => chord.ctrl || chord.meta || chord.alt || /^f\d+$/.test(chord.key)

/** La stessa scorciatoia in forma canonica ("cmd+shift+p"): serve a confrontare e a salvare. */
export function serializeShortcut(chord: Chord): string {
  return [chord.ctrl && 'ctrl', chord.alt && 'alt', chord.shift && 'shift', chord.meta && 'cmd', chord.key].filter(Boolean).join('+')
}

// ---------------------------------------------------------------------------------------------------------------------
// Confronto con un evento

/**
 * Vero se l'evento è questa scorciatoia. I modificatori si confrontano in modo esatto, tranne quelli in `loose`.
 * Con ⌥ conta il tasto fisico (event.code, perché ⌥ cambia event.key); altrimenti il carattere, e per ` e \ anche la
 * posizione fisica.
 */
export function matchesChord(event: KeyLike, chord: Chord, loose: readonly Modifier[] = []): boolean {
  const same = (modifier: Modifier, actual: boolean) => loose.includes(modifier) || actual === chord[modifier]
  if (!same('ctrl', event.ctrlKey) || !same('alt', event.altKey) || !same('shift', event.shiftKey) || !same('meta', event.metaKey)) return false
  const code = codeOf(chord.key)
  if (chord.alt) return code !== undefined && event.code === code
  // ⌃` conta solo per il tasto fisico, come prima: il carattere ` su altre tastiere richiede ⌥ o altri tasti.
  if (chord.key === '`') return event.code === code
  const key = NAMED[chord.key]?.key ?? chord.key
  if (event.key.toLowerCase() === key) return true
  return PHYSICAL.has(chord.key) && event.code === code
}

// ---------------------------------------------------------------------------------------------------------------------
// Scorciatoie in uso (predefinite + personalizzate)

/** Una voce di keybindings.json, come in VS Code. Un `command` che inizia con "-" toglie la scorciatoia predefinita. */
export interface Keybinding {
  key: string
  command: string
}

export interface Binding {
  id: CommandId
  chord: Chord
  loose: readonly Modifier[]
  contexts: readonly ShortcutContext[]
  source: 'default' | 'preset' | 'user'
}

let overrides: Keybinding[] = []
let preset: ShortcutPreset = DEFAULT_SHORTCUT_PRESET
let cache: Map<CommandId, Binding[]> | null = null

/**
 * Imposta le scorciatoie personalizzate (keybindings.json). Per un comando vince l'ultima voce valida e sostituisce
 * predefinita e preset; `-comando` le toglie tutte.
 */
export function setKeybindingOverrides(list: Keybinding[]): void {
  overrides = list
  cache = null
}

export function setShortcutPreset(next: ShortcutPreset): void {
  preset = next
  cache = null
}

/** Applica insieme preset e personalizzazioni: la usano renderer e main con lo stesso stato salvato dall'host. */
export function applyShortcutConfig(config: { preset: ShortcutPreset; overrides: Keybinding[] }): void {
  preset = config.preset
  overrides = config.overrides
  cache = null
}

export const isCommandId = (value: unknown): value is CommandId => typeof value === 'string' && Object.hasOwn(COMMANDS, value)

function resolve(id: CommandId): Binding[] {
  const { contexts, loose = [] } = COMMANDS[id]
  let removed = false
  let user: Chord | null = null
  for (const entry of overrides) {
    if (entry.command === `-${id}`) removed = true
    else if (entry.command === id) {
      const chord = parseShortcut(entry.key)
      // Una voce non valida si ignora, come fa VS Code.
      if (chord) {
        user = chord
        removed = false
      }
    }
  }
  if (user) return [{ id, chord: user, loose: [], contexts, source: 'user' }]
  if (removed) return []
  const list: Binding[] = []
  const base = parseShortcut(COMMANDS[id].key)
  if (base) list.push({ id, chord: base, loose, contexts, source: 'default' })
  // Le voci del preset si aggiungono ai predefiniti (alias), senza doppioni.
  for (const entry of PRESET_BINDINGS[preset]) {
    const chord = entry.command === id ? parseShortcut(entry.key) : null
    if (chord && !list.some((b) => serializeShortcut(b.chord) === serializeShortcut(chord))) list.push({ id, chord, loose: [], contexts, source: 'preset' })
  }
  return list
}

/** Tutte le scorciatoie in uso per un comando (la prima è quella principale); vuoto se non ne ha. */
export function bindingsOf(id: CommandId): Binding[] {
  cache ??= new Map()
  let list = cache.get(id)
  if (!list) cache.set(id, (list = resolve(id)))
  return list
}

/** La scorciatoia principale in uso per un comando, o null se non ne ha. */
export function bindingOf(id: CommandId): Binding | null {
  return bindingsOf(id)[0] ?? null
}

const IDS = Object.keys(COMMANDS) as CommandId[]

/** Le scorciatoie in uso valide in un contesto, nell'ordine del registro. */
export function bindingsIn(context: ShortcutContext): Binding[] {
  return IDS.flatMap(bindingsOf).filter((binding) => binding.contexts.includes(context))
}

/** Il comando che l'evento attiva in un contesto. Prima le scorciatoie esatte, poi quelle che ignorano dei modificatori. */
export function findBinding(event: KeyLike, context: ShortcutContext): Binding | null {
  const list = bindingsIn(context)
  return list.find((b) => b.loose.length === 0 && matchesChord(event, b.chord)) ?? list.find((b) => b.loose.length > 0 && matchesChord(event, b.chord, b.loose)) ?? null
}

/** Vero se l'evento attiva proprio questo comando. */
export function matchesCommand(event: KeyLike, id: CommandId): boolean {
  return bindingsOf(id).some((binding) => matchesChord(event, binding.chord, binding.loose))
}

// ---------------------------------------------------------------------------------------------------------------------
// Formati di uscita

const DISPLAY_KEYS: Record<string, string> = { left: '←', right: '→', up: '↑', down: '↓', enter: '↵', escape: 'esc', tab: '⇥', backspace: '⌫', delete: 'Del', space: 'Space' }

/** "cmd+shift+p" diventa ⌘⇧P, come si legge nell'interfaccia (ordine ⌃ ⌘ ⌥ ⇧). Vuota se la scorciatoia non è valida. */
/**
 * Caratteri della tastiera in uso per tasto fisico (event.code → carattere), dal renderer (navigator.keyboard.getLayoutMap).
 * Servono alle etichette dei tasti che si riconoscono per posizione: su una tastiera italiana il tasto di ⌃` stampa "\".
 */
let layoutKeys: ReadonlyMap<string, string> | null = null

export function setKeyboardLayout(map: ReadonlyMap<string, string> | null): void {
  layoutKeys = map
}

/** Il carattere che il tasto fisico dell'accordo stampa con la tastiera in uso, se l'accordo si riconosce per posizione (` e le combinazioni con ⌥). */
function layoutKey(chord: Chord): string | undefined {
  if (!layoutKeys || NAMED[chord.key] || !(chord.alt || chord.key === '`')) return undefined
  const code = codeOf(chord.key)
  const char = code ? layoutKeys.get(code) : undefined
  return char && char.trim() ? char.toUpperCase() : undefined
}

export function formatShortcut(shortcut: string | Chord): string {
  const chord = typeof shortcut === 'string' ? parseShortcut(shortcut) : shortcut
  if (!chord) return ''
  const key = layoutKey(chord) ?? DISPLAY_KEYS[chord.key] ?? chord.key.toUpperCase()
  return `${chord.ctrl ? '⌃' : ''}${chord.meta ? '⌘' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${key}`
}

/** Come la mostra l'interfaccia la scorciatoia di un comando; stringa vuota se non ne ha. */
export function shortcutLabel(id: CommandId): string {
  const binding = bindingOf(id)
  return binding ? formatShortcut(binding.chord) : ''
}

const ACCELERATOR_KEYS: Record<string, string> = { left: 'Left', right: 'Right', up: 'Up', down: 'Down', enter: 'Enter', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', space: 'Space', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' }

/** Tutte le scorciatoie di un comando come le mostra l'interfaccia (alias compresi). */
export function shortcutLabels(id: CommandId): string[] {
  return bindingsOf(id).map((binding) => formatShortcut(binding.chord))
}

/** Tasti di punteggiatura ASCII che Electron accetta come acceleratore (il "+" ha un nome a parte: "Plus"). */
const ACCELERATOR_PUNCTUATION = new Set("`~!@#$%^&*()_-=[]{}\\|;:'\",<.>/?")

/** Il tasto come lo scrive un acceleratore di Electron; undefined se non si può esprimere (per esempio "ò": Electron accetta solo ASCII). */
function acceleratorKey(key: string): string | undefined {
  if (ACCELERATOR_KEYS[key]) return ACCELERATOR_KEYS[key]
  if (key === '+') return 'Plus'
  if (/^[a-z0-9]$/.test(key)) return key.toUpperCase()
  if (/^f([1-9]|1[0-2])$/.test(key)) return key.toUpperCase()
  return ACCELERATOR_PUNCTUATION.has(key) ? key : undefined
}

/**
 * Acceleratore di Electron per il menu ("cmd+shift+w" diventa "CmdOrCtrl+Shift+W"). undefined se il comando non ha
 * scorciatoia o se il tasto non è esprimibile: la voce di menu resta senza acceleratore e la scorciatoia la gestisce il renderer.
 */
export function acceleratorOf(id: CommandId): string | undefined {
  const chord = bindingOf(id)?.chord
  if (!chord) return undefined
  const key = acceleratorKey(chord.key)
  if (!key) return undefined
  return [chord.meta && 'CmdOrCtrl', chord.ctrl && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', key].filter(Boolean).join('+')
}

const CODEMIRROR_KEYS: Record<string, string> = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', enter: 'Enter', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', space: 'Space', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' }

/** Tasto per la keymap di CodeMirror ("cmd+s" diventa "Mod-s"). undefined se il comando non ha scorciatoia. */
export function codeMirrorKeyOf(id: CommandId): string | undefined {
  const chord = bindingOf(id)?.chord
  if (!chord) return undefined
  return [chord.ctrl && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', chord.meta && 'Mod', CODEMIRROR_KEYS[chord.key] ?? chord.key].filter(Boolean).join('-')
}
