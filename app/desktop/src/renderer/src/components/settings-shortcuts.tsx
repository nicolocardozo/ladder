// Impostazioni → Shortcuts: elenco dei comandi con la loro scorciatoia, come in VS Code e Cursor.
// Si cerca per nome o per tasto, si registra una nuova combinazione premendola, si risolvono i conflitti e si sceglie il preset.
// Le personalizzazioni stanno in keybindings.json (l'host le scrive e le rilegge); qui si calcola solo la nuova lista di voci.
import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, FileJson, RotateCcw, Search, X } from 'lucide-react'
import type { ShortcutsState } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import {
  bindingsOf,
  COMMANDS,
  formatShortcut,
  hasAnchor,
  matchesChord,
  parseShortcut,
  PRESET_BINDINGS,
  serializeShortcut,
  type Binding,
  type Chord,
  type CommandId,
  type Keybinding,
  type ShortcutContext,
  type ShortcutPreset
} from '@shared/shortcuts'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { request } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

// ---------------------------------------------------------------------------------------------------------------------
// Nomi dei comandi

const PROJECT_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `project.select${n}` as CommandId)

/** Nome inglese di ogni comando (si traduce con t al momento di mostrarlo). Il Record obbliga a nominarli tutti. */
const LABELS: Record<CommandId, string> = {
  'palette.toggle': 'Search Ladder',
  'quickOpen.toggle': 'Open file…',
  'search.project': 'Search in project',
  'sidebar.toggle': 'Show or hide sidebar',
  'nav.back': 'Back',
  'nav.forward': 'Forward',
  'chat.new': 'New chat',
  'chat.newFrom': 'New session from issue, PR or branch…',
  'chat.split': 'Open side by side',
  'project.select1': 'Go to project {n}',
  'project.select2': 'Go to project {n}',
  'project.select3': 'Go to project {n}',
  'project.select4': 'Go to project {n}',
  'project.select5': 'Go to project {n}',
  'project.select6': 'Go to project {n}',
  'project.select7': 'Go to project {n}',
  'project.select8': 'Go to project {n}',
  'project.select9': 'Go to project {n}',
  'column.focusLeft': 'Focus the column on the left',
  'column.focusRight': 'Focus the column on the right',
  'tab.next': 'Next tab',
  'tab.previous': 'Previous tab',
  'tab.reopenClosed': 'Reopen closed tab',
  'tab.moveLeft': 'Move tab left',
  'tab.moveRight': 'Move tab right',
  'tab.close': 'Close tab',
  'session.nextWaiting': 'Go to next session waiting for you',
  'session.interrupt': 'Stop the running session',
  'inspector.changes': 'Show changes',
  'inspector.files': 'Show files',
  'inspector.history': 'History and checkpoints',
  'inspector.merge': 'Branches',
  'inspector.toggle': 'Show or hide the right panel',
  'terminal.toggle': 'Show or hide terminal',
  'terminal.clear': 'Clear terminal',
  'file.save': 'Save file',
  'composer.cyclePermission': 'Change permission level',
  'composer.stop': 'Stop the reply from the message box',
  'app.openSettings': 'Open Settings',
  'window.close': 'Close window'
}

function commandName(id: CommandId): string {
  const n = PROJECT_IDS.indexOf(id) + 1
  return t(LABELS[id], { n })
}

const GROUPS: { title: string; ids: CommandId[] }[] = [
  { title: 'Navigation', ids: ['palette.toggle', 'quickOpen.toggle', 'search.project', 'sidebar.toggle', 'nav.back', 'nav.forward', ...PROJECT_IDS] },
  {
    title: 'Sessions and tabs',
    ids: ['chat.new', 'chat.newFrom', 'chat.split', 'column.focusLeft', 'column.focusRight', 'tab.next', 'tab.previous', 'tab.reopenClosed', 'tab.moveLeft', 'tab.moveRight', 'tab.close', 'session.nextWaiting', 'session.interrupt']
  },
  { title: 'Panels', ids: ['inspector.changes', 'inspector.files', 'inspector.history', 'inspector.merge', 'inspector.toggle', 'terminal.toggle', 'terminal.clear'] },
  { title: 'Editor and message box', ids: ['file.save', 'composer.cyclePermission', 'composer.stop'] },
  { title: 'App', ids: ['app.openSettings', 'window.close'] }
]

