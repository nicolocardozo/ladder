import type { PointerEvent as ReactPointerEvent } from 'react'
import { Bot, CircleAlert, FileText, Globe, Plus, X } from 'lucide-react'
import { fileTabId } from '@shared/file-tabs'
import type { AgentBrowserState } from '@shared/protocol'
import { t } from '@shared/i18n'
import { shortcutLabel } from '@shared/shortcuts'
import { SessionMenuContent } from '@/components/session-menu'
import { AgentMark } from '@/components/agent-mark'
import { SessionGlyph } from '@/components/status'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agentStatusText, hasAgentTab } from '@/lib/browser-agent'
import { canDropOnEdge, overSplitEdge } from '@/components/split-view'
import { startSortDrag } from '@/lib/pointer-drag'
import { isMac } from '@/lib/send-key'
import { needsYou, sessionState } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { browserColumnActive, isBrowserColumnOpen, liveColumns, useApp } from '@/store/app-store'

const NO_TABS: string[] = []
const NO_FILES: { root: string; path: string }[] = []

/**
 * Tabs for the sessions and files open in the project. Closing a tab does not stop the session. Right click: the session's actions.
 * Browser pages are not here: they live in the browser column on the right (components/browser/browser-column.tsx).
 * They are reordered by dragging (chats among chats, files among files) or with ⌘⌥⇧← and ⌘⌥⇧→ on the active tab.
 */
