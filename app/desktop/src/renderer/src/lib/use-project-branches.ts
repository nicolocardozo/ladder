// The project's local branches (`project.branches` command): list, main checkout branch, uncommitted files and working session.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectBranches } from '@shared/protocol'
import { isElectron, request } from '@/lib/host-client'

export interface BranchesState {
  data: ProjectBranches | null
  error: string | null
  loading: boolean
  /** Rereads now (opening a menu, after a change). */
  reload: () => void
}

/**
 * Reads the project's branches when `enabled` and on every different `refreshKey` (for example the branch shown in the bar); the latest
 * response wins, an old one is ignored. Without a host (web preview) it requests nothing.
 */
export function useProjectBranches(projectId: string | null, enabled: boolean, refreshKey: unknown = null): BranchesState {
  const [data, setData] = useState<ProjectBranches | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const ticket = useRef(0)
  const load = useCallback(() => {
    if (!projectId || !isElectron) return
    const mine = ++ticket.current
    setLoading(true)
    request<ProjectBranches>({ type: 'project.branches', projectId })
      .then((next) => {
        if (mine !== ticket.current) return
        setData(next)
        setError(null)
      })
      .catch((e: unknown) => {
        if (mine === ticket.current) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (mine === ticket.current) setLoading(false)
      })
  }, [projectId])
  useEffect(() => {
    // Another project: the old data isn't valid.
    setData((current) => (current && current.projectId === projectId ? current : null))
    if (enabled) load()
    return () => {
      // Another project or unmount: the in-flight response is ignored and must not leave `loading` on.
      ticket.current++
      setLoading(false)
    }
  }, [projectId, enabled, refreshKey, load])
  return { data: data && data.projectId === projectId ? data : null, error, loading, reload: load }
}
