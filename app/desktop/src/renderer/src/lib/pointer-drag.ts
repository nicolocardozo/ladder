// Dragging with pointer events, without HTML5 drag and drop: more control over threshold, animation and cancellation.
// `startPointerDrag` is the core (threshold, Esc, a click that stays a click); `startSortDrag` uses it to reorder a row of
// elements (the tabs). Dragging sessions into groups and, in the future, tabs onto the view edge
// (side-by-side) start from the same core.

/** Pixels of movement before a click becomes a drag. */
export const DRAG_THRESHOLD = 4
const SETTLE_MS = 150

export interface PointerDragOptions {
  threshold?: number
  /** The threshold has been exceeded: from here on it is a drag and the following click is swallowed. */
  onStart?: (event: PointerEvent) => void
  onMove?: (event: PointerEvent, delta: { x: number; y: number }) => void
  /** Released after the drag started. */
  onEnd?: (event: PointerEvent) => void
  /** Esc, window focus loss or pointercancel after the start. */
  onCancel?: () => void
}

interface DownPoint {
  button: number
  clientX: number
  clientY: number
}

/** Swallows the click the browser generates after release, so dragging a tab or row does not open it. */
function swallowNextClick(released: boolean): void {
  const swallow = (event: Event) => {
    event.stopPropagation()
    event.preventDefault()
  }
  const remove = () => setTimeout(() => window.removeEventListener('click', swallow, true), 50)
  window.addEventListener('click', swallow, true)
  // Release already happened: the click arrives immediately. Cancelled with Esc: it arrives when the key is released.
  if (released) remove()
  else window.addEventListener('pointerup', remove, { once: true, capture: true })
}

/** Starts tracking from a pointerdown. Returns a function that stops it without calling `onCancel`. */
export function startPointerDrag(down: DownPoint, options: PointerDragOptions): () => void {
  if (down.button !== 0) return () => undefined
  const threshold = options.threshold ?? DRAG_THRESHOLD
  let started = false
  let done = false

  const cleanup = () => {
    done = true
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', cancelOther, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', cancelOther)
    if (started) {
      document.documentElement.style.cursor = ''
      delete document.documentElement.dataset.dragging
    }
  }
  function onMove(event: PointerEvent) {
    if (done) return
    const delta = { x: event.clientX - down.clientX, y: event.clientY - down.clientY }
    if (!started) {
      if (Math.hypot(delta.x, delta.y) < threshold) return
      started = true
      document.documentElement.style.cursor = 'grabbing'
      // The built-in browser is a native view above the page: during a drag it is hidden (lib/native-overlay.ts).
      document.documentElement.dataset.dragging = 'true'
      options.onStart?.(event)
    }
    event.preventDefault()
    options.onMove?.(event, delta)
  }
  function onUp(event: PointerEvent) {
    if (done) return
    const wasDrag = started
    cleanup()
    if (!wasDrag) return
    swallowNextClick(true)
    options.onEnd?.(event)
  }
  function onCancel(escape = false) {
    if (done) return
    const wasDrag = started
    cleanup()
    if (!wasDrag) return
    // After Esc the button is still pressed: the click will arrive on release. With pointercancel or blur it does not.
    if (escape === true) swallowNextClick(false)
    options.onCancel?.()
  }
  function cancelOther() {
    onCancel(false)
  }
  function onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape' || done) return
    // Esc cancels the drag and closes nothing else (menu, palette) while dragging.
    if (started) {
      event.preventDefault()
      event.stopPropagation()
    }
    onCancel(true)
  }

  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', cancelOther, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', cancelOther)
  return () => {
    if (!done) cleanup()
  }
}

// ── Reordering a row ────────────────────────────────────────────────────

export interface SortDragOptions {
  /** The pointerdown that started the gesture. */
  event: DownPoint
  /** The row's elements, in the current order. */
  nodes: HTMLElement[]
  /** Position of the dragged element in `nodes`. */
  index: number
  /** Release with a new position: the list must be reordered (temporary styles are already removed). */
  onCommit: (from: number, to: number) => void
  /** Every move, with the position the element would take. For side-by-side: detect the view edge. */
  onMove?: (event: PointerEvent, state: { from: number; to: number }) => void
  /** Before reordering: returns true if the release was handled (for example a drop on the edge). */
  onRelease?: (event: PointerEvent, state: { from: number; to: number }) => boolean
  /** The gesture ended without release (Esc, window lost): cleans up what `onMove` showed. */
  onCancel?: () => void
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Reorders `nodes` horizontally. The dragged element follows the pointer within the row's limits, the others
 * slide to make room. Only `transform` is animated; dragging out of the row just stops it at the edge.
 */
export function startSortDrag({ event, nodes, index: from, onCommit, onMove, onRelease, onCancel }: SortDragOptions): void {
  if (nodes.length < 2 || !nodes[from]) return
  const dragged = nodes[from]
  let rects: DOMRect[] = []
  let gap = 0
  let to = from
  let offset = 0
  const animate = !reducedMotion()

  const shiftOf = (j: number): number => {
    const step = rects[from].width + gap
    if (j > from && j <= to) return -step
    if (j < from && j >= to) return step
    return 0
  }
  const apply = () => {
    nodes.forEach((node, j) => {
      if (j === from) node.style.transform = `translateX(${offset}px)`
      else {
        const shift = shiftOf(j)
        node.style.transform = shift ? `translateX(${shift}px)` : ''
      }
    })
  }
  const reset = () => {
    for (const node of nodes) {
      node.style.transition = 'none'
      node.style.transform = ''
      node.style.zIndex = ''
      delete node.dataset.dragging
    }
    // On the next frame we return to the normal transitions.
    requestAnimationFrame(() => {
      for (const node of nodes) node.style.transition = ''
    })
  }
  /** Puts the dragged element in its place (or at the starting one) and then cleans up. */
  const settle = (target: number, then: () => void) => {
    const slot = target === from ? 0 : target > from ? rects[target].right - rects[from].right : rects[target].left - rects[from].left
    offset = slot
    to = target
    if (!animate) {
      reset()
      then()
      return
    }
    dragged.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
    apply()
    setTimeout(() => {
      reset()
      then()
    }, SETTLE_MS)
  }

  startPointerDrag(event, {
    onStart: () => {
      rects = nodes.map((node) => node.getBoundingClientRect())
      gap = from + 1 < nodes.length ? rects[from + 1].left - rects[from].right : rects[from].left - rects[from - 1].right
      dragged.dataset.dragging = 'true'
      dragged.style.zIndex = '10'
      dragged.style.transition = 'none'
      for (const node of nodes) if (node !== dragged && animate) node.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
    },
    onMove: (move, delta) => {
      const min = rects[0].left - rects[from].left
      const max = rects[nodes.length - 1].right - rects[from].right
      offset = Math.min(Math.max(delta.x, min), max)
      const center = rects[from].left + rects[from].width / 2 + offset
      to = rects.filter((rect, j) => j !== from && rect.left + rect.width / 2 < center).length
      apply()
      onMove?.(move, { from, to })
    },
    onEnd: (up) => {
      if (onRelease?.(up, { from, to })) {
        settle(from, () => undefined)
        return
      }
      const target = to
      settle(target, () => {
        if (target !== from) onCommit(from, target)
      })
    },
    onCancel: () => {
      onCancel?.()
      settle(from, () => undefined)
    }
  })
}
