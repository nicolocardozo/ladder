// Selettore del composer: file e terminali per le citazioni con @, comandi per la / a inizio messaggio.
// Non prende mai il focus: la tastiera resta nella textarea, che punta all'opzione attiva con aria-activedescendant.
import { useEffect, type CSSProperties } from 'react'
import { File, SquareTerminal } from 'lucide-react'
import { plural, t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import type { FileEntry } from './file-index'
import { commandDescription, type CommandEntry } from './slash-commands'

/**
 * Opzione del selettore: un file del progetto, un terminale (@terminal ne allega l'output) o un comando /.
 * `disabled` è il motivo per cui il comando non si può eseguire adesso (per esempio la sessione lavora).
 */
export type PickerOption =
  | { kind: 'file'; entry: FileEntry }
  | { kind: 'terminal'; id: string; title: string; detail: string }
  | { kind: 'command'; entry: CommandEntry; disabled: string | null }

/** Etichetta di origine, con le chiavi t() letterali. */
const sourceTag = (source: CommandEntry['source']): string | null => (source === 'custom' ? t('custom') : source === 'skill' ? t('skill') : null)

interface MentionPickerProps {
  id: string
  /** @ per file e terminali, / per i comandi. */
  mode?: 'mention' | 'command'
  results: PickerOption[]
  active: number
  loading: boolean
  error: string | null
  hasProject: boolean
  query: string
  style: CSSProperties
  onHover: (index: number) => void
  onChoose: (option: PickerOption) => void
}

export const optionId = (listId: string, index: number) => `${listId}-opt-${index}`

export function MentionPicker({ id, mode = 'mention', results, active, loading, error, hasProject, query, style, onHover, onChoose }: MentionPickerProps) {
  const commands = mode === 'command'
  // L'opzione attiva resta visibile quando l'elenco scorre (molte skill).
  useEffect(() => {
    document.getElementById(optionId(id, active))?.scrollIntoView({ block: 'nearest' })
  }, [id, active])

  let empty: string | null = null
  if (commands) empty = results.length === 0 ? t('No command matches “/{query}”. Enter sends it as a message.', { query }) : null
  else if (!hasProject) empty = t('No project: there are no files to mention.')
  else if (error) empty = t('Unable to read the project files: {error}', { error })
  else if (results.length === 0)
    empty = loading ? t('Loading project files…') : query ? t('No files match “{query}”.', { query }) : t('The project has no files.')

  return (
    <div
      style={style}
      // Il clic su un'opzione non deve togliere il focus alla textarea.
      onMouseDown={(event) => event.preventDefault()}
      className="absolute z-50 overflow-hidden rounded-xl border border-input bg-popover text-popover-foreground shadow-[0_12px_32px_rgb(3_8_20/0.18)] dark:shadow-[0_12px_32px_rgb(0_0_0/0.45)]"
    >
      <p className="sr-only" aria-live="polite">
        {empty ?? (commands ? plural(results.length, '{n} command', '{n} commands') : plural(results.length, '{n} file', '{n} files'))}
      </p>
      {empty ? (
        <p className={cn('px-3 py-2.5 text-sm', error ? 'text-destructive' : 'text-muted-foreground')}>{empty}</p>
      ) : (
        <div
          id={id}
          role="listbox"
          aria-label={commands ? t('Commands') : t('Project files and terminals')}
          className="flex max-h-72 flex-col overflow-y-auto p-1"
        >
          {results.map((option, index) =>
            option.kind === 'command' ? (
              <div
                key={`c:${option.entry.name}`}
                id={optionId(id, index)}
                role="option"
                aria-selected={index === active}
                aria-disabled={option.disabled ? true : undefined}
                title={option.disabled ?? undefined}
                onMouseMove={() => index !== active && onHover(index)}
                onClick={() => onChoose(option)}
                className="flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-md px-2 text-sm aria-selected:bg-accent dark:aria-selected:bg-input/70"
              >
                <span className={cn('shrink-0 font-semibold text-foreground', option.disabled && 'text-muted-foreground')}>/{option.entry.name}</span>
                {option.entry.hint && <span className="shrink-0 font-mono text-xs text-faint">{option.entry.source === 'ladder' ? t(option.entry.hint) : option.entry.hint}</span>}
                <span className="min-w-0 truncate text-muted-foreground">
                  {commandDescription(option.entry)}
                </span>
                {option.disabled ? (
                  <span className="ml-auto shrink-0 pl-2 text-xs text-faint">{t('Not while working')}</span>
                ) : sourceTag(option.entry.source) ? (
                  <span className="ml-auto shrink-0 pl-2 text-xs text-faint">{sourceTag(option.entry.source)}</span>
                ) : null}
              </div>
            ) : option.kind === 'terminal' ? (
              <div
                key={`t:${option.id}`}
                id={optionId(id, index)}
                role="option"
                aria-selected={index === active}
                title={t('Attach the output of “{title}”', { title: option.title })}
                onMouseMove={() => index !== active && onHover(index)}
                onClick={() => onChoose(option)}
                className="flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-md px-2 text-sm aria-selected:bg-accent dark:aria-selected:bg-input/70"
              >
                <SquareTerminal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
                <span className="shrink-0 font-semibold text-foreground">@terminal</span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {option.title} · {option.detail}
                </span>
              </div>
            ) : (
              <div
                key={option.entry.path}
                id={optionId(id, index)}
                role="option"
                aria-selected={index === active}
                title={option.entry.path}
                onMouseMove={() => index !== active && onHover(index)}
                onClick={() => onChoose(option)}
                className="flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-md px-2 text-sm aria-selected:bg-accent dark:aria-selected:bg-input/70"
              >
                <File aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
                <span className="shrink-0 font-semibold text-foreground">{option.entry.base}</span>
                {option.entry.dir && (
                  // Le cartelle lunghe si tagliano a sinistra: conta la parte vicina al file.
                  <span className="min-w-0 truncate text-left text-muted-foreground [direction:rtl]">{`‎${option.entry.dir}‎`}</span>
                )}
              </div>
            )
          )}
        </div>
      )}
      <p className="border-t border-border px-3 py-1.5 font-mono text-xs text-faint dark:border-input/60">
        {commands ? t('↑↓ choose · ↵ run · Tab complete · Esc close') : t('↑↓ choose · ↵ or Tab insert · Esc close')}
      </p>
    </div>
  )
}
