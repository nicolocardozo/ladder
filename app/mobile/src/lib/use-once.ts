import { useCallback, useRef } from 'react'

/** Function that runs `fn` only once: closing a sheet from two paths (effect and response) must not go back twice. */
export function useOnce(fn: () => void): () => void {
  const done = useRef(false)
  const latest = useRef(fn)
  latest.current = fn
  return useCallback(() => {
    if (done.current) return
    done.current = true
    latest.current()
  }, [])
}
