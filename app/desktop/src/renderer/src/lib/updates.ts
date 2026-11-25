// Update state from main (src/main/updater.ts). In the web preview there is no Electron: it stays null.
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
