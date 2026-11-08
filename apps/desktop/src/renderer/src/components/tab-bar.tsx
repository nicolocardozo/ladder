import { CircleAlert, FileText, Plus, X } from 'lucide-react'
import { fileTabId } from '@shared/file-tabs'
import { t } from '@shared/i18n'
import { SessionMenuContent } from '@/components/session-menu'
import { AgentMark } from '@/components/agent-mark'
import { SessionGlyph } from '@/components/status'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { sessionState } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

const NO_TABS: string[] = []
const NO_FILES: { root: string; path: string }[] = []

/** Tab delle sessioni aperte nel progetto. Chiudere una tab non ferma la sessione. Clic destro: le azioni della sessione. */
export function TabBar({ projectId, activeSessionId, activeFile }: { projectId: string; activeSessionId: string | null; activeFile?: string }) {
  // Il ripiego deve essere una costante: zustand 5 confronta i risultati del selettore per riferimento.
  const tabs = useApp((s) => s.ui[projectId]?.tabs ?? NO_TABS)
  const files = useApp((s) => s.ui[projectId]?.fileTabs ?? NO_FILES)
  const dirtyFiles = useApp((s) => s.dirtyFiles)
  const openFile = useApp((s) => s.openFile)
  const closeFile = useApp((s) => s.closeFile)
  const sessions = useApp((s) => s.sessions)
  const project = useApp((s) => s.projects.find((p) => p.id === projectId) ?? null)
  const select = useApp((s) => s.select)
  const closeTab = useApp((s) => s.closeTab)
  const visible = tabs.filter((id) => sessions[id] && !sessions[id].archived)
  // Una richiesta in un'altra sessione dello stesso progetto: niente notifica, un avviso qui con "Vai".
  const waitingHere = Object.values(sessions)
    .filter((s) => s.projectId === projectId && !s.archived && s.run === 'waiting' && s.id !== activeSessionId)
    .sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0))

  return (
    <div className="no-drag flex min-w-0 items-center gap-0.5">
      <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label={t('Open sessions')}>
      {visible.map((id) => {
        const session = sessions[id]
        const active = id === activeSessionId
        return (
          <ContextMenu key={id}>
            <ContextMenuTrigger
              role="tab"
              aria-selected={active}
              className={cn(
                'group flex h-7 max-w-[180px] min-w-[84px] shrink items-center gap-1.5 rounded-md pr-1 pl-2 text-sm text-muted-foreground select-none',
                active ? 'bg-accent text-foreground' : 'hover:bg-accent/60 data-[popup-open]:bg-accent/60'
              )}
            >
              <button
                type="button"
                onClick={() => select({ kind: 'session', projectId, sessionId: id })}
                className="flex min-w-0 items-center gap-1.5 outline-none focus-visible:underline"
                title={session.title}
              >
                {/* A riposo il segno del provider; quando lavora o ti aspetta, lo stato. */}
                <span className="grid w-3.5 shrink-0 place-items-center">
                  {sessionState(session) === 'idle' ? <AgentMark agent={session.agent} size={13} /> : <SessionGlyph state={sessionState(session)} />}
                </span>
                <span className={cn('truncate', active && 'font-medium')}>{session.title}</span>
              </button>
              <button
                type="button"
                aria-label={t('Close {title}', { title: session.title })}
                onClick={() => closeTab(projectId, id)}
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded text-faint outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                  !active && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                )}
              >
                <X className="size-3" />
              </button>
            </ContextMenuTrigger>
            <SessionMenuContent variant="context" session={session} project={project} />
          </ContextMenu>
        )
      })}
      {files.map((file) => {
        const id = fileTabId(file.root, file.path)
        const active = id === activeFile
        const dirty = Boolean(dirtyFiles[id])
        const name = file.path.split('/').pop() ?? file.path
        return (
          <div key={id} role="tab" aria-selected={active} className={cn('group flex h-7 max-w-[180px] min-w-[84px] shrink items-center gap-1.5 rounded-md pr-1 pl-2 text-sm text-muted-foreground select-none', active ? 'bg-accent text-foreground' : 'hover:bg-accent/60')}>
            <button type="button" onClick={() => openFile(projectId, file.root, file.path)} className="flex min-w-0 items-center gap-1.5 outline-none focus-visible:underline" title={`${file.root}/${file.path}`}>
              <FileText aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
              <span className={cn('truncate', active && 'font-medium')}>{name}</span>
            </button>
            <button
              type="button"
              aria-label={t('Close {title}', { title: name })}
              onClick={() => closeFile(projectId, file.root, file.path)}
              className={cn('grid size-5 shrink-0 place-items-center rounded text-faint outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50', !active && !dirty && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
            >
              {dirty && <span aria-label={t('Unsaved')} className="block size-2 rounded-full bg-foreground/70 group-hover:hidden" />}
              <X className={cn('size-3', dirty && 'hidden group-hover:block')} />
            </button>
          </div>
        )
      })}
      {activeSessionId === null && !activeFile && (visible.length > 0 || files.length > 0) && (
        <div role="tab" aria-selected className="flex h-7 shrink-0 items-center rounded-md bg-accent px-2.5 text-xs font-medium text-foreground">
          {t('New chat')}
        </div>
      )}
      </div>
      {waitingHere.length > 0 && (
        <button
          type="button"
          onClick={() => useApp.getState().openSessionAt(waitingHere[0].id, waitingHere[0].request?.id ?? null)}
          title={waitingHere.map((s) => `${s.title}: ${s.waitingLabel ?? t('request')}`).join('\n')}
          className="ml-1 flex h-7 max-w-[260px] min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-attention/50 px-2 text-xs text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <CircleAlert aria-hidden className="size-3 shrink-0 text-attention" strokeWidth={2.2} />
          <span className="truncate">
            {waitingHere.length === 1
              ? `${waitingHere[0].title} · ${waitingHere[0].waitingLabel ?? t('Needs you')}`
              : t('{n} requests in this project', { n: waitingHere.length })}
          </span>
          <span className="shrink-0 font-semibold text-attention">{t('Go')}</span>
        </button>
      )}
      {(visible.length > 0 || files.length > 0) && (
        <button
          type="button"
          aria-label={t('New chat')}
          onClick={() => select({ kind: 'new', projectId })}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Plus className="size-3.5" />
        </button>
      )}
    </div>
  )
}
