// Scorciatoie: keybindings.json nella cartella dati (formato di VS Code, modificabile a mano) e preset scelto, salvato in kv.
// Le voci non valide si ignorano e si segnalano, ma restano nel file; il file con errore di sintassi non si sovrascrive.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { t } from '@shared/i18n'
import type { HostToMain, ShortcutsState } from '@shared/protocol'
import { DEFAULT_SHORTCUT_PRESET, hasAnchor, isCommandId, isShortcutPreset, parseShortcut, type Keybinding, type ShortcutPreset } from '@shared/shortcuts'
import type { Db } from './db'

const KEY = 'shortcut-preset'
const DEBOUNCE_MS = 250

/** Toglie commenti (// e /* *\/) e virgole finali, lasciando intatte le stringhe: le posizioni degli errori restano quelle del file. */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') out += ' ', i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else {
      out += c
      i++
    }
  }
  // Virgola prima di ] o } (anche con spazi in mezzo): fuori dalle stringhe.
  let result = ''
  let inString = false
  for (let k = 0; k < out.length; k++) {
    const c = out[k]
    if (inString) {
      result += c
      if (c === '\\') result += out[++k] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      result += c
    } else if (c === ',' && /^\s*[\]}]/.test(out.slice(k + 1))) result += ' '
    else result += c
  }
  return result
}

interface Parsed {
  /** Voci valide, nell'ordine del file. */
  valid: Keybinding[]
  /** Voci scartate così come stanno nel file: si rimettono in fondo al salvataggio. */
  skipped: unknown[]
  warnings: string[]
}

/** Problema di una voce, o null se è valida. `-comando` toglie il predefinito: la scorciatoia non serve. */
function problemOf(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return t('not an object with "key" and "command"')
  const { key, command } = entry as Record<string, unknown>
  if (typeof command !== 'string' || typeof key !== 'string') return t('"key" and "command" must be strings')
  const id = command.startsWith('-') ? command.slice(1) : command
  if (!isCommandId(id)) return t('unknown command “{command}”', { command })
  if (!command.startsWith('-')) {
    const chord = parseShortcut(key)
    if (!chord) return t('invalid shortcut “{key}”', { key })
    // Stessa regola della schermata delle impostazioni: senza ⌘, ⌃ o ⌥ (o un tasto funzione) intercetterebbe la scrittura.
    if (!hasAnchor(chord)) return t('shortcut “{key}” needs ⌘, ⌃ or ⌥', { key })
  }
  return null
}

function parseEntries(list: unknown[]): Parsed {
  const parsed: Parsed = { valid: [], skipped: [], warnings: [] }
  for (const [index, entry] of list.entries()) {
    const problem = problemOf(entry)
    if (problem) {
      parsed.skipped.push(entry)
      parsed.warnings.push(t('Entry #{n} ignored: {problem}', { n: index + 1, problem }))
    } else parsed.valid.push({ key: (entry as Keybinding).key, command: (entry as Keybinding).command })
  }
  return parsed
}

export class Shortcuts {
  private preset: ShortcutPreset
  private parsed: Parsed = { valid: [], skipped: [], warnings: [] }
  /** Messaggio di sintassi se il file non si legge; le voci restano quelle dell'ultima lettura buona. */
  private syntaxError: string | null = null
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private last = ''

  constructor(
    private readonly db: Db,
    private readonly file: string,
    private readonly publish: (state: ShortcutsState) => void,
    private readonly toMain: (message: HostToMain) => void
  ) {
    const row = db.prepare('select value from kv where key = ?').get(KEY) as { value: string } | undefined
    this.preset = isShortcutPreset(row?.value) ? row.value : DEFAULT_SHORTCUT_PRESET
    this.load()
  }

  /** Avvio: dice al main cosa usare per il menu e osserva il file. */
  start(): void {
    this.last = JSON.stringify(this.state())
    this.toMain({ type: 'shortcuts', preset: this.preset, overrides: this.parsed.valid })
    try {
      // Si osserva la cartella: un salvataggio atomico (rename) sostituisce il file e un watcher sul file si perderebbe.
      mkdirSync(dirname(this.file), { recursive: true })
      const name = basename(this.file)
      this.watcher = watch(dirname(this.file), (_event, changed) => {
        if (changed && changed !== name) return
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => this.refresh(), DEBOUNCE_MS)
      })
      this.watcher.on('error', () => undefined)
    } catch {
      // Senza osservatore resta la rilettura a ogni shortcuts.get.
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.watcher?.close()
  }

