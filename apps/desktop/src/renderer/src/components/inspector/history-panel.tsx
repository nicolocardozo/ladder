// Cronologia: checkpoint presi prima di ogni richiesta, ripristini e commit in un'unica linea del tempo.
// Da ogni punto vedi le modifiche o ci riporti la cartella (annullabile).
import { useEffect, useState } from 'react'
import { GitCommitHorizontal, History, MessageSquare, Undo2 } from 'lucide-react'
import type { HistoryEntry, SessionSummary } from '@shared/protocol'
import { relativeAge } from '@/lib/session-state'
import { request } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { plural, t } from '@shared/i18n'
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

  if (!isGit) return <PanelNote>{t('History uses git, and this folder isn’t a repository.')}</PanelNote>
  const running = session ? session.run === 'running' || session.run === 'waiting' : false

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {session && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5 text-sm" role="radiogroup" aria-label={t('What to show')}>
          {[
            { id: true, label: t('This session') },
            { id: false, label: t('Whole folder') }
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
        {!entries && !error && <p className="px-3 py-2 text-xs text-muted-foreground">{t('Reading history…')}</p>}
        {entries?.length === 0 && <PanelNote>{t('Nothing yet. Checkpoints start with the session’s first message.')}</PanelNote>}
        <ol className="flex flex-col">
          {entries?.map((entry) => {
            const Icon = entry.kind === 'commit' ? GitCommitHorizontal : entry.kind === 'restore' ? History : MessageSquare
            const kindLabel = entry.kind === 'commit' ? t('Commit') : entry.kind === 'restore' ? t('Restored') : t('Before the request')
            return (
              <li key={entry.id} className="group border-b border-border px-3 py-2">
                <div className="flex items-start gap-2">
                  <Icon aria-label={kindLabel} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm" title={entry.title}>
                      {entry.title}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {kindLabel}
                      {entry.kind === 'commit' && ` · ${entry.sha.slice(0, 7)}`}
                      {entry.detail && ` · ${entry.detail}`}
                      {entry.files !== null && ` · ${plural(entry.files, '{n} file', '{n} files')}`} · {relativeAge(entry.at)}
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
                      className="h-6 rounded-md px-1.5 text-xs text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {t('View changes')}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={running || busy}
                    title={running ? t('The session is working. Stop it before restoring.') : t('Restore all files to this point. You can undo.')}
                    onClick={() => void restore(entry.sha, undefined, t('Restored to “{title}”', { title: entry.title.slice(0, 40) }))}
                    className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40"
                  >
                    <Undo2 className="size-3" />
                    {t('Restore here')}
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
