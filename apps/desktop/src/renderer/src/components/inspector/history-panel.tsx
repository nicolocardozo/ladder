// Cronologia: checkpoint presi prima di ogni richiesta, ripristini e commit in un'unica linea del tempo.
// Da ogni punto vedi le modifiche o ci riporti la cartella (annullabile).
import { useEffect, useState } from 'react'
import { GitCommitHorizontal, History, MessageSquare, Undo2 } from 'lucide-react'
import type { HistoryEntry, SessionSummary } from '@shared/protocol'
import { relativeAge } from '@/lib/session-state'
import { request } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { PanelNote } from './changes-panel'
import { useRestore } from './use-restore'

interface HistoryPanelProps {
  projectId: string
  root: string
  isGit: boolean
  session: SessionSummary | null
}

export function HistoryPanel({ projectId, root, isGit, session }: HistoryPanelProps) {
  const [onlySession, setOnlySession] = useState(true)
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const version = useApp((s) => s.fsVersion[root] ?? 0)
  const updatedAt = useApp((s) => (session ? s.sessions[session.id]?.updatedAt : 0))
  const openInspector = useApp((s) => s.openInspector)
  const { restore, busy, banner } = useRestore(root)
  const sessionId = session && onlySession ? session.id : null

  useEffect(() => {
    if (!isGit) return
    let cancelled = false
    request<HistoryEntry[]>({ type: 'history.list', root, sessionId })
      .then((data) => {
        if (!cancelled) {
          setEntries(data)
          setError(null)
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [root, sessionId, isGit, version, updatedAt])

  if (!isGit) return <PanelNote>La cronologia usa git: questa cartella non è un repository.</PanelNote>
  const running = session ? session.run === 'running' || session.run === 'waiting' : false

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {session && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5 text-[12.5px]" role="radiogroup" aria-label="Cosa mostrare">
          {[
            { id: true, label: 'Questa sessione' },
            { id: false, label: 'Tutta la cartella' }
          ].map((o) => (
            <button
              key={String(o.id)}
              type="button"
              role="radio"
              aria-checked={onlySession === o.id}
              onClick={() => setOnlySession(o.id)}
              className={cn('h-6 rounded-md px-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50', onlySession === o.id ? 'bg-accent font-medium' : 'text-muted-foreground')}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <PanelNote tone="error">{error}</PanelNote>}
        {!entries && !error && <p className="px-3 py-2 text-[12px] text-muted-foreground">Leggo la cronologia…</p>}
        {entries?.length === 0 && <PanelNote>Ancora niente: i checkpoint arrivano con il primo messaggio della sessione.</PanelNote>}
        <ol className="flex flex-col">
          {entries?.map((entry) => {
            const Icon = entry.kind === 'commit' ? GitCommitHorizontal : entry.kind === 'restore' ? History : MessageSquare
            const kindLabel = entry.kind === 'commit' ? 'Commit' : entry.kind === 'restore' ? 'Ripristino' : 'Prima della richiesta'
            return (
              <li key={entry.id} className="group border-b border-border px-3 py-2">
                <div className="flex items-start gap-2">
                  <Icon aria-label={kindLabel} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px]" title={entry.title}>
                      {entry.title}
                    </p>
                    <p className="truncate text-[11.5px] text-muted-foreground">
                      {kindLabel}
                      {entry.kind === 'commit' && ` · ${entry.sha.slice(0, 7)}`}
                      {entry.detail && ` · ${entry.detail}`}
                      {entry.files !== null && ` · ${entry.files === 1 ? '1 file' : `${entry.files} file`}`} · {relativeAge(entry.at)}
                    </p>
                  </div>
                </div>
                <div className="mt-1 flex gap-1 pl-5.5 opacity-70 group-focus-within:opacity-100 group-hover:opacity-100">
                  {entry.diff && (
                    <button
                      type="button"
                      onClick={() =>
                        openInspector(projectId, 'changes', {
                          scope:
                            entry.kind === 'commit'
                              ? { kind: 'commit', sha: entry.sha }
                              : entry.turnId && entry.sessionId
                                ? { kind: 'turn', sessionId: entry.sessionId, turnId: entry.turnId }
                                : { kind: 'range', from: entry.diff!.from, to: entry.diff!.to, label: entry.title }
                        })
                      }
                      className="h-6 rounded-md px-1.5 text-[12px] text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      Vedi modifiche
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={running || busy}
                    title={running ? 'La sessione sta lavorando: fermala prima di ripristinare.' : 'Riporta tutti i file a questo punto. Puoi annullare.'}
                    onClick={() => void restore(entry.sha, undefined, `Riportato a “${entry.title.slice(0, 40)}”`)}
                    className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40"
                  >
                    <Undo2 className="size-3" />
                    Ripristina qui
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
      {banner}
    </div>
  )
}
