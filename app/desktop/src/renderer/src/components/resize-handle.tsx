// Divisore trascinabile (LAD-75): sidebar, colonne affiancate e ispettore. Pointer events con il nucleo di
// lib/pointer-drag.ts (Esc annulla, la vista nativa del browser si nasconde da sola), tastiera con le frecce.
// Durante il trascinamento non cambia lo stato di React: `onPreview` ritocca il DOM (un aggiornamento per frame) e solo
// a fine gesto `onCommit` salva la misura.
import { useEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { startPointerDrag } from '@/lib/pointer-drag'
import { clamp, RESIZE_STEP, RESIZE_STEP_LARGE } from '@/lib/panel-size'
import { cn } from '@/lib/utils'

export interface ResizeRange {
  value: number
  min: number
  max: number
}

interface ResizeHandleProps extends ResizeRange {
  label: string
  /** Il valore cresce spostando il divisore a sinistra (ispettore). */
  invert?: boolean
  /** Misura attuale al momento del gesto, se `value`, `min` e `max` di render possono essere vecchi (colonne). */
  measure?: () => ResizeRange
  /** Ogni frame del trascinamento e ogni passo di tastiera: solo DOM, niente stato. */
  onPreview: (value: number) => void
  /** Fine del gesto (o passo di tastiera, dopo una breve pausa): salva. */
  onCommit: (value: number) => void
  /** Doppio clic: torna al predefinito. */
  onReset: () => void
  /** Trascinamento annullato con Esc: il chiamante ripristina l'anteprima. */
  onCancel?: (value: number) => void
  className?: string
}

const COMMIT_DELAY = 250

/** Zona di presa larga 8 px e linea sottile al centro; il chiamante la posiziona (assoluta o dentro una fila flex). */
export function ResizeHandle({ label, value, min, max, invert, measure, onPreview, onCommit, onReset, onCancel, className }: ResizeHandleProps) {
  const node = useRef<HTMLDivElement>(null)
  const latest = useRef({ value, min, max, onPreview, onCommit, onCancel, measure })
  latest.current = { value, min, max, onPreview, onCommit, onCancel, measure }
  // Valore mostrato durante un gesto: l'aria-valuenow si aggiorna a mano, senza ridisegnare.
  const live = useRef<number | null>(null)
  const timer = useRef<number | null>(null)
  const stop = useRef<(() => void) | null>(null)
  // Gesto di trascinamento in corso: ripristina l'anteprima se il divisore sparisce a metà (es. ⌘B con il mouse premuto).
  const abort = useRef<(() => void) | null>(null)

  const flush = () => {
    if (timer.current === null) return
    window.clearTimeout(timer.current)
    timer.current = null
    if (live.current !== null) latest.current.onCommit(live.current)
    live.current = null
  }
  useEffect(
    () => () => {
      stop.current?.()
      // Smontato a gesto in corso: niente salvataggio di una misura a metà, si torna al valore iniziale.
      abort.current?.()
      abort.current = null
      flush()
    },
    []
  )

  const show = (next: number) => {
    live.current = next
    node.current?.setAttribute('aria-valuenow', String(Math.round(next)))
  }
  const range = (): ResizeRange => latest.current.measure?.() ?? latest.current

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return
    // Niente selezione di testo mentre si trascina; il focus lo prendiamo noi.
    event.preventDefault()
    node.current?.focus({ preventScroll: true })
    flush()
    const start = range()
    const dir = invert ? -1 : 1
    let frame = 0
    let target = start.value
    const apply = () => {
      frame = 0
      latest.current.onPreview(target)
    }
    const cancelFrame = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
    }
    abort.current = () => {
      cancelFrame()
      latest.current.onPreview(start.value)
    }
    node.current?.setAttribute('data-resizing', 'true')
    stop.current = startPointerDrag(event.nativeEvent, {
      threshold: 1,
      onStart: () => {
        document.documentElement.style.cursor = 'col-resize'
      },
      onMove: (_move, delta) => {
        target = clamp(start.value + dir * delta.x, start.min, start.max)
        show(target)
        if (!frame) frame = requestAnimationFrame(apply)
      },
      onEnd: () => {
        abort.current = null
        cancelFrame()
        node.current?.removeAttribute('data-resizing')
        latest.current.onPreview(target)
        latest.current.onCommit(target)
        live.current = null
      },
      onCancel: () => {
        abort.current = null
        cancelFrame()
        node.current?.removeAttribute('data-resizing')
        show(start.value)
        latest.current.onPreview(start.value)
        latest.current.onCancel?.(start.value)
        live.current = null
      }
    })
    // Un clic senza trascinamento non chiama onEnd: il marcatore si toglie al rilascio.
    window.addEventListener(
      'pointerup',
      () => {
        abort.current = null
        node.current?.removeAttribute('data-resizing')
      },
      { once: true, capture: true }
    )
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // Con ⌘, Ctrl o Alt passano le scorciatoie globali (cambio colonna, spostamento tab): qui solo frecce semplici, Maiusc per il passo grande.
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const current = range()
    const step = event.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP
    const dir = invert ? -1 : 1
    let next: number | null = null
    if (event.key === 'ArrowRight') next = (live.current ?? current.value) + dir * step
    else if (event.key === 'ArrowLeft') next = (live.current ?? current.value) - dir * step
    else if (event.key === 'Home') next = invert ? current.max : current.min
    else if (event.key === 'End') next = invert ? current.min : current.max
    else if (event.key === 'Enter') {
      event.preventDefault()
      // Come il doppio clic: un passo di freccia ancora in attesa non deve sovrascrivere il ripristino.
      window.clearTimeout(timer.current ?? undefined)
      timer.current = null
      live.current = null
      onReset()
      return
    }
    if (next === null) return
    event.preventDefault()
    next = clamp(next, current.min, current.max)
    show(next)
    latest.current.onPreview(next)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, COMMIT_DELAY)
  }

  return (
    <div
      ref={node}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      title={label}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        live.current = null
        onReset()
      }}
      onKeyDown={onKeyDown}
      onFocus={() => {
        // I limiti di render possono essere vecchi (finestra ridimensionata, colonne cambiate): si rileggono quando arriva il focus.
        const now = range()
        node.current?.setAttribute('aria-valuenow', String(Math.round(now.value)))
        node.current?.setAttribute('aria-valuemin', String(Math.round(now.min)))
        node.current?.setAttribute('aria-valuemax', String(Math.round(now.max)))
      }}
      onBlur={flush}
      className={cn('group/resize relative z-10 w-2 cursor-col-resize touch-none outline-none select-none', className)}
    >
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-transparent transition-colors duration-150 group-hover/resize:bg-ring/50 group-focus-visible/resize:bg-ring group-data-[resizing]/resize:bg-ring motion-reduce:transition-none" />
    </div>
  )
}
