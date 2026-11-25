// Shortcut registry: a command has a stable id, a default shortcut (string in VS Code syntax,
// for example "cmd+shift+p") and the contexts where it applies. There are no actions here: they live in the renderer (lib/shortcuts.ts),
// so the main process can import the same registry for the menu accelerators.
// Designed for customization (keybindings.json as in VS Code: [{ "key": "cmd+shift+p", "command": "…" }]):
// user shortcuts override the defaults through setKeybindingOverrides.

/** Where a command applies: whole window, composer, code editor, terminal or app menu (native accelerator). */
export type ShortcutContext = 'global' | 'composer' | 'editor' | 'terminal' | 'menu'

export type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta'

/** The minimum needed from a KeyboardEvent (including React's): main has no DOM. */
export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** A parsed shortcut: modifiers and key in canonical form (lowercase, "left" and not "ArrowLeft"). */
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
  | 'terminal.clear'
  | 'file.save'
  | 'session.nextWaiting'
  | 'session.interrupt'
  | 'composer.cyclePermission'
  | 'composer.stop'
  | 'app.openSettings'
  | 'window.close'

interface CommandSpec {
  /** Default shortcut, VS Code syntax; empty if the command has none of its own (presets or the user provide them). */
  key: string
  contexts: readonly ShortcutContext[]
  /**
   * Modifiers that the default shortcut ignores (for example ⌥ on ⌘W). It exists to keep the previous behavior
   * unchanged; shortcuts chosen by the user are always compared exactly.
   */
  loose?: readonly Modifier[]
}

const spec = (key: string, contexts: readonly ShortcutContext[] = ['global'], loose?: readonly Modifier[]): CommandSpec => ({ key, contexts, loose })

const projectCommands = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`project.select${n}`, spec(`cmd+${n}`)])) as Record<ProjectSelectId, CommandSpec>

/** Order = priority when matches are equal. */
export const COMMANDS: Record<CommandId, CommandSpec> = {
  'palette.toggle': spec('cmd+k'),
  'quickOpen.toggle': spec('cmd+p'),
  'sidebar.toggle': spec('cmd+b'),
  // On keyboards where [ and ] require ⌥ (for example the Italian one) event.key stays the bracket: ⌥ doesn't count.
  'nav.back': spec('cmd+[', ['global'], ['alt']),
  'nav.forward': spec('cmd+]', ['global'], ['alt']),
  'chat.new': spec('cmd+n', ['global'], ['alt']),
  'chat.newFrom': spec('cmd+shift+n'),
  'chat.split': spec('cmd+\\'),
  ...projectCommands,
  // With ⌥ event.key changes character: keys with ⌥ are compared on the physical key (event.code).
  'column.focusLeft': spec('cmd+alt+left'),
  'column.focusRight': spec('cmd+alt+right'),
  'tab.moveLeft': spec('cmd+alt+shift+left'),
  'tab.moveRight': spec('cmd+alt+shift+right'),
  'tab.close': spec('cmd+w', ['global'], ['alt']),
  // New: no shortcut of their own, the "vscode" and "cursor" presets provide them (PRESET_BINDINGS).
  'tab.next': spec('', ['global']),
  'tab.previous': spec('', ['global']),
  'tab.reopenClosed': spec('', ['global']),
  'search.project': spec('', ['global']),
  'inspector.changes': spec('cmd+alt+1'),
  'inspector.files': spec('cmd+alt+2'),
  'inspector.history': spec('cmd+alt+3'),
  'inspector.merge': spec('cmd+alt+4'),
  // Opens and closes the right panel on the last used tab (⌘⌥B like VS Code's secondary sidebar).
  'inspector.toggle': spec('cmd+alt+b'),
  // ⌃` doesn't require ⌘ and also applies with ⇧ or ⌥; the terminal lets it through to the app.
  'terminal.toggle': spec('ctrl+`', ['global', 'terminal'], ['shift', 'alt']),
  // Terminal only: there ⌘K clears (as in Terminal.app and VS Code) and wins over palette.toggle; with focus elsewhere ⌘K opens the palette.
  'terminal.clear': spec('cmd+k', ['terminal']),
  // ⌘S saves even if the cursor is not in the text, for example after clicking a notice.
  'file.save': spec('cmd+s', ['global', 'editor'], ['alt']),
  'session.nextWaiting': spec('cmd+shift+a', ['global'], ['alt']),
  'session.interrupt': spec('cmd+.', ['global'], ['shift', 'alt']),
  // ⇧Tab cycles the permission levels, as in the Claude Code CLI.
  'composer.cyclePermission': spec('shift+tab', ['composer'], ['ctrl', 'alt', 'meta']),
  'composer.stop': spec('escape', ['composer'], ['ctrl', 'alt', 'shift', 'meta']),
  // App menu: handled by Electron through the accelerator, not by the renderer.
  'app.openSettings': spec('cmd+,', ['menu']),
  'window.close': spec('cmd+shift+w', ['menu'])
}

