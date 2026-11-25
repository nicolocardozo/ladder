// Draggable divider: sidebar, side-by-side columns and inspector. Pointer events with the core of
// lib/pointer-drag.ts (Esc cancels, the browser's native view hides on its own), keyboard with the arrows.
// While dragging, React state doesn't change: `onPreview` adjusts the DOM (one update per frame) and only
// at the end of the gesture does `onCommit` save the size.
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
  /** The value grows when moving the divider to the left (inspector). */
  invert?: boolean
  /** Current size at the time of the gesture, if the render's `value`, `min` and `max` may be stale (columns). */
  measure?: () => ResizeRange
  /** Every drag frame and every keyboard step: DOM only, no state. */
  onPreview: (value: number) => void
  /** End of the gesture (or keyboard step, after a short pause): save. */
  onCommit: (value: number) => void
  /** Double click: back to the default. */
  onReset: () => void
  /** Drag cancelled with Esc: the caller restores the preview. */
  onCancel?: (value: number) => void
  className?: string
}

const COMMIT_DELAY = 250

/** Grab area 8 px wide and a thin line in the center; the caller positions it (absolute or inside a flex row). */
export function ResizeHandle({ label, value, min, max, invert, measure, onPreview, onCommit, onReset, onCancel, className }: ResizeHandleProps) {
  const node = useRef<HTMLDivElement>(null)
  const latest = useRef({ value, min, max, onPreview, onCommit, onCancel, measure })
  latest.current = { value, min, max, onPreview, onCommit, onCancel, measure }
  // Value shown during a gesture: aria-valuenow is updated by hand, without re-rendering.
  const live = useRef<number | null>(null)
  const timer = useRef<number | null>(null)
  const stop = useRef<(() => void) | null>(null)
  // Drag gesture in progress: restores the preview if the divider disappears midway (e.g. ⌘B with the mouse pressed).
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
      // Unmounted mid-gesture: a half-way size is not saved, we go back to the initial value.
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
    // No text selection while dragging; we take focus ourselves.
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
    // A click without dragging doesn't call onEnd: the marker is removed on release.
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
    // With ⌘, Ctrl or Alt the global shortcuts pass through (column change, tab move): only plain arrows here, Shift for the big step.
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
      // Like the double click: a pending arrow step must not overwrite the reset.
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
        // Render limits may be stale (window resized, columns changed): they are re-read when focus arrives.
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
