// Ripristino dei file con annullamento: l'host salva lo stato attuale prima di toccare qualcosa.
import { useCallback, useEffect, useState } from 'react'
import { Undo2, X } from 'lucide-react'
import { request } from '@/lib/host-client'

interface Done {
  text: string
  undo: string
  paths: string[]
}

export function useRestore(root: string) {
  const [done, setDone] = useState<Done | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!done) return
    const timer = window.setTimeout(() => setDone(null), 20000)
    return () => window.clearTimeout(timer)
  }, [done])

  const restore = useCallback(
    async (to: string, paths: string[] | undefined, label: string) => {
      setError(null)
      setBusy(true)
      try {
        const result = await request<{ undo: string; paths: string[] }>({ type: 'git.restore', root, to, paths, label })
        const n = result.paths.length
        setDone({ text: `${label}: ${n === 1 ? '1 file' : `${n} file`}`, undo: result.undo, paths: result.paths })
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [root]
  )

  const undo = useCallback(async () => {
    if (!done) return
    setBusy(true)
    try {
      await request({ type: 'git.restore', root, to: done.undo, paths: done.paths, label: 'Annullato il ripristino' })
      setDone(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [done, root])

  const banner =
    done || error ? (
      <div role="status" className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/70 px-3 py-2 text-[12.5px]">
        {error ? (
          <span className="min-w-0 flex-1 text-destructive">{error}</span>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">{done!.text}</span>
            <button
              type="button"
              onClick={() => void undo()}
              disabled={busy}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-medium text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Undo2 className="size-3.5" />
              Annulla
            </button>
          </>
        )}
        <button
          type="button"
          aria-label="Chiudi"
          onClick={() => {
            setDone(null)
            setError(null)
          }}
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent"
        >
          <X className="size-3.5" />
        </button>
      </div>
    ) : null

  return { restore, busy, banner }
}
