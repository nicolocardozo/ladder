// Branch locali del progetto (comando `project.branches`): elenco, branch del checkout principale, file non committati e sessione al lavoro.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectBranches } from '@shared/protocol'
import { isElectron, request } from '@/lib/host-client'

export interface BranchesState {
  data: ProjectBranches | null
  error: string | null
  loading: boolean
  /** Rilegge adesso (apertura di un menu, dopo un cambio). */
  reload: () => void
}

/**
 * Legge i branch del progetto quando `enabled` e a ogni `refreshKey` diverso (per esempio il branch mostrato nella barra); l'ultima
 * risposta vince, una vecchia si ignora. Senza host (anteprima web) non chiede nulla.
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
    // Un altro progetto: i dati vecchi non valgono.
    setData((current) => (current && current.projectId === projectId ? current : null))
    if (enabled) load()
    return () => {
      // Un altro progetto o lo smontaggio: la risposta in volo si ignora e non deve lasciare `loading` acceso.
      ticket.current++
      setLoading(false)
    }
  }, [projectId, enabled, refreshKey, load])
  return { data: data && data.projectId === projectId ? data : null, error, loading, reload: load }
}
