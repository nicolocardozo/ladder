import { useCallback, useEffect, useState } from 'react'

/** Sotto questa larghezza una colonna passa alla vista compatta: card degli strumenti chiuse, composer essenziale. */
export const COMPACT_WIDTH = 420
/** Larghezza minima di una colonna affiancata: se non ci stanno tutte, si mostrano meno colonne. */
export const MIN_COLUMN_WIDTH = 320

/** Larghezza di un elemento, aggiornata quando cambia. 0 finché non è misurato. Si usa con `ref={setElement}`. */
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