export function TabBar({ projectId, activeSessionId, activeFile }: { projectId: string; activeSessionId: string | null; activeFile?: string }) {
  // The fallback must be a constant: zustand 5 compares selector results by reference.
  const tabs = useApp((s) => s.ui[projectId]?.tabs ?? NO_TABS)
  const files = useApp((s) => s.ui[projectId]?.fileTabs ?? NO_FILES)
  const agentBrowser = useApp((s) => s.agentBrowser)
  const agentForeign = useApp((s) => s.agentForeign)
  const dirtyFiles = useApp((s) => s.dirtyFiles)
  const openFile = useApp((s) => s.openFile)
  const closeFile = useApp((s) => s.closeFile)
  const sessions = useApp((s) => s.sessions)
  const project = useApp((s) => s.projects.find((p) => p.id === projectId) ?? null)
  const select = useApp((s) => s.select)
  const closeTab = useApp((s) => s.closeTab)
  const projects = useApp((s) => s.projects)
  const ui = useApp((s) => s.ui)
  const openSplit = useApp((s) => s.openSplit)
  const closeColumn = useApp((s) => s.closeColumn)
  const reorderTab = useApp((s) => s.reorderTab)
  const visible = tabs.filter((id) => sessions[id] && !sessions[id].archived)
  // Split columns of the project (empty if there is no split).
  const columns = liveColumns({ projects, sessions, ui }, projectId)
  // ⌘click (Ctrl outside macOS) on a chat tab: adds it to the columns or, if already there, removes it. The click after a drag is absorbed elsewhere.
  const toggleColumn = (id: string) => {
    if (columns.includes(id)) closeColumn(projectId, id)
    else openSplit(projectId, id)
  }
  // A request in another session of the same project: no notification, a notice here with "Go".
  const waitingHere = Object.values(sessions)
    .filter((s) => s.projectId === projectId && !s.archived && !s.parent && needsYou(s) && s.id !== activeSessionId)
    .sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0))

  // Browser of this project's agents: their pages live in the browser column; only the notice stays here.
  const agentTabs = Object.values(agentBrowser)
    .filter((agent): agent is AgentBrowserState & { tabId: string } => agent.projectId === projectId && hasAgentTab(agent) && agentForeign[agent.sessionId] !== agent.tabId && Boolean(sessions[agent.sessionId]) && !sessions[agent.sessionId].archived)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  // An agent working in the browser while the column does not show its page: a discreet notice with "Show" (opens the column on that page).
  const columnActive = useApp((s) => (isBrowserColumnOpen(s, projectId) ? browserColumnActive(s, projectId) : null))
  const agentWorking = agentTabs.filter((agent) => agent.action && agent.tabId !== columnActive)

  // A single listener on the row: from the pointerdown it knows which tab it is and who its siblings are.
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (event.button !== 0 || event.ctrlKey || target.closest('[data-tab-close]')) return
    const tab = target.closest<HTMLElement>('[data-tab-id]')
    const id = tab?.dataset.tabId
    if (!tab || !id) return
    const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`[data-tab-kind="${tab.dataset.tabKind}"]`))
    // A chat tab dragged onto the right or bottom edge of the view opens in a new column. Files do not.
    const splittable = tab.dataset.tabKind === 'session' && canDropOnEdge(projectId, id)
    const { setSplitDrop, openSplit } = useApp.getState()
    startSortDrag({
      event: event.nativeEvent,
      nodes,
      index: nodes.indexOf(tab),
      onCommit: (_from, to) => reorderTab(projectId, id, to),
      onMove: (move) => splittable && setSplitDrop(overSplitEdge(move)),
      onRelease: (up) => {
        setSplitDrop(false)
        if (!splittable || !overSplitEdge(up)) return false
        openSplit(projectId, id, { at: 'end' })
        return true
      },
      onCancel: () => setSplitDrop(false)
    })
  }

  return (
    <div className="no-drag flex min-w-0 items-center gap-0.5">
      {/* Screen reader announcement of the agent working in the browser; with its page in view the column already says it. */}
      <span role="status" className="sr-only">
        {agentWorking[0] ? agentStatusText(agentWorking[0]) : ''}
      </span>
      <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto no-scrollbar" role="tablist" aria-label={t('Open sessions')} onPointerDown={startDrag}>
      {visible.map((id) => {
        const session = sessions[id]
        const active = id === activeSessionId
        const column = columns.indexOf(id) + 1
        return (
          <ContextMenu key={id}>
            <ContextMenuTrigger
              role="tab"
              data-tab-id={id}
              data-tab-kind="session"
              aria-selected={active}
              className={cn(
                'group flex h-7 max-w-[180px] min-w-[84px] shrink items-center gap-1 rounded-md pr-0.5 pl-2 text-sm text-muted-foreground select-none data-[dragging=true]:bg-accent',
                active ? 'bg-accent text-foreground' : 'hover:bg-accent/60 data-[popup-open]:bg-accent/60'
              )}
            >
              <button
                type="button"
                onClick={(event) => {
                  // On macOS Ctrl+click is the right click: it stays with the menu.
                  if (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey) {
                    toggleColumn(id)
                    return
                  }
                  select({ kind: 'session', projectId, sessionId: id })
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5 outline-none focus-visible:underline"
                title={session.titleGenerating ? `${session.title} · ${t('Generating title…')}` : session.title}
              >
                {/* At rest the provider mark; when it works or waits for you, the status. */}
                <span className="grid w-3.5 shrink-0 place-items-center">
                  {sessionState(session) === 'idle' ? <AgentMark agent={session.agent} size={13} /> : <SessionGlyph state={sessionState(session)} />}
                </span>
                <span className={cn('truncate', active && 'font-medium', session.titleGenerating && 'animate-pulse motion-reduce:animate-none')}>{session.title}</span>
                {agentBrowser[id]?.action && <Globe role="img" aria-label={t('The agent is using the browser')} className="size-3 shrink-0 text-running" strokeWidth={2} />}
                {/* Split column: the number (besides the color) says which one; filled if it is the active column. */}
                {column > 0 && (
                  <span
                    role="img"
                    aria-label={t('In column {n} of {total}', { n: column, total: columns.length })}
                    className={cn('grid size-4 shrink-0 place-items-center rounded-[4px] border text-[10px] leading-none font-semibold tabular-nums', active ? 'border-transparent bg-foreground text-background' : 'border-border text-foreground')}
                  >
                    {column}
                  </span>
                )}
              </button>
              <button
                type="button"
                data-tab-close
                aria-label={t('Close {title}', { title: session.title })}
                onClick={() => closeTab(projectId, id)}
                className={cn(
                  'grid size-[18px] shrink-0 place-items-center rounded text-faint outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
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
          <div key={id} role="tab" data-tab-id={id} data-tab-kind="file" aria-selected={active} className={cn('group flex h-7 max-w-[180px] min-w-[84px] shrink items-center gap-1 rounded-md pr-0.5 pl-2 text-sm text-muted-foreground select-none data-[dragging=true]:bg-accent', active ? 'bg-accent text-foreground' : 'hover:bg-accent/60')}>
            <button type="button" onClick={() => openFile(projectId, file.root, file.path)} className="flex min-w-0 flex-1 items-center gap-1.5 outline-none focus-visible:underline" title={`${file.root}/${file.path}`}>
              <FileText aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
              <span className={cn('truncate', active && 'font-medium')}>{name}</span>
            </button>
            <button
              type="button"
              data-tab-close
              aria-label={t('Close {title}', { title: name })}
              onClick={() => closeFile(projectId, file.root, file.path)}
              className={cn('grid size-[18px] shrink-0 place-items-center rounded text-faint outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50', !active && !dirty && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
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
      {agentWorking.length > 0 && (
        <button
          type="button"
          onClick={() => useApp.getState().showAgentBrowser(agentWorking[0].sessionId)}
          title={agentWorking.map((agent) => `${sessions[agent.sessionId]?.title ?? ''}: ${agentStatusText(agent)}`).join('\n')}
          className="ml-1 flex h-7 max-w-[260px] min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Bot aria-hidden className="size-3 shrink-0 text-running" strokeWidth={2} />
          <span className="truncate">{agentWorking.length === 1 ? agentStatusText(agentWorking[0]) : t('{n} agents are using the browser', { n: agentWorking.length })}</span>
          <span className="shrink-0 font-semibold">{t('Show')}</span>
        </button>
      )}
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
        // Only a new chat: split and browser are on the right of the bar (top-bar-actions).
        <Tooltip>
          <TooltipTrigger
            aria-label={t('New chat')}
            onClick={() => select({ kind: 'new', projectId })}
            className="no-drag grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Plus className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t('New chat')} <Kbd className="ml-1">{shortcutLabel('chat.new')}</Kbd>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