const PRESET_NAMES: Record<ShortcutPreset, string> = { vscode: 'VS Code', cursor: 'Cursor', ladder: 'Ladder' }
const PRESET_ORDER: ShortcutPreset[] = ['vscode', 'cursor', 'ladder']

// ---------------------------------------------------------------------------------------------------------------------
// Voci di keybindings.json

/** Le voci senza quelle del comando (la scorciatoia propria e l'eventuale "-comando"). */
const withoutCommand = (list: Keybinding[], id: CommandId): Keybinding[] => list.filter((entry) => entry.command !== id && entry.command !== `-${id}`)

/** Il comando passa a una sola scorciatoia: la nuova voce sostituisce predefinita e preset. */
const assign = (list: Keybinding[], id: CommandId, key: string): Keybinding[] => [...withoutCommand(list, id), { key, command: id }]

/** Toglie la scorciatoia al comando: "-comando" cancella quelle predefinite. */
const unassign = (list: Keybinding[], id: CommandId, key: string): Keybinding[] => [...withoutCommand(list, id), { key, command: `-${id}` }]

const isCustomized = (list: Keybinding[], id: CommandId) => list.some((entry) => entry.command === id || entry.command === `-${id}`)

const keyOf = (binding: Binding) => serializeShortcut(binding.chord)

/** Vero se due contesti si pestano i piedi: il globale e il menu valgono ovunque, gli altri solo in sé stessi. */
function overlaps(a: readonly ShortcutContext[], b: readonly ShortcutContext[]): boolean {
  const everywhere = (context: ShortcutContext) => context === 'global' || context === 'menu'
  // Un comando del terminale ha la precedenza su uno globale sullo stesso tasto (⌘K pulisce lì, apre la palette altrove): non è un doppione.
  // Non vale per il menu: gli acceleratori li prende il main prima del renderer, quindi lì il conflitto è vero.
  const terminalVsGlobal = (x: ShortcutContext, y: ShortcutContext) => (x === 'terminal' && y === 'global') || (x === 'global' && y === 'terminal')
  return a.some((x) => b.some((y) => x === y || ((everywhere(x) || everywhere(y)) && !terminalVsGlobal(x, y))))
}

/** Gli altri comandi che usano già questa combinazione in un contesto in comune. */
function conflictsOf(id: CommandId, key: string): CommandId[] {
  return (Object.keys(COMMANDS) as CommandId[]).filter(
    (other) => other !== id && overlaps(COMMANDS[id].contexts, COMMANDS[other].contexts) && bindingsOf(other).some((binding) => keyOf(binding) === key)
  )
}

/** Toglie a `other` la combinazione `key`; se ne ha altre (alias del preset) ne resta una, altrimenti non ne ha più. */
function takeAway(list: Keybinding[], other: CommandId, key: string): Keybinding[] {
  const rest = bindingsOf(other).filter((binding) => keyOf(binding) !== key)
  return rest.length > 0 ? assign(list, other, keyOf(rest[0])) : unassign(list, other, key)
}

// ---------------------------------------------------------------------------------------------------------------------
// Registrazione dei tasti

const CODE_KEYS: Record<string, string> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  Space: 'space',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Minus: '-',
  Equal: '='
}

/** Tasto canonico dal tasto fisico (event.code): serve con ⌥, dove event.key cambia carattere. */
function keyFromCode(code: string): string | null {
  if (CODE_KEYS[code]) return CODE_KEYS[code]
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].toLowerCase()
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]
  return /^F([1-9]|1[0-2])$/.test(code) ? code.toLowerCase() : null
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn'])

/** ⌃⌘⌥⇧ dei modificatori premuti, nell'ordine in cui l'interfaccia li mostra. */
const heldModifiers = (e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }) => `${e.ctrlKey ? '⌃' : ''}${e.metaKey ? '⌘' : ''}${e.altKey ? '⌥' : ''}${e.shiftKey ? '⇧' : ''}`

/**
 * La combinazione premuta come la capirebbe l'ascoltatore globale. Si prova prima il tasto fisico, poi il carattere, e
 * si tiene il primo che `matchesChord` riconosce davvero con quell'evento: una scorciatoia che poi non scatta non si salva.
 */
