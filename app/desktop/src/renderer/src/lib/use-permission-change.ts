// Cambio del livello di permessi di una sessione già avviata (LAD-44).
// Il livello nuovo si mostra subito ma solo se l'host conferma; se rifiuta, torna quello di prima e l'errore sale a chi usa l'hook.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { matchesCommand } from '@shared/shortcuts'
import type { PermissionLevel } from '@shared/protocol'
import { t } from '@shared/i18n'

/** Oltre questo tempo senza risposta dell'host il cambio si considera fallito. */
const CHANGE_TIMEOUT_MS = 10_000

export interface PermissionChangeResult {
  permission: PermissionLevel
  appliesFrom: 'now' | 'next-turn'
}

interface Options {
  /** Livello in vigore secondo l'host. */
  permission: PermissionLevel
  /** Livello in attesa del prossimo turno secondo l'host. */
  permissionNext?: PermissionLevel | null
  /** Livelli ammessi dal progetto, nell'ordine in cui ⇧Tab li percorre. */
  levels: PermissionLevel[]
  /** Invia il cambio all'host (request) e risolve con la sua risposta o rifiuta con l'errore. */
  apply: (permission: PermissionLevel) => Promise<PermissionChangeResult>
  onError: (message: string | null) => void
}

export function usePermissionChange({ permission, permissionNext, levels, apply, onError }: Options) {
  const [optimistic, setOptimistic] = useState<PermissionLevel | null>(null)
  const [localNext, setLocalNext] = useState<PermissionLevel | null>(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  // Cambio in corso (per ignorare risposte tardive) e timer di sicurezza / di rilascio del livello provvisorio.
  const seq = useRef(0)
  const timeoutTimer = useRef<number | null>(null)
  const releaseTimer = useRef<number | null>(null)
  const clearTimers = () => {
    if (timeoutTimer.current) window.clearTimeout(timeoutTimer.current)
    if (releaseTimer.current) window.clearTimeout(releaseTimer.current)
    timeoutTimer.current = releaseTimer.current = null
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimers()
    }
  }, [])

  // Quando il livello vero cambia, quello provvisorio ha fatto il suo tempo.
  useEffect(() => {
    setOptimistic(null)
    setLocalNext(null)
  }, [permission])

  const shown = optimistic ?? permission
  const rawNext = permissionNext ?? localNext
  const next = rawNext && rawNext !== shown ? rawNext : null

  const change = useCallback(
    (target: PermissionLevel) => {
      // Con un cambio in attesa si parte da quello: tornare al livello attuale è ammesso, ripetere l'attesa no.
      if (pending.current || target === (next ?? shown)) return
      pending.current = true
      const mine = ++seq.current
      clearTimers()
      onError(null)
      setOptimistic(target)
      const settle = () => {
        pending.current = false
        if (timeoutTimer.current) window.clearTimeout(timeoutTimer.current)
        timeoutTimer.current = null
      }
      timeoutTimer.current = window.setTimeout(() => {
        if (seq.current !== mine) return
        seq.current++
        settle()
        if (!mounted.current) return
        setOptimistic(null)
        onError(t('Permission change timed out'))
      }, CHANGE_TIMEOUT_MS)
      apply(target)
        .then((result) => {
          if (seq.current !== mine || !mounted.current) return
          settle()
          if (result.appliesFrom === 'next-turn') {
            setOptimistic(null)
            setLocalNext(result.permission)
          } else {
            setLocalNext(null)
            setOptimistic(result.permission)
            // L'evento con il livello nuovo di solito è già arrivato; se tarda, non restiamo su un valore provvisorio.
            releaseTimer.current = window.setTimeout(() => mounted.current && setOptimistic(null), 1500)
          }
        })
        .catch((e: Error) => {
          if (seq.current !== mine || !mounted.current) return
          settle()
          setOptimistic(null)
          onError(e.message)
        })
    },
    [apply, onError, shown, next]
  )

  const cycle = useCallback(() => {
    if (levels.length === 0) return
    change(levels[(levels.indexOf(next ?? shown) + 1) % levels.length])
  }, [levels, shown, next, change])

  /** ⇧Tab con il focus sulla card di richiesta aperta o sui suoi bottoni (il composer lo gestisce da solo); altrove resta navigazione all'indietro. */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented || !matchesCommand(event, 'composer.cyclePermission')) return
      const target = event.target as HTMLElement
      if (!target.closest('[role="group"][data-item-id]')) return
      if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="menu"], [role="dialog"]')) return
      event.preventDefault()
      cycle()
    },
    [cycle]
  )

  return { shown, next, change, cycle, onKeyDown }
}
