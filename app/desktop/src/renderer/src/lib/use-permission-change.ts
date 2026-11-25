// Changing the permission level of an already started session.
// The new level shows immediately but only if the host confirms; if it refuses, the previous one comes back and the error rises to whoever uses the hook.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { matchesCommand } from '@shared/shortcuts'
import type { PermissionLevel } from '@shared/protocol'
import { t } from '@shared/i18n'

/** Beyond this time without a host reply the change is considered failed. */
const CHANGE_TIMEOUT_MS = 10_000

export interface PermissionChangeResult {
  permission: PermissionLevel
  appliesFrom: 'now' | 'next-turn'
}

interface Options {
  /** Level in effect according to the host. */
  permission: PermissionLevel
  /** Level waiting for the next turn according to the host. */
  permissionNext?: PermissionLevel | null
  /** Levels allowed by the project, in the order ⇧Tab cycles through them. */
  levels: PermissionLevel[]
  /** Sends the change to the host (request) and resolves with its reply or rejects with the error. */
  apply: (permission: PermissionLevel) => Promise<PermissionChangeResult>
  onError: (message: string | null) => void
}

export function usePermissionChange({ permission, permissionNext, levels, apply, onError }: Options) {
  const [optimistic, setOptimistic] = useState<PermissionLevel | null>(null)
  const [localNext, setLocalNext] = useState<PermissionLevel | null>(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  // Change in progress (to ignore late replies) and safety / release timers of the provisional level.
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

  // When the real level changes, the provisional one has had its time.
  useEffect(() => {
    setOptimistic(null)
    setLocalNext(null)
  }, [permission])

  const shown = optimistic ?? permission
  const rawNext = permissionNext ?? localNext
  const next = rawNext && rawNext !== shown ? rawNext : null

  const change = useCallback(
    (target: PermissionLevel) => {
      // With a pending change we start from that: going back to the current level is allowed, repeating the wait is not.
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
            // The event with the new level has usually already arrived; if it is late, we don't stay on a provisional value.
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

  /** ⇧Tab with focus on the open request card or its buttons (the composer handles it itself); elsewhere it stays backwards navigation. */
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
