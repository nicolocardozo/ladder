// Effort come cursore a tacche, nel menu del modello: si clicca, si trascina o si usano le frecce ← →.
import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { Gauge } from 'lucide-react'
import type { Effort } from '@shared/protocol'
import { t } from '@shared/i18n'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'

// Etichette in inglese: si traducono con t() dove si mostrano.
export const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' }
]

const WIDTH = 100
const THUMB = 18
const INSET = 1

interface EffortSliderProps {
  /** Livelli del modello scelto, dal più basso al più alto. */
  levels: Effort[]
  value: Effort | null
  /** Senza una scelta esplicita decide l'agente: il cursore sta sul livello medio-alto, ma l'etichetta dice "predefinito". */
  onChange: (effort: Effort) => void
}

export function EffortSlider({ levels, value, onChange }: EffortSliderProps) {
  const track = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const fallback = levels.includes('high') ? levels.indexOf('high') : levels.length - 1
  const index = value && levels.includes(value) ? levels.indexOf(value) : fallback
  const span = WIDTH - THUMB - INSET * 2
  const stop = (i: number) => (levels.length > 1 ? (i * span) / (levels.length - 1) : 0)
  const x = stop(index)
  const name = value && levels.includes(value) ? t(EFFORTS.find((e) => e.id === value)?.label ?? value) : t('Default')

  const pick = (clientX: number) => {
    const box = track.current?.getBoundingClientRect()
    if (!box || levels.length < 2) return
    const ratio = Math.min(1, Math.max(0, (clientX - box.left - INSET - THUMB / 2) / span))
    const next = levels[Math.round(ratio * (levels.length - 1))]
    if (next !== value) onChange(next)
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragging.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    pick(event.clientX)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) pick(event.clientX)
  }
  const onPointerUp = () => {
    dragging.current = false
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    event.stopPropagation()
    const next = levels[Math.min(levels.length - 1, Math.max(0, index + step))]
    if (next && next !== value) onChange(next)
  }

  return (
    <DropdownMenuItem closeOnClick={false} onKeyDown={onKeyDown} aria-label={t('Effort: {level}. Use the left and right arrows to change it.', { level: name })} className="gap-2 py-1.5">
      <Gauge aria-hidden className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm">
        {t('Effort')} <span className="text-muted-foreground">({name})</span>
      </span>
      <div
        ref={track}
        data-effort-track
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={(event) => event.stopPropagation()}
        className="relative shrink-0 cursor-pointer touch-none rounded-full bg-foreground/10"
        style={{ width: WIDTH, height: THUMB + INSET * 2 } as CSSProperties}
      >
        {/* Parte piena fino al cursore: si apre con clip-path, senza toccare il layout. */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-primary transition-[clip-path] duration-150 ease-out motion-reduce:transition-none"
          style={{ clipPath: `inset(0 ${WIDTH - (x + THUMB + INSET * 2)}px 0 0 round 999px)` }}
        />
        {levels.map((level, i) =>
          i === index ? null : (
            <span
              key={level}
              aria-hidden
              className={`absolute top-1/2 size-1 -translate-1/2 rounded-full ${i < index ? 'bg-primary-foreground/60' : 'bg-muted-foreground/70'}`}
              style={{ left: INSET + THUMB / 2 + stop(i) }}
            />
          )
        )}
        <span
          aria-hidden
          className="absolute rounded-full bg-foreground shadow-sm transition-transform duration-150 ease-out motion-reduce:transition-none"
          style={{ top: INSET, left: INSET, width: THUMB, height: THUMB, transform: `translateX(${x}px)` }}
        />
      </div>
    </DropdownMenuItem>
  )
}
