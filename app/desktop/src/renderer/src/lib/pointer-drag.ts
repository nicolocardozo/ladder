// Trascinamento con i pointer events, senza HTML5 drag and drop: più controllo su soglia, animazione e annullamento.
// `startPointerDrag` è il nucleo (soglia, Esc, clic che resta clic); `startSortDrag` lo usa per riordinare una fila di
// elementi (le tab). Il trascinamento delle sessioni nei gruppi e, in futuro, quello delle tab sul bordo della vista
// (affiancamento) partono dallo stesso nucleo.

/** Pixel di movimento prima che un clic diventi trascinamento. */
export const DRAG_THRESHOLD = 4
const SETTLE_MS = 150

export interface PointerDragOptions {
  threshold?: number
  /** La soglia è stata superata: da qui in poi è un trascinamento e il clic seguente viene assorbito. */
  onStart?: (event: PointerEvent) => void
  onMove?: (event: PointerEvent, delta: { x: number; y: number }) => void
  /** Rilasciato dopo l'inizio del trascinamento. */
  onEnd?: (event: PointerEvent) => void
  /** Esc, perdita del focus della finestra o pointercancel dopo l'inizio. */
  onCancel?: () => void
}

interface DownPoint {
  button: number
  clientX: number
  clientY: number
}

/** Assorbe il clic che il browser genera dopo il rilascio, così trascinare una tab o una riga non la apre. */
function swallowNextClick(released: boolean): void {
  const swallow = (event: Event) => {
    event.stopPropagation()
    event.preventDefault()
  }
  const remove = () => setTimeout(() => window.removeEventListener('click', swallow, true), 50)
  window.addEventListener('click', swallow, true)
  // Rilascio già avvenuto: il clic arriva subito. Annullato con Esc: arriva quando si rilascia il tasto.
  if (released) remove()
  else window.addEventListener('pointerup', remove, { once: true, capture: true })
}

/** Avvia il tracciamento da un pointerdown. Restituisce una funzione che lo interrompe senza chiamare `onCancel`. */
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
      // Il browser integrato è una vista nativa sopra la pagina: durante un trascinamento si nasconde (lib/native-overlay.ts).
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
    // Dopo Esc il tasto è ancora premuto: il clic arriverà al rilascio. Con pointercancel o blur non arriva.
    if (escape === true) swallowNextClick(false)
    options.onCancel?.()
  }
  function cancelOther() {
    onCancel(false)
  }
  function onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape' || done) return
    // Esc annulla il trascinamento e non chiude altro (menu, palette) mentre si trascina.
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

// ── Riordino di una fila ────────────────────────────────────────────────────

export interface SortDragOptions {
  /** Il pointerdown che ha avviato il gesto. */
  event: DownPoint
  /** Gli elementi della fila, nell'ordine attuale. */
  nodes: HTMLElement[]
  /** Posizione dell'elemento trascinato in `nodes`. */
  index: number
  /** Rilascio con una nuova posizione: la lista va riordinata (gli stili temporanei sono già tolti). */
  onCommit: (from: number, to: number) => void
  /** Ogni movimento, con la posizione che l'elemento prenderebbe. Per l'affiancamento: rilevare il bordo della vista. */
  onMove?: (event: PointerEvent, state: { from: number; to: number }) => void
  /** Prima di riordinare: restituisce true se il rilascio è stato preso in carico (per esempio un drop sul bordo). */
  onRelease?: (event: PointerEvent, state: { from: number; to: number }) => boolean
  /** Il gesto è finito senza rilascio (Esc, finestra persa): ripulisce quello che `onMove` ha mostrato. */
  onCancel?: () => void
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Riordina `nodes` orizzontalmente. L'elemento trascinato segue il puntatore dentro i limiti della fila, gli altri
 * scorrono per fargli posto. Si anima solo `transform`; trascinare fuori dalla fila non fa altro che fermarlo al bordo.
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
    // Il frame dopo si torna alle transizioni normali.
    requestAnimationFrame(() => {
      for (const node of nodes) node.style.transition = ''
    })
  }
  /** Porta l'elemento trascinato al suo posto (o a quello di partenza) e poi ripulisce. */
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