// ---------------------------------------------------------------------------------------------------------------------
// Presets

/** Starting set of shortcuts. "ladder" = the registry defaults; the others complete them with those of VS Code and Cursor. */
export type ShortcutPreset = 'ladder' | 'vscode' | 'cursor'

export const SHORTCUT_PRESETS: readonly ShortcutPreset[] = ['ladder', 'vscode', 'cursor']
export const DEFAULT_SHORTCUT_PRESET: ShortcutPreset = 'ladder'

export const isShortcutPreset = (value: unknown): value is ShortcutPreset => typeof value === 'string' && (SHORTCUT_PRESETS as readonly string[]).includes(value)

/** Entries of all presets, "ladder" included: in the terminal ⌘K clears, so the palette needs ⌘⇧P. */
const BASE: Keybinding[] = [{ key: 'cmd+shift+p', command: 'palette.toggle' }]

/** What each preset adds to the defaults (several entries for the same command = several active shortcuts: ⌘K stays and ⌘⇧P is added). */
const VSCODE_LIKE: Keybinding[] = [
  ...BASE,
  { key: 'ctrl+tab', command: 'tab.next' },
  { key: 'ctrl+shift+tab', command: 'tab.previous' },
  { key: 'cmd+shift+t', command: 'tab.reopenClosed' },
  { key: 'cmd+shift+f', command: 'search.project' }
]

export const PRESET_BINDINGS: Record<ShortcutPreset, readonly Keybinding[]> = {
  ladder: BASE,
  vscode: VSCODE_LIKE,
  // Currently identical to vscode: the names stay distinct so they can diverge.
  cursor: VSCODE_LIKE
}

/** ⌘ keys that the terminal keeps for itself (copy, paste, select all); the other ⌘ keys stay with the app. */
export const TERMINAL_NATIVE_KEYS: readonly string[] = ['c', 'v', 'a']

// ---------------------------------------------------------------------------------------------------------------------
// Syntax

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

/** Alternative key names (VS Code writes "backquote", "oem_5" and the like) mapped to the canonical form. */
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

/** Named keys: value of event.key (lowercase) and of event.code. */
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

/** Keys also recognized by physical position: they sit in different places on different keyboards. */
const PHYSICAL = new Set(['`', '\\'])

/** Physical key (event.code) of a canonical key, if it is known. */
function codeOf(key: string): string | undefined {
  if (NAMED[key]) return NAMED[key].code
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (/^f([1-9]|1[0-2])$/.test(key)) return key.toUpperCase()
  return PUNCTUATION_CODES[key]
}

/** Parses "cmd+shift+p". null if it is not a valid shortcut (multi-chord sequences, "cmd+k cmd+s", are not supported). */
export function parseShortcut(shortcut: string): Chord | null {
  const text = shortcut.trim().toLowerCase()
  if (!text || /\s/.test(text)) return null
  // The key can be "+" itself ("cmd++").
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
    // The last non-modifier element is the key, only one.
    if (plusKey || index !== parts.length - 1 || chord.key) return null
    chord.key = KEY_ALIASES[part] ?? part
  }
  if (!chord.key) return null
  const known = chord.key.length === 1 || NAMED[chord.key] || /^f([1-9]|1[0-2])$/.test(chord.key)
  return known ? chord : null
}

/**
 * Without ⌃, ⌘ or ⌥ a shortcut would intercept typing: only function keys are allowed. It is the single rule, for the
 * settings screen and for reading keybindings.json (defaults, like ⇧Tab or Esc in the composer, don't go through here).
 */
export const hasAnchor = (chord: Chord): boolean => chord.ctrl || chord.meta || chord.alt || /^f\d+$/.test(chord.key)

