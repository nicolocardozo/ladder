// Effort as a notched slider, in the model menu: click, drag, or use the ← → arrows.
import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { Gauge } from 'lucide-react'
import type { Effort } from '@shared/protocol'
import { t } from '@shared/i18n'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { DefaultBadge } from '@/components/default-badge'
import { EFFORTS } from '@/lib/agents'
import type { DefaultSource } from '@/lib/effective-defaults'

const WIDTH = 100
const THUMB = 18
const INSET = 1

interface EffortSliderProps {
  /** Levels of the chosen model, lowest to highest. */
  levels: Effort[]
  value: Effort | null
  /** Without an explicit choice the agent decides: the slider sits on the medium-high level, but the label says "default". */
  onChange: (effort: Effort) => void
}

/** Slider index: without a choice it sits on the medium-high level. */
function indexOfLevel(levels: Effort[], value: Effort | null): number {
  const fallback = levels.includes('high') ? levels.indexOf('high') : levels.length - 1
  return value && levels.includes(value) ? levels.indexOf(value) : fallback
}

/** ← → arrows: handles the event and returns the new level, or null if the key doesn't matter or changes nothing. */
function stepWithArrows(event: KeyboardEvent, levels: Effort[], value: Effort | null, pinned = false): Effort | null {
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!step) return null
  event.preventDefault()
  event.stopPropagation()
  const next = levels[Math.min(levels.length - 1, Math.max(0, indexOfLevel(levels, value) + step))]
  return next && (pinned || next !== value) ? next : null
}

/** Level name in the current language; without a choice, "Default". */
export function effortName(levels: Effort[], value: Effort | null): string {
  return value && levels.includes(value) ? t(EFFORTS.find((e) => e.id === value)?.label ?? value) : t('Default')
}

/**
 * The slider on its own. In the model menu EffortSlider wraps it (the menu item handles the arrows);
 * `standalone` makes it a control with its own focus (role="slider"), for settings.
 * `pinned`: the shown value is not a choice (it is inherited), so even picking the same level or pressing an arrow at the limit saves it.
 */
export function EffortTrack({ levels, value, onChange, standalone, label, muted, pinned }: EffortSliderProps & { standalone?: boolean; label?: string; muted?: boolean; pinned?: boolean }) {
  const track = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const index = indexOfLevel(levels, value)
  const span = WIDTH - THUMB - INSET * 2
  const stop = (i: number) => (levels.length > 1 ? (i * span) / (levels.length - 1) : 0)
  const x = stop(index)
  const name = effortName(levels, value)

  const pick = (clientX: number, force = false) => {
    const box = track.current?.getBoundingClientRect()
    if (!box || levels.length < 2) return
    const ratio = Math.min(1, Math.max(0, (clientX - box.left - INSET - THUMB / 2) / span))
    const next = levels[Math.round(ratio * (levels.length - 1))]
    if (force || next !== value) onChange(next)
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragging.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    // On click, with a merely inherited value, even the same level is saved.
    pick(event.clientX, pinned)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) pick(event.clientX)
  }
  const onPointerUp = () => {
    dragging.current = false
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const next = stepWithArrows(event, levels, value, pinned)
    if (next) onChange(next)
  }

  return (
    <div
      ref={track}
      data-effort-track
      {...(standalone ? { role: 'slider', tabIndex: 0, 'aria-label': label ?? t('Effort'), 'aria-valuemin': 0, 'aria-valuemax': levels.length - 1, 'aria-valuenow': index, 'aria-valuetext': name, onKeyDown } : {})}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(event) => event.stopPropagation()}
      className={`relative shrink-0 cursor-pointer touch-none rounded-full bg-foreground/10 ${standalone ? 'outline-none focus-visible:ring-2 focus-visible:ring-ring/50' : ''} ${muted ? 'opacity-50' : ''}`}
      style={{ width: WIDTH, height: THUMB + INSET * 2 } as CSSProperties}
    >
      {/* Filled part up to the thumb: revealed with clip-path, without touching the layout. */}
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
  )
}

interface EffortSliderMenuProps extends Omit<EffortSliderProps, 'value'> {
  /** Level shown: the chosen one or, without a choice, the default. */
  value: Effort | null
  /** `value` is an explicit choice; otherwise it is the default and a click saves it anyway. */
  chosen: boolean
  defaultLevel?: Effort | null
  defaultSource?: DefaultSource | null
  agentName?: string
}

export function EffortSlider({ levels, value, chosen, defaultLevel = null, defaultSource = null, agentName = '', onChange }: EffortSliderMenuProps) {
  const name = effortName(levels, value)
  const onKeyDown = (event: KeyboardEvent) => {
    const next = stepWithArrows(event, levels, value, !chosen && value !== null)
    if (next) onChange(next)
  }
  return (
    <>
      <DropdownMenuItem closeOnClick={false} onKeyDown={onKeyDown} aria-label={t('Effort: {level}. Use the left and right arrows to change it.', { level: name })} className="gap-2 py-1.5">
        <Gauge aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">
          {t('Effort')} <span className="text-muted-foreground">({name})</span>
        </span>
        {value && value === defaultLevel && <DefaultBadge source={defaultSource} agentName={agentName} />}
        <EffortTrack levels={levels} value={value} pinned={!chosen && value !== null} onChange={onChange} />
      </DropdownMenuItem>
    </>
  )
}
