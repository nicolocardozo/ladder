// Ispettore a destra: Modifiche (⌘⌥1), File (⌘⌥2), Cronologia (⌘⌥3), Merge (⌘⌥4) sulla cartella della sessione.
import { shortcutLabel, type CommandId } from '@shared/shortcuts'
import { useShortcutsRevision } from '@/lib/use-shortcuts'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FolderOpen, FolderSearch, X } from 'lucide-react'
import { IconButton } from '@/components/icon-button'
import type { ChatItem, InspectorTab, SessionSummary } from '@shared/protocol'
import { send } from '@/lib/host-client'
import { clamp, INSPECTOR_WIDTH, MIN_CONTENT_WIDTH, readSize, writeSize } from '@/lib/panel-size'
import { ResizeHandle } from '@/components/resize-handle'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { t } from '@shared/i18n'
import { ChangesPanel } from './changes-panel'
import { FilesPanel } from './files-panel'
import { HistoryPanel } from './history-panel'
import { MergePanel } from './merge-panel'

const NO_ITEMS: ChatItem[] = []

const TABS: { id: InspectorTab; label: string; command: CommandId }[] = [
  { id: 'changes', label: 'Changes', command: 'inspector.changes' },
  { id: 'files', label: 'Files', command: 'inspector.files' },
  { id: 'history', label: 'History', command: 'inspector.history' },
  { id: 'merge', label: 'Merge', command: 'inspector.merge' }
]

const readWidth = () => readSize(INSPECTOR_WIDTH.key, INSPECTOR_WIDTH.default, INSPECTOR_WIDTH.min, Infinity)

interface InspectorProps {
  projectId: string
  root: string
  isGit: boolean
  session: SessionSummary | null
  composerKey: string | null
}

export function Inspector({ projectId, root, isGit, session, composerKey }: InspectorProps) {
  useShortcutsRevision()
  const tab = useApp((s) => s.ui[projectId]?.inspector?.tab ?? 'changes')
  const toggle = useApp((s) => s.toggleInspector)
  const items = useApp((s) => (session ? (s.items[session.id] ?? NO_ITEMS) : NO_ITEMS))
  const openRequest = useApp((s) => (s.inspectorRequest?.projectId === projectId ? s.inspectorRequest : null))
  const [width, setWidth] = useState(readWidth)
  // Tutte le schede guardano la stessa cartella: il checkout del progetto o il worktree della sessione.
  const projectName = useApp((s) => s.projects.find((p) => p.id === projectId)?.name ?? null)
  const projectBranch = useApp((s) => s.projects.find((p) => p.id === projectId)?.branch ?? null)
  const where = session?.worktree ? t('worktree {branch}', { branch: session.worktree.branch }) : (session?.branch ?? projectBranch)

  // L'host osserva la cartella finché l'ispettore è aperto: albero, stato e diff "attuali" si aggiornano da soli.
  useEffect(() => {
    send({ type: 'fs.watch', root, on: true })
    return () => send({ type: 'fs.watch', root, on: false })
  }, [root])

  // LAD-75: durante il trascinamento si ritocca il DOM; lo stato e la memoria si aggiornano a fine gesto.
  const panel = useRef<HTMLElement>(null)
  const maxWidth = () => {
    const room = (panel.current?.parentElement?.clientWidth ?? window.innerWidth) - MIN_CONTENT_WIDTH
    return Math.max(INSPECTOR_WIDTH.min, Math.min(Math.round(window.innerWidth * 0.62), room))
  }
  const preview = (value: number) => {
    if (panel.current) panel.current.style.width = `${Math.round(value)}px`
  }
  const commit = (value: number) => {
    const next = clamp(Math.round(value), INSPECTOR_WIDTH.min, maxWidth())
    preview(next)
    writeSize(INSPECTOR_WIDTH.key, next)
    setWidth(next)
  }

  let body: ReactNode
  if (tab === 'changes') body = <ChangesPanel key={root} projectId={projectId} root={root} isGit={isGit} session={session} items={items} request={openRequest} />
  else if (tab === 'files') body = <FilesPanel key={root} projectId={projectId} root={root} items={items} composerKey={composerKey} request={openRequest} />
  else if (tab === 'history') body = <HistoryPanel key={root} projectId={projectId} root={root} isGit={isGit} session={session} />
  else body = <MergePanel key={root} projectId={projectId} root={root} isGit={isGit} session={session} />

  return (
    <aside ref={panel} aria-label={t('Inspector')} className="relative flex shrink-0 flex-col border-l border-border bg-background" style={{ width, minWidth: INSPECTOR_WIDTH.min, maxWidth: `calc(100% - ${MIN_CONTENT_WIDTH}px)` }}>
      <ResizeHandle
        label={t('Resize inspector')}
        invert
        value={width}
        min={INSPECTOR_WIDTH.min}
        max={maxWidth()}
        measure={() => ({ value: panel.current?.getBoundingClientRect().width ?? width, min: INSPECTOR_WIDTH.min, max: maxWidth() })}
        onPreview={preview}
        onCommit={commit}
        onReset={() => commit(INSPECTOR_WIDTH.default)}
        className="absolute inset-y-0 -left-1"
      />
      <div className="drag flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-2" role="tablist" aria-label={t('Inspector panels')}>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            title={shortcutLabel(item.command) ? `${t(item.label)} (${shortcutLabel(item.command)})` : t(item.label)}
            onClick={() => tab !== item.id && toggle(projectId, item.id)}
            className={cn(
              'no-drag h-7 rounded-md px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              tab === item.id ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            )}
          >
            {t(item.label)}
          </button>
        ))}
        <button
          type="button"
          aria-label={t('Close inspector')}
          title={t('Close')}
          onClick={() => toggle(projectId)}
          className="no-drag ml-auto grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border pr-1 pl-3 text-xs text-muted-foreground" title={root}>
        <FolderOpen aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground">{projectName}</span>
          {where ? ` · ${where}` : ''}
        </span>
        <IconButton icon={FolderSearch} label={t('Show in Finder')} onClick={() => void window.ladder?.reveal(root)} className="ml-auto size-6 hover:bg-accent" />
      </div>
      {body}
    </aside>
  )
}
