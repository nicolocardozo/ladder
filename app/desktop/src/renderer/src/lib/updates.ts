// Stato degli aggiornamenti dal main (src/main/updater.ts). Nell'anteprima web non c'è Electron: resta null.
import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/updates'

export function useUpdate(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    const updates = window.ladder?.updates
    if (!updates) return
    let live = true
    void updates.state().then((s) => live && setState(s))
    const off = updates.onChange(setState)
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}

export const checkForUpdate = (): Promise<UpdateState | undefined> => window.ladder?.updates.check() ?? Promise.resolve(undefined)
export const installUpdate = (): Promise<void> => window.ladder?.updates.install() ?? Promise.resolve()
