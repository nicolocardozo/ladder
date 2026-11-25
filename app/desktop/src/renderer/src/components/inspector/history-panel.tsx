// History: checkpoints taken before each request, restores and commits in a single vertical timeline.
// Same graphics as the Branches tab: one line, dots with a ring in the background color, a single color; the shape tells the type.
// From each point you see the changes or restore the folder to it (undoable).
import { useEffect, useMemo, useState } from 'react'
import { ArrowUp, ChevronRight, GitBranch, Undo2 } from 'lucide-react'
import type { HistoryEntry, SessionSummary } from '@shared/protocol'
import { relativeAge } from '@/lib/session-state'
import { request } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { plural, t } from '@shared/i18n'
import { useBranchMap } from './branch-map'
import { PanelNote } from './changes-panel'
import { useRestore } from './use-restore'

// Drawing geometry: the line sits at RAIL, the dot center at DOT_Y (on the first text row), the text starts after GUTTER.
const RAIL = 14
const DOT_Y = 17
const GUTTER = 34

const ringed = { paintOrder: 'stroke' } as const

/** Entry type mark: checkpoint = small filled dot, commit = larger filled dot with an empty center, restore = diamond. */
function EntryMark({ kind }: { kind: HistoryEntry['kind'] }) {
  return (
    <svg aria-hidden width={20} height={20} viewBox="0 0 20 20" className="pointer-events-none absolute text-primary" style={{ left: RAIL - 10, top: DOT_Y - 10 }}>
      {kind === 'commit' ? (
        <>
          <circle cx={10} cy={10} r={5} fill="currentColor" className="stroke-background" strokeWidth={3} style={ringed} />
          <circle cx={10} cy={10} r={1.8} className="fill-background" />
        </>
      ) : kind === 'restore' ? (
        <rect x={6} y={6} width={8} height={8} rx={1.5} transform="rotate(45 10 10)" fill="currentColor" className="stroke-background" strokeWidth={3} style={ringed} />
      ) : (
        <circle cx={10} cy={10} r={3.5} fill="currentColor" className="stroke-background" strokeWidth={3} style={ringed} />
      )}
    </svg>
  )
}

/** On top: "<branch> · from <base> ↑N", if the session is on a branch other than the main one. Clicking opens the Branches tab. */
function BranchLine({ projectId, session }: { projectId: string; session: SessionSummary }) {
  const map = useBranchMap(projectId, true)
  const openInspector = useApp((s) => s.openInspector)
  const inMain = !session.worktree
  const entry = useMemo(() => {
    if (!map) return null
    // On the main checkout the main checkout row applies (it carries the id of the most recent session, not always this one).
    return map.entries.find((e) => (inMain ? e.mainCheckout : e.sessionId === session.id)) ?? null
  }, [map, inMain, session.id])
  if (!map || !entry || entry.isBase || !entry.branch || !map.base) return null
  const ahead = entry.ahead ?? 0
  const label = `${entry.branch}, ${t('from {base}', { base: map.base })}, ${plural(ahead, '{n} commit ahead of {base}', '{n} commits ahead of {base}', { base: map.base })}`
  return (
    <button
      type="button"
      aria-label={`${label}. ${t('Open the Branches tab')}`}
      title={t('Open the Branches tab')}
      onClick={() => openInspector(projectId, 'merge')}
      className="flex h-8 w-full shrink-0 items-center gap-1.5 border-b border-border px-3 text-left text-xs text-muted-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
    >
      <GitBranch aria-hidden className="size-3.5 shrink-0" />
      <span aria-hidden className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate font-mono font-medium text-foreground">{entry.branch}</span>
        <span>·</span>
        <span className="shrink-0 whitespace-nowrap">{t('from {base}', { base: map.base })}</span>
        {ahead > 0 && (
          <span className="inline-flex shrink-0 items-center tabular-nums">
            <ArrowUp className="size-3" strokeWidth={2} />
            {ahead}
          </span>
        )}
      </span>
      <ChevronRight aria-hidden className="ml-auto size-3.5 shrink-0" />
    </button>
  )
}

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
      {session && <BranchLine projectId={projectId} session={session} />}
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
        <ol className="flex flex-col py-1">
          {entries?.map((entry, index) => {
            const kindLabel = entry.kind === 'commit' ? t('Commit') : entry.kind === 'restore' ? t('Restored') : t('Before the request')
            const first = index === 0
            const last = index === entries.length - 1
            return (
              <li key={entry.id} className="group relative py-1.5 pr-3" style={{ paddingLeft: GUTTER }}>
                {/* One line segment per entry: the first starts at its dot, the last ends at its own. */}
                {!(first && last) && <span aria-hidden className="absolute w-0.5" style={{ left: RAIL - 1, top: first ? DOT_Y : 0, bottom: last ? `calc(100% - ${DOT_Y}px)` : 0, background: 'color-mix(in oklab, var(--muted-foreground) 45%, var(--background))' }} />}
                <EntryMark kind={entry.kind} />
                <p className="truncate text-sm leading-[18px]" title={entry.title}>
                  {entry.title}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {kindLabel}
                  {entry.kind === 'commit' && ` · ${entry.sha.slice(0, 7)}`}
                  {entry.detail && ` · ${entry.detail}`}
                  {entry.files !== null && ` · ${plural(entry.files, '{n} file', '{n} files')}`} · {relativeAge(entry.at)}
                </p>
                <div className="mt-1 -ml-1.5 flex gap-1 opacity-70 group-focus-within:opacity-100 group-hover:opacity-100">
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
                    className="inline-flex h-6 items-center whitespace-nowrap gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40"
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