function chordFromEvent(event: KeyboardEvent): Chord | null {
  const candidates = [keyFromCode(event.code), event.key.length > 1 ? event.key.toLowerCase() : event.key === ' ' ? 'space' : event.key.toLowerCase()]
  for (const key of candidates) {
    if (!key) continue
    const chord = parseShortcut(serializeShortcut({ ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, key }))
    if (chord && matchesChord(event, chord)) return chord
  }
  return null
}

/** Campo che cattura la combinazione premuta. Esc annulla, perdere il focus annulla. */
function Recorder({ name, onCapture, onCancel }: { name: string; onCapture: (key: string) => void; onCancel: (restoreFocus: boolean) => void }) {
  const [held, setHeld] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const field = useRef<HTMLButtonElement>(null)
  useEffect(() => field.current?.focus(), [])

  return (
    <button
      ref={field}
      type="button"
      aria-label={t('Press the new shortcut for {command}. Esc cancels.', { command: name })}
      // Se il focus se ne va da solo (un clic altrove) non lo si richiama indietro.
      onBlur={() => onCancel(false)}
      onKeyUp={(e) => setHeld(heldModifiers(e))}
      onKeyDown={(e) => {
        // Niente di ciò che si preme deve arrivare all'app: né ⌘K né Esc (che chiuderebbe le impostazioni).
        e.preventDefault()
        e.stopPropagation()
        if (e.nativeEvent.isComposing) return
        if (MODIFIER_KEYS.has(e.key)) {
          setHeld(heldModifiers(e))
          setHint(null)
          return
        }
        if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
          onCancel(true)
          return
        }
        const chord = chordFromEvent(e.nativeEvent)
        if (!chord) setHint(t('That key can’t be used'))
        else if (!hasAnchor(chord)) setHint(t('Needs ⌘, ⌃ or ⌥'))
        else onCapture(serializeShortcut(chord))
      }}
      className="flex h-7 min-w-[148px] items-center justify-end gap-1.5 rounded-md border border-ring bg-background px-2 text-sm text-muted-foreground outline-none ring-2 ring-ring/50"
    >
      {held ? <Kbd className="text-foreground">{held}</Kbd> : <span>{hint ?? t('Press keys…')}</span>}
    </button>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Ricerca

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** Parole con cui si dice un tasto o un modificatore: "cmd", "command", "option"… Valgono solo come parola intera. */
function keyWordsOf(id: CommandId): Set<string> {
  const words = new Set<string>()
  for (const { chord } of bindingsOf(id)) {
    if (chord.meta) ['cmd', 'command'].forEach((w) => words.add(w))
    if (chord.ctrl) ['ctrl', 'control'].forEach((w) => words.add(w))
    if (chord.alt) ['alt', 'option', 'opt'].forEach((w) => words.add(w))
    if (chord.shift) words.add('shift')
    words.add(chord.key)
  }
  return words
}

/** Il comando risponde alla ricerca: ogni parola cercata sta nel nome (da due lettere), è un tasto o un modificatore intero, o è nel simbolo (⌘⇧P). */
function matchesQuery(id: CommandId, tokens: string[]): boolean {
  const name = normalize(`${commandName(id)} ${LABELS[id]} ${id}`)
  const symbols = bindingsOf(id).map((binding) => normalize(formatShortcut(binding.chord))).join(' ')
  const words = keyWordsOf(id)
  return tokens.every((token) => (token.length >= 2 && name.includes(token)) || words.has(token) || (/[⌘⌃⌥⇧]/.test(token) && symbols.includes(token)))
}

// ---------------------------------------------------------------------------------------------------------------------
// Sezione

const EMPTY_STATE: ShortcutsState = { preset: 'ladder', overrides: [], warnings: [], file: '', invalid: false }

const secondary = 'h-8 shrink-0 rounded-md border border-input px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50'
const small = 'h-7 rounded-md px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

interface Pending {
  id: CommandId
  key: string
  conflicts: CommandId[]
}

export function ShortcutsSection() {
  const state = useApp((s) => s.shortcuts) ?? EMPTY_STATE
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<CommandId | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [problem, setProblem] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const lastRecorded = useRef<CommandId | null>(null)

  // Il file può essere cambiato a mano mentre l'app era altrove: all'apertura si rilegge (l'evento lo applica).
  useEffect(() => {
    request<ShortcutsState>({ type: 'shortcuts.get' })
      .then((next) => useApp.getState().applyShortcuts(next))
      .catch(() => undefined)
  }, [])

  /** Manda un comando all'host e applica lo stato che risponde. */
  const run = async (command: Extract<Parameters<typeof request>[0], { type: 'shortcuts.save' | 'shortcuts.reset' | 'shortcuts.openFile' }>): Promise<boolean> => {
    setBusy(true)
    busyRef.current = true
    setProblem(null)
    try {
      const next = await request<ShortcutsState | null>(command)
      if (next) useApp.getState().applyShortcuts(next)
      return true
    } catch (error) {
      setProblem((error as Error).message)
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const save = (preset: ShortcutPreset, overrides: Keybinding[]) => run({ type: 'shortcuts.save', preset, overrides })

  const tokens = useMemo(() => normalize(query).split(/[\s+]+/).filter(Boolean), [query])
  // Lo stato è nelle dipendenze: cambiate le scorciatoie, il testo su cui si cerca si rifà.
  const groups = useMemo(() => {
    void state
    return GROUPS.map((group) => ({ ...group, ids: group.ids.filter((id) => matchesQuery(id, tokens)) })).filter((group) => group.ids.length > 0)
  }, [tokens, state])

  // Il focus torna sul tasto di modifica appena è di nuovo attivo: durante un salvataggio il tasto è disabilitato e
  // il dialogo, che rimette il focus su di sé quando smonta il registratore, lo terrebbe. Si riprova finché il salvataggio
  // è in corso (anche se l'host è lento) e per un secondo ancora dopo la sua fine.
  const refocusEdit = () => {
    let tries = 0
    const attempt = () => {
      const button = list.current?.querySelector<HTMLButtonElement>(`[data-shortcut-edit="${lastRecorded.current}"]`)
      if (button && !button.disabled) button.focus()
      else if (busyRef.current || ++tries < 60) requestAnimationFrame(attempt)
    }
    // Almeno due frame: il dialogo si riprende il focus dopo il primo.
    requestAnimationFrame(() => requestAnimationFrame(attempt))
  }

  const stopRecording = (restoreFocus = true) => {
    setRecording(null)
    // Il tasto che aveva aperto la registrazione era stato smontato: il focus va al suo nuovo tasto, appena ridisegnato.
    if (restoreFocus) refocusEdit()
  }

  const startRecording = (id: CommandId) => {
    lastRecorded.current = id
    setPending(null)
    setProblem(null)
    setRecording(id)
  }

  const capture = (id: CommandId, key: string) => {
    // Stessa combinazione di prima: niente da cambiare.
    if (bindingsOf(id).length === 1 && keyOf(bindingsOf(id)[0]) === key) return stopRecording()
    const conflicts = conflictsOf(id, key)
    // Con un conflitto il focus resta sulla scelta (Annulla): se tornasse al tasto di modifica, Esc chiuderebbe le impostazioni.
    stopRecording(conflicts.length === 0)
    if (conflicts.length > 0) setPending({ id, key, conflicts })
    else void save(state.preset, assign(state.overrides, id, key))
  }

  const replace = (choice: Pending) => {
    const next = choice.conflicts.reduce((list, other) => takeAway(list, other, choice.key), state.overrides)
    setPending(null)
    refocusEdit()
    void save(state.preset, assign(next, choice.id, choice.key))
  }

  const addressable = !state.invalid
  const customCount = new Set(state.overrides.map((entry) => entry.command.replace(/^-/, ''))).size
  // Il preset "ladder" ha già ⌘⇧P: l'elenco mostra solo ciò che il preset scelto aggiunge a quei predefiniti.
  const own = new Set(PRESET_BINDINGS.ladder.map((entry) => `${entry.command} ${entry.key}`))
  const added = PRESET_BINDINGS[state.preset].filter((entry) => !own.has(`${entry.command} ${entry.key}`)).map((entry) => formatShortcut(entry.key)).filter(Boolean)

  return (
    <>
      <DialogTitle className="text-xl font-semibold">{t('Shortcuts')}</DialogTitle>
      <DialogDescription className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
        {t('Start from the shortcuts of VS Code or Cursor and change any of them. Your changes are saved in keybindings.json, in the same format as VS Code.')}
      </DialogDescription>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[min(220px,100%)] flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                // Esc svuota la ricerca prima di chiudere le impostazioni.
                e.preventDefault()
                e.stopPropagation()
                setQuery('')
              }
            }}
            placeholder={t('Search by command or key…')}
            aria-label={t('Search shortcuts')}
            spellCheck={false}
            className="h-8 w-full rounded-md border border-input bg-background pr-2 pl-8 text-sm outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>
        <Select value={state.preset} disabled={busy || !addressable} onValueChange={(value) => void save(String(value) as ShortcutPreset, state.overrides)}>
          <SelectTrigger aria-label={t('Shortcut preset')} className="w-[148px] shrink-0">
            <SelectValue>{(value: string) => PRESET_NAMES[value as ShortcutPreset] ?? value}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PRESET_ORDER.map((preset) => (
              <SelectItem key={preset} value={preset}>
                {PRESET_NAMES[preset]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button type="button" disabled={busy} onClick={() => void run({ type: 'shortcuts.openFile' })} title={state.file || undefined} className={cn(secondary, 'flex items-center gap-1.5')}>
          <FileJson aria-hidden className="size-3.5" strokeWidth={1.75} />
          {t('Open keybindings.json')}
        </button>
        <button type="button" disabled={busy || confirmReset || (customCount === 0 && !state.invalid)} onClick={() => setConfirmReset(true)} className={secondary}>
          {t('Reset all')}
        </button>
      </div>
      <p className="mt-2 max-w-[62ch] text-xs text-muted-foreground">
        {state.preset === 'ladder'
          ? t('Only the shortcuts Ladder comes with.')
          : t('Adds the shortcuts of {editor} that Ladder doesn’t have: {list}. Your own changes stay on top.', { editor: PRESET_NAMES[state.preset], list: added.join(' ') })}
      </p>

      {confirmReset && (
        <div role="group" aria-label={t('Reset all')} className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-muted px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 text-muted-foreground">{t('Remove all your changes? The current file is kept as keybindings.json.bak.')}</span>
          <button
            type="button"
            autoFocus
            onClick={() => setConfirmReset(false)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              e.stopPropagation()
              setConfirmReset(false)
            }}
            className={cn(small, 'border border-input hover:bg-accent')}
          >
            {t('Cancel')}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmReset(false)
              void run({ type: 'shortcuts.reset' })
            }}
            className={cn(small, 'bg-primary font-medium text-primary-foreground hover:opacity-90')}
          >
            {t('Reset all')}
          </button>
        </div>
      )}

      {state.invalid ? (
        <div role="alert" className="mt-3 rounded-md border border-destructive/40 px-3 py-2.5 text-sm">
          <p className="font-medium text-destructive">{t('keybindings.json can’t be read')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('Ladder keeps the last shortcuts that worked and leaves the file as it is until you fix it or reset all.')}</p>
          <ul className="mt-1.5 max-h-28 overflow-y-auto font-mono text-xs text-destructive">
            {state.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : (
        state.warnings.length > 0 && (
          <div role="status" className="mt-3 rounded-md border border-border px-3 py-2.5 text-sm">
            <p className="flex items-center gap-1.5 font-medium">
              <CircleAlert aria-hidden className="size-3.5 shrink-0 text-attention" strokeWidth={2} />
              {plural(state.warnings.length, '{n} entry of keybindings.json is ignored', '{n} entries of keybindings.json are ignored')}
            </p>
            <ul className="mt-1 max-h-28 overflow-y-auto font-mono text-xs text-muted-foreground">
              {state.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">{t('Ignored entries stay in the file.')}</p>
          </div>
        )
      )}
      {problem && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {problem}
        </p>
      )}

      {/* Da 820 px i gruppi stanno su due colonne (ognuno intero, senza spezzarsi). */}
      <div ref={list} className="mt-5 flex flex-col gap-5 @[820px]:block @[820px]:columns-2 @[820px]:gap-x-10">
        {groups.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('No shortcuts match “{query}”.', { query })}
          </p>
        )}
        {groups.map((group) => (
          <section key={group.title} aria-label={t(group.title)} className="@[820px]:mb-5 @[820px]:break-inside-avoid">
            <h3 className="px-1 pb-1.5 text-xs font-semibold text-muted-foreground">{t(group.title)}</h3>
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {group.ids.map((id) => (
                <ShortcutRow
                  key={id}
                  id={id}
                  editable={addressable && !busy}
                  recording={recording === id}
                  pending={pending?.id === id ? pending : null}
                  customized={isCustomized(state.overrides, id)}
                  onRecord={() => startRecording(id)}
                  onCapture={(key) => capture(id, key)}
                  onCancelRecording={stopRecording}
                  onRemove={() => {
                    const binding = bindingsOf(id)[0]
                    if (binding) void save(state.preset, unassign(state.overrides, id, keyOf(binding)))
                  }}
                  onReset={() => void save(state.preset, withoutCommand(state.overrides, id))}
                  onReplace={replace}
                  onKeep={() => {
                    setPending(null)
                    refocusEdit()
                  }}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {state.file && <p className="mt-5 truncate font-mono text-xs text-faint" title={state.file}>{state.file}</p>}
    </>
  )
}

interface RowProps {
  id: CommandId
  editable: boolean
  recording: boolean
  pending: Pending | null
  customized: boolean
  onRecord: () => void
  onCapture: (key: string) => void
  onCancelRecording: (restoreFocus: boolean) => void
  onRemove: () => void
  onReset: () => void
  onReplace: (pending: Pending) => void
  onKeep: () => void
}

function ShortcutRow({ id, editable, recording, pending, customized, onRecord, onCapture, onCancelRecording, onRemove, onReset, onReplace, onKeep }: RowProps) {
  const name = commandName(id)
  const bindings = bindingsOf(id)
  const hide = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100'
  const icon = 'grid size-6 place-items-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40'
  return (
    <li className="group px-3 py-1.5 hover:bg-accent/30 focus-within:bg-accent/30">
      <div className="flex min-h-7 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        {recording ? (
          <Recorder name={name} onCapture={onCapture} onCancel={onCancelRecording} />
        ) : (
          <button
            type="button"
            disabled={!editable}
            data-shortcut-edit={id}
            aria-label={t('Change shortcut for {command}', { command: name })}
            onClick={onRecord}
            className="flex h-7 items-center gap-2 rounded-md px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none"
          >
            {bindings.length > 0 ? bindings.map((binding) => <Kbd key={keyOf(binding)}>{formatShortcut(binding.chord)}</Kbd>) : <span className="text-muted-foreground">{t('Add shortcut')}</span>}
          </button>
        )}
        <span className="flex w-[52px] shrink-0 justify-end gap-0.5">
          {bindings.length > 0 && (
            <button type="button" disabled={!editable} aria-label={t('Remove the shortcut of {command}', { command: name })} title={t('Remove shortcut')} onClick={onRemove} className={cn(icon, hide)}>
              <X aria-hidden className="size-3.5" />
            </button>
          )}
          {customized && (
            <button type="button" disabled={!editable} aria-label={t('Reset {command} to default', { command: name })} title={t('Reset to default')} onClick={onReset} className={icon}>
              <RotateCcw aria-hidden className="size-3.5" />
            </button>
          )}
        </span>
      </div>
      {pending && (
        <div
          role="group"
          aria-label={t('Shortcut conflict')}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            onKeep()
          }}
          className="mt-1.5 mb-1 flex flex-wrap items-center gap-3 rounded-md bg-muted px-3 py-2 text-xs"
        >
          <span className="min-w-0 flex-1 text-muted-foreground">
            {t('{shortcut} is already assigned to {commands}.', { shortcut: formatShortcut(pending.key), commands: pending.conflicts.map((other) => `“${commandName(other)}”`).join(', ') })}
          </span>
          <button type="button" autoFocus onClick={onKeep} className={cn(small, 'border border-input hover:bg-accent')}>
            {t('Cancel')}
          </button>
          <button type="button" onClick={() => onReplace(pending)} className={cn(small, 'bg-primary font-medium text-primary-foreground hover:opacity-90')}>
            {t('Replace')}
          </button>
        </div>
      )}
    </li>
  )
}
