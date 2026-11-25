import { useCallback, useRef } from 'react'

/** Funzione che esegue `fn` una volta sola: chiudere uno sheet da due strade (effetto e risposta) non deve tornare indietro due volte. */
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
