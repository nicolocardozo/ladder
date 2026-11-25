import { useCallback, useEffect, useState } from 'react'

/** Below this width a column switches to the compact view: closed tool cards, essential composer. */
export const COMPACT_WIDTH = 420
/** Minimum width of a side-by-side column: if they don't all fit, fewer columns are shown. */
export const MIN_COLUMN_WIDTH = 320

/** Width of an element, updated when it changes. 0 until measured. Use with `ref={setElement}`. */
export function useElementWidth(): [(element: HTMLElement | null) => void, number] {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!element) return
    setWidth(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [useCallback((node: HTMLElement | null) => setElement(node), []), width]
}
