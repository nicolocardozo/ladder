// Selettore dei file per le citazioni con @. Non prende mai il focus: la tastiera resta nella textarea,
// che punta all'opzione attiva con aria-activedescendant.
import type { CSSProperties } from 'react'
import { File, SquareTerminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FileEntry } from './file-index'

/** Opzione del selettore: un file del progetto o un terminale (@terminal ne allega l'output). */
export type MentionOption = { kind: 'file'; entry: FileEntry } | { kind: 'terminal'; id: string; title: string; detail: string }

interface MentionPickerProps {
  id: string
  results: MentionOption[]
  active: number
  loading: boolean
  error: string | null
  hasProject: boolean
  query: string
  style: CSSProperties
  onHover: (index: number) => void
  onChoose: (option: MentionOption) => void
}

export const optionId = (listId: string, index: number) => `${listId}-opt-${index}`

export function MentionPicker({ id, results, active, loading, error, hasProject, query, style, onHover, onChoose }: MentionPickerProps) {
  let empty: string | null = null
  if (!hasProject) empty = 'Nessun progetto: non ci sono file da citare.'
  else if (error) empty = `Non riesco a leggere i file del progetto: ${error}`
  else if (results.length === 0) empty = loading ? 'Carico i file del progetto…' : query ? `Nessun file corrisponde a “${query}”.` : 'Il progetto non ha file.'

  return (
    <div
      style={style}
      // Il clic su un'opzione non deve togliere il focus alla textarea.
      onMouseDown={(event) => event.preventDefault()}
      className="absolute z-50 overflow-hidden rounded-xl border border-input bg-popover text-popover-foreground shadow-[0_12px_32px_rgb(3_8_20/0.18)] dark:shadow-[0_12px_32px_rgb(0_0_0/0.45)]"
    >
      <p className="sr-only" aria-live="polite">
        {empty ?? (results.length === 1 ? '1 file' : `${results.length} file`)}
      </p>
      {empty ? (
        <p className={cn('px-3 py-2.5 text-[12.5px]', error ? 'text-destructive' : 'text-muted-foreground')}>{empty}</p>
      ) : (
        <div id={id} role="listbox" aria-label="File e terminali del progetto" className="flex flex-col p-1">
          {results.map((option, index) =>
            option.kind === 'terminal' ? (
              <div
                key={`t:${option.id}`}
                id={optionId(id, index)}
                role="option"
                aria-selected={index === active}
                title={`Allega l’output di “${option.title}”`}
                onMouseMove={() => index !== active && onHover(index)}
                onClick={() => onChoose(option)}
                className="flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-[12.5px] aria-selected:bg-accent dark:aria-selected:bg-input/70"
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
                className="flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-[12.5px] aria-selected:bg-accent dark:aria-selected:bg-input/70"
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
      <p className="border-t border-border px-3 py-1.5 font-mono text-[10.5px] text-faint dark:border-input/60">
        ↑↓ scegli · ↵ o Tab inserisci · Esc chiudi
      </p>
    </div>
  )
}
