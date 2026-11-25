// Shared building blocks for the Settings sections: switch, label + control row, radio-button choice group and button styles.
import { useRef, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export const settingsButton =
  'h-8 shrink-0 rounded-md border border-input px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50'
export const settingsField =
  'h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50'

export function Toggle({ label, description, checked, onChange, disabled }: { label: string; description: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cn('flex items-center justify-between gap-6 px-4 py-3.5', disabled && 'opacity-60')}>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm text-muted-foreground">{description}</span>
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="size-4 shrink-0 accent-primary [color-scheme:light] dark:[color-scheme:dark]" />
    </label>
  )
}

/** A row in a boxed list of rows: label and explanation on the left, the control on the right. */
export function SettingRow({ label, hint, warning, children }: { label: string; hint?: ReactNode; warning?: string | null; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        {warning ? <span className="text-xs text-destructive">{warning}</span> : hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  )
}

/** Title and explanation of a block inside a section, such as "Chat font" in Appearance. */
export function SettingsBlock({ id, title, description, children, className }: { id: string; title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-8', className)} aria-labelledby={id}>
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {description && <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">{description}</p>}
      {children}
    </section>
  )
}

export interface Choice<T extends string> {
  id: T
  label: string
  /** Second line, 12 px muted. */
  hint?: string
  /** Label next to the name, for example "default". */
  badge?: string
  /** Muted note to the right of the name, for example "not installed". */
  note?: string
}

/**
 * Choice among a few options, as radio buttons (same look as Chat font and Chat width): a single tab stop,
 * arrow keys to move and choose. `minWidth` is the minimum width of a grid cell.
 */
export function ChoiceGroup<T extends string>({ label, value, choices, onChange, minWidth = 180, renderLabel }: {
  label: string
  value: T
  choices: Choice<T>[]
  onChange: (value: T) => void
  minWidth?: number
  renderLabel?: (choice: Choice<T>) => ReactNode
}) {
  const group = useRef<HTMLDivElement>(null)
  return (
    <div ref={group} className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))` }} role="radiogroup" aria-label={label}>
      {choices.map((choice, index) => {
        const selected = choice.id === value
        return (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={selected}
            data-choice={choice.id}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(choice.id)}
            onKeyDown={(e) => {
              const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
              if (!step) return
              e.preventDefault()
              const next = choices[(index + step + choices.length) % choices.length]
              onChange(next.id)
              group.current?.querySelector<HTMLElement>(`[data-choice='${next.id}']`)?.focus()
            }}
            className={cn(
              'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-input'
            )}
          >
            <span className="flex w-full items-center gap-2 text-sm">
              <span className={selected ? 'font-semibold' : 'font-medium'}>{renderLabel ? renderLabel(choice) : choice.label}</span>
              {choice.badge && <span className="rounded border border-border px-1 text-xs text-muted-foreground">{choice.badge}</span>}
              {choice.note && <span className="text-xs text-faint">{choice.note}</span>}
              {selected && <Check className="ml-auto size-3.5 text-primary" aria-hidden="true" />}
            </span>
            {choice.hint && <span className="text-xs text-muted-foreground">{choice.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Outcome message under an action: muted, or pink if it is an error. */
export function Outcome({ tone = 'muted', children }: { tone?: 'muted' | 'error'; children: ReactNode }) {
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={cn('text-xs', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
      {children}
    </p>
  )
}

