// "Phone activity": le ultime azioni fatte dal telefono (risposte, messaggi, stop, permessi), con il nome del telefono e la sessione.
// Si aggiorna da sola con gli eventi `remote.log`; "Show more" legge le voci più vecchie. Un clic su una voce apre la sessione.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteLogEntry } from '@shared/protocol'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { onHostConnect, onHostEvent } from '@/lib/host-client'
import { logTime, remoteCommands } from '@/lib/remote'
import { cn } from '@/lib/utils'
import { useSettings } from '@/hooks/use-theme'
import { useApp } from '@/store/app-store'

/** Unisce voci nuove e vecchie senza doppioni, dalla più recente. */
function merge(current: RemoteLogEntry[], incoming: RemoteLogEntry[]): RemoteLogEntry[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]))
  for (const entry of incoming) byId.set(entry.id, entry)
  return [...byId.values()].sort((a, b) => b.id - a.id)
}

export function PhoneLog() {
  const [entries, setEntries] = useState<RemoteLogEntry[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessions = useApp((s) => s.sessions)
  const mounted = useRef(true)

  const load = useCallback(() => {
    remoteCommands
      .logList()
      .then((page) => {
        if (!mounted.current) return
        setEntries((current) => merge(current ?? [], page.entries))
        setHasMore((more) => more || page.hasMore)
        setError(null)
      })
      .catch((e: Error) => mounted.current && setError(e.message))
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => onHostConnect(load), [load])
  useEffect(
    () =>
      onHostEvent((event) => {
        if (event.type === 'remote.log') setEntries((current) => merge(current ?? [], [event.entry]))
      }),
    []
  )

  const more = () => {
    const last = entries?.[entries.length - 1]
    if (!last) return
    setLoadingMore(true)
    remoteCommands
      .logList(last.id)
      .then((page) => {
        if (!mounted.current) return
        setEntries((current) => merge(current ?? [], page.entries))
        setHasMore(page.hasMore)
      })
      .catch((e: Error) => mounted.current && setError(e.message))
      .finally(() => mounted.current && setLoadingMore(false))
  }

  const open = (sessionId: string) => {
    const session = useApp.getState().sessions[sessionId]
    if (!session) return
    useApp.getState().select({ kind: 'session', projectId: session.projectId, sessionId })
    useSettings.getState().setSettingsOpen(false)
  }

  return (
    <div className="mt-3">
      {error && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {entries && entries.length === 0 && !error && <p className="rounded-lg border border-border px-4 py-3.5 text-xs text-muted-foreground">{t('Nothing yet. What you do from a phone shows up here.')}</p>}
      {entries && entries.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {entries.map((entry) => {
            const session = entry.sessionId ? sessions[entry.sessionId] : undefined
            const body = (
              <>
                <span className="pt-px text-xs text-muted-foreground tabular-nums">{logTime(entry.at)}</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm">{entry.detail}</span>
                  <span className="truncate text-xs text-muted-foreground">{session ? `${entry.deviceName} · ${session.title}` : entry.deviceName}</span>
                </span>
              </>
            )
            const row = 'grid w-full grid-cols-[108px_minmax(0,1fr)] items-start gap-x-3 px-4 py-2.5 text-left'
            return (
              <li key={entry.id}>
                {session ? (
                  <button type="button" onClick={() => open(session.id)} className={cn(row, 'rounded-lg outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50')}>
                    {body}
                  </button>
                ) : (
                  <div className={row}>{body}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {hasMore && (
        <Button variant="ghost" size="sm" className="mt-2 text-sm" disabled={loadingMore} onClick={more}>
          {t('Show more')}
        </Button>
      )}
    </div>
  )
}