/** The same shortcut in canonical form ("cmd+shift+p"): used to compare and to save. */
export function serializeShortcut(chord: Chord): string {
  return [chord.ctrl && 'ctrl', chord.alt && 'alt', chord.shift && 'shift', chord.meta && 'cmd', chord.key].filter(Boolean).join('+')
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching against an event

/**
 * True if the event is this shortcut. Modifiers are compared exactly, except those in `loose`.
 * With ⌥ the physical key counts (event.code, because ⌥ changes event.key); otherwise the character, and for ` and \ also the
 * physical position.
 */
export function matchesChord(event: KeyLike, chord: Chord, loose: readonly Modifier[] = []): boolean {
  const same = (modifier: Modifier, actual: boolean) => loose.includes(modifier) || actual === chord[modifier]
  if (!same('ctrl', event.ctrlKey) || !same('alt', event.altKey) || !same('shift', event.shiftKey) || !same('meta', event.metaKey)) return false
  const code = codeOf(chord.key)
  if (chord.alt) return code !== undefined && event.code === code
  // ⌃` counts only for the physical key, as before: the ` character on other keyboards requires ⌥ or other keys.
  if (chord.key === '`') return event.code === code
  const key = NAMED[chord.key]?.key ?? chord.key
  if (event.key.toLowerCase() === key) return true
  return PHYSICAL.has(chord.key) && event.code === code
}

// ---------------------------------------------------------------------------------------------------------------------
// Shortcuts in use (defaults + custom)

/** An entry of keybindings.json, as in VS Code. A `command` starting with "-" removes the default shortcut. */
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
 * Sets the custom shortcuts (keybindings.json). For a command the last valid entry wins and replaces
 * default and preset; `-command` removes them all.
 */
export function setKeybindingOverrides(list: Keybinding[]): void {
  overrides = list
  cache = null
}

export function setShortcutPreset(next: ShortcutPreset): void {
  preset = next
  cache = null
}

/** Applies presets and customizations together: used by renderer and main with the same state saved by the host. */
export function applyShortcutConfig(config: { preset: ShortcutPreset; overrides: Keybinding[] }): void {
  preset = config.preset
  overrides = config.overrides
  cache = null
}

export const isCommandId = (value: unknown): value is CommandId => typeof value === 'string' && Object.hasOwn(COMMANDS, value)

/** True if the user has assigned `key` to a command other than `id` (its last valid entry per command applies). */
function takenByUser(key: string, id: CommandId): boolean {
  const last = new Map<string, string>()
  for (const entry of overrides) {
    if (entry.command.startsWith('-') || entry.command === id) continue
    const chord = parseShortcut(entry.key)
    if (chord) last.set(entry.command, serializeShortcut(chord))
  }
  for (const value of last.values()) if (value === key) return true
  return false
}

function resolve(id: CommandId): Binding[] {
  const { contexts, loose = [] } = COMMANDS[id]
  let removed = false
  let user: Chord | null = null
  for (const entry of overrides) {
    if (entry.command === `-${id}`) removed = true
    else if (entry.command === id) {
      const chord = parseShortcut(entry.key)
      // An invalid entry is ignored, as VS Code does.
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
  // Preset entries are added to the defaults (aliases), without duplicates.
  for (const entry of PRESET_BINDINGS[preset]) {
    const chord = entry.command === id ? parseShortcut(entry.key) : null
    if (!chord) continue
    const key = serializeShortcut(chord)
    if (list.some((b) => serializeShortcut(b.chord) === key)) continue
    // A combination the user gave to another command stays theirs: the alias doesn't take it away.
    if (takenByUser(key, id)) continue
    list.push({ id, chord, loose: [], contexts, source: 'preset' })
  }
  return list
}

/** All shortcuts in use for a command (the first is the main one); empty if it has none. */
export function bindingsOf(id: CommandId): Binding[] {
  cache ??= new Map()
  let list = cache.get(id)
  if (!list) cache.set(id, (list = resolve(id)))
  return list
}

/** The main shortcut in use for a command, or null if it has none. */
export function bindingOf(id: CommandId): Binding | null {
  return bindingsOf(id)[0] ?? null
}

const IDS = Object.keys(COMMANDS) as CommandId[]

/** The shortcuts in use that are valid in a context, in registry order. */
export function bindingsIn(context: ShortcutContext): Binding[] {
  return IDS.flatMap(bindingsOf).filter((binding) => binding.contexts.includes(context))
}

/** The command the event triggers in a context. Exact shortcuts first, then those that ignore some modifiers. */
export function findBinding(event: KeyLike, context: ShortcutContext): Binding | null {
  const list = bindingsIn(context)
  return list.find((b) => b.loose.length === 0 && matchesChord(event, b.chord)) ?? list.find((b) => b.loose.length > 0 && matchesChord(event, b.chord, b.loose)) ?? null
}

/** True if the event triggers exactly this command. */
export function matchesCommand(event: KeyLike, id: CommandId): boolean {
  return bindingsOf(id).some((binding) => matchesChord(event, binding.chord, binding.loose))
}

// ---------------------------------------------------------------------------------------------------------------------
// Output formats

const DISPLAY_KEYS: Record<string, string> = { left: '←', right: '→', up: '↑', down: '↓', enter: '↵', escape: 'esc', tab: '⇥', backspace: '⌫', delete: 'Del', space: 'Space' }

/** "cmd+shift+p" becomes ⌘⇧P, as read in the interface (order ⌃ ⌘ ⌥ ⇧). Empty if the shortcut is not valid. */
/**
 * Keyboard characters in use per physical key (event.code → character), from the renderer (navigator.keyboard.getLayoutMap).
 * They serve the labels of keys recognized by position: on an Italian keyboard the ⌃` key prints "\".
 */
let layoutKeys: ReadonlyMap<string, string> | null = null

export function setKeyboardLayout(map: ReadonlyMap<string, string> | null): void {
  layoutKeys = map
}

/** The character the chord's physical key prints with the keyboard in use, if the chord is recognized by position (` and combinations with ⌥). */
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

/** How the interface shows a command's shortcut; empty string if it has none. */
export function shortcutLabel(id: CommandId): string {
  const binding = bindingOf(id)
  return binding ? formatShortcut(binding.chord) : ''
}

const ACCELERATOR_KEYS: Record<string, string> = { left: 'Left', right: 'Right', up: 'Up', down: 'Down', enter: 'Enter', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', space: 'Space', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' }

/** All of a command's shortcuts as the interface shows them (aliases included). */
export function shortcutLabels(id: CommandId): string[] {
  return bindingsOf(id).map((binding) => formatShortcut(binding.chord))
}

/** ASCII punctuation keys that Electron accepts as an accelerator ("+" has a separate name: "Plus"). */
const ACCELERATOR_PUNCTUATION = new Set("`~!@#$%^&*()_-=[]{}\\|;:'\",<.>/?")

/** The key as an Electron accelerator writes it; undefined if it can't be expressed (for example "ò": Electron accepts only ASCII). */
function acceleratorKey(key: string): string | undefined {
  if (ACCELERATOR_KEYS[key]) return ACCELERATOR_KEYS[key]
  if (key === '+') return 'Plus'
  if (/^[a-z0-9]$/.test(key)) return key.toUpperCase()
  if (/^f([1-9]|1[0-2])$/.test(key)) return key.toUpperCase()
  return ACCELERATOR_PUNCTUATION.has(key) ? key : undefined
}

/**
 * Electron accelerator for the menu ("cmd+shift+w" becomes "CmdOrCtrl+Shift+W"). undefined if the command has no
 * shortcut or the key can't be expressed: the menu item stays without an accelerator and the renderer handles the shortcut.
 */
export function acceleratorOf(id: CommandId): string | undefined {
  const chord = bindingOf(id)?.chord
  if (!chord) return undefined
  const key = acceleratorKey(chord.key)
  if (!key) return undefined
  return [chord.meta && 'CmdOrCtrl', chord.ctrl && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', key].filter(Boolean).join('+')
}

const CODEMIRROR_KEYS: Record<string, string> = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', enter: 'Enter', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', space: 'Space', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' }

/** Key for the CodeMirror keymap ("cmd+s" becomes "Mod-s"). undefined if the command has no shortcut. */
export function codeMirrorKeyOf(id: CommandId): string | undefined {
  const chord = bindingOf(id)?.chord
  if (!chord) return undefined
  return [chord.ctrl && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', chord.meta && 'Mod', CODEMIRROR_KEYS[chord.key] ?? chord.key].filter(Boolean).join('-')
}