  state(): ShortcutsState {
    const warnings = this.syntaxError ? [this.syntaxError, ...this.parsed.warnings] : this.parsed.warnings
    return { preset: this.preset, overrides: this.parsed.valid, warnings, file: this.file, invalid: this.syntaxError !== null }
  }

  /** Rilegge il file e avvisa solo se lo stato è davvero cambiato (così i salvataggi nostri non fanno doppi eventi). */
  get(): ShortcutsState {
    this.load()
    return this.state()
  }

  refresh(): void {
    this.load()
    this.emitIfChanged()
  }

  save(preset: ShortcutPreset, overrides: Keybinding[]): ShortcutsState {
    if (!isShortcutPreset(preset)) throw new Error(t('Unknown shortcut preset.'))
    this.load()
    if (this.syntaxError) throw new Error(t('keybindings.json has a syntax error. Fix it or restore the defaults first.'))
    if (!Array.isArray(overrides)) throw new Error(t('Invalid shortcuts.'))
    for (const entry of overrides) {
      const problem = problemOf(entry)
      if (problem) throw new Error(t('Invalid shortcut: {problem}', { problem }))
    }
    // Le voci che non capiamo restano nel file, davanti a quelle nuove.
    const entries = [...this.parsed.skipped, ...overrides.map(({ key, command }) => ({ key, command }))]
    this.write(`${JSON.stringify(entries, null, 2)}\n`)
    this.setPreset(preset)
    this.load()
    this.emitIfChanged()
    return this.state()
  }

  reset(): ShortcutsState {
    // Il contenuto di prima non si butta: va in keybindings.json.bak.
    if (existsSync(this.file)) {
      try {
        if (this.rawText().trim().replace(/\s/g, '') !== '[]') copyFileSync(this.file, `${this.file}.bak`)
      } catch {
        throw new Error(t('Could not back up keybindings.json.'))
      }
    }
    this.write('[]\n')
    this.load()
    this.emitIfChanged()
    return this.state()
  }

  /** Crea il file vuoto se manca e chiede al main di aprirlo. */
  openFile(): null {
    if (!existsSync(this.file)) this.write('[]\n')
    this.toMain({ type: 'open-keybindings' })
    return null
  }

  private setPreset(preset: ShortcutPreset): void {
    this.preset = preset
    this.db.prepare('insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(KEY, preset)
  }

  private rawText(): string {
    return readFileSync(this.file, 'utf8')
  }

  /** Legge il file. File assente = nessuna personalizzazione; errore di sintassi = si tiene l'ultimo stato buono. */
  private load(): void {
    let text: string
    try {
      text = this.rawText()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.parsed = { valid: [], skipped: [], warnings: [] }
        this.syntaxError = null
      } else this.syntaxError = t('Could not read keybindings.json: {message}', { message: (error as Error).message })
      return
    }
    // Un file vuoto (appena creato a mano) conta come nessuna voce.
    if (!text.trim()) {
      this.parsed = { valid: [], skipped: [], warnings: [] }
      this.syntaxError = null
      return
    }
    let data: unknown
    try {
      data = JSON.parse(stripJsonc(text))
    } catch (error) {
      this.syntaxError = t('keybindings.json is not valid JSON: {message}', { message: (error as Error).message })
      return
    }
    if (!Array.isArray(data)) {
      this.syntaxError = t('keybindings.json must contain an array of entries.')
      return
    }
    this.syntaxError = null
    this.parsed = parseEntries(data)
  }

  private emitIfChanged(): void {
    const state = this.state()
    const json = JSON.stringify(state)
    if (json === this.last) return
    this.last = json
    this.publish(state)
    this.toMain({ type: 'shortcuts', preset: state.preset, overrides: state.overrides })
  }

  /** Scrittura atomica: file temporaneo nella stessa cartella e rename. */
  private write(text: string): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, this.file)
  }
}
