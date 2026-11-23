import type { PointerEvent as ReactPointerEvent } from 'react'
import { Bot, CircleAlert, Columns2, FileText, Globe, OctagonX, Plus, X } from 'lucide-react'
import { fileTabId } from '@shared/file-tabs'
import type { AgentBrowserState } from '@shared/protocol'
import { t } from '@shared/i18n'
import { shortcutLabel } from '@shared/shortcuts'
import { SessionMenuContent } from '@/components/session-menu'
import { AgentMark } from '@/components/agent-mark'
import { SessionGlyph } from '@/components/status'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agentStatusText, hasAgentTab } from '@/lib/browser-agent'
import { browserAddress, browserTabLabel } from '@/lib/browser-tabs'
import { canDropOnEdge, overSplitEdge } from '@/components/split-view'
import { startSortDrag } from '@/lib/pointer-drag'
import { isMac } from '@/lib/send-key'
import { sessionState } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { MAX_COLUMNS, liveColumns, splitCandidate, useApp } from '@/store/app-store'

const NO_TABS: string[] = []
const NO_FILES: { root: string; path: string }[] = []
const NO_BROWSERS: { id: string; url: string; title?: string }[] = []

/**
 * Tab delle sessioni aperte nel progetto. Chiudere una tab non ferma la sessione. Clic destro: le azioni della sessione.
 * Si riordinano trascinandole (chat tra chat, file tra file, browser tra browser) o con ⌘⌥⇧← e ⌘⌥⇧→ sulla tab attiva.
 */
export function TabBar({ projectId, activeSessionId, activeFile, activeBrowser }: { projectId: string; activeSessionId: string | null; activeFile?: string; activeBrowser?: string }) {
  // Il ripiego deve essere una costante: zustand 5 confronta i risultati del selettore per riferimento.
  const tabs = useApp((s) => s.ui[projectId]?.tabs ?? NO_TABS)
  const files = useApp((s) => s.ui[projectId]?.fileTabs ?? NO_FILES)
  const browsers = useApp((s) => s.ui[projectId]?.browserTabs ?? NO_BROWSERS)
  const browserStates = useApp((s) => s.browserStates)
  const agentBrowser = useApp((s) => s.agentBrowser)
  const agentForeign = useApp((s) => s.agentForeign)
  const dirtyFiles = useApp((s) => s.dirtyFiles)
  const openBrowser = useApp((s) => s.openBrowser)
  const closeBrowser = useApp((s) => s.closeBrowser)
  const openFile = useApp((s) => s.openFile)
  const closeFile = useApp((s) => s.closeFile)
  const sessions = useApp((s) => s.sessions)
  const project = useApp((s) => s.projects.find((p) => p.id === projectId) ?? null)
  const select = useApp((s) => s.select)
  const closeTab = useApp((s) => s.closeTab)
  const projects = useApp((s) => s.projects)
  const ui = useApp((s) => s.ui)
  const selection = useApp((s) => s.selection)
  const openSplit = useApp((s) => s.openSplit)
  const closeColumn = useApp((s) => s.closeColumn)
  const splitActive = useApp((s) => s.splitActive)
  const reorderTab = useApp((s) => s.reorderTab)
  const visible = tabs.filter((id) => sessions[id] && !sessions[id].archived)
  // Colonne affiancate del progetto (vuoto se non c'è divisione) e perché il pulsante Affianca può essere spento.
  const columns = liveColumns({ projects, sessions, ui }, projectId)
  const currentId = selection.kind === 'session' && selection.projectId === projectId ? selection.sessionId : null
  const splitBlocked =
    columns.length >= MAX_COLUMNS
      ? t('Maximum three columns')
      : !currentId
        ? t('Open a chat tab to split')
        : null
  // Senza altre chat aperte il pulsante fa come ⌘\: apre una chat nuova in colonna.
  const hasCandidate = currentId !== null && splitCandidate({ projects, sessions, ui }, projectId, currentId) !== undefined
  const modKey = isMac ? '⌘' : 'Ctrl'
  // ⌘clic (Ctrl fuori da macOS) su una tab di chat: la aggiunge alle colonne o, se c'è già, la toglie. Il clic dopo un trascinamento è assorbito altrove.
  const toggleColumn = (id: string) => {
    if (columns.includes(id)) closeColumn(projectId, id)
    else openSplit(projectId, id)
  }
  // Una richiesta in un'altra sessione dello stesso progetto: niente notifica, un avviso qui con "Vai".
  const waitingHere = Object.values(sessions)
    .filter((s) => s.projectId === projectId && !s.archived && s.run === 'waiting' && s.id !== activeSessionId)
    .sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0))

  // Tab dei browser degli agenti di questo progetto: effimere, non salvate e fuori dalle colonne affiancate.
  const agentTabs = Object.values(agentBrowser)
    .filter((agent): agent is AgentBrowserState & { tabId: string } => agent.projectId === projectId && hasAgentTab(agent) && agentForeign[agent.sessionId] !== agent.tabId && Boolean(sessions[agent.sessionId]) && !sessions[agent.sessionId].archived)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  // Browser dell'agente fermato (stop esplicito o tab chiusa): dal menu "+" si riattiva.
  const stoppedAgents = Object.values(agentBrowser).filter((agent) => agent.projectId === projectId && agent.enabled && !agent.closed && agent.stopped && Boolean(sessions[agent.sessionId]) && !sessions[agent.sessionId].archived)
  // Un agente al lavoro nel browser mentre si guarda altro: avviso discreto con "Mostra". Se la sua tab è quella aperta basta la tab.
  const agentWorking = agentTabs.filter((agent) => agent.action && agent.tabId !== activeBrowser)

  // Un solo ascoltatore sulla fila: dal pointerdown si sa quale tab è e quali sono le sue pari.
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (event.button !== 0 || event.ctrlKey || target.closest('[data-tab-close]')) return
    const tab = target.closest<HTMLElement>('[data-tab-id]')
    const id = tab?.dataset.tabId
    // La tab dell'agente non si riordina: sta sempre in fondo alle altre.
    if (!tab || !id || tab.dataset.tabKind === 'agent') return
    const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`[data-tab-kind="${tab.dataset.tabKind}"]`))
    // Una tab di chat trascinata sul bordo destro o in basso della vista si apre in una nuova colonna. I file no.
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
      {/* Annuncio vocale dell'agente al lavoro nel browser; con la sua tab aperta lo dice già la tab. */}
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
                  // Su macOS Ctrl+clic è il clic destro: resta al menu.
                  if (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey) {
                    toggleColumn(id)
                    return
                  }
                  select({ kind: 'session', projectId, sessionId: id })
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5 outline-none focus-visible:underline"
                title={session.titleGenerating ? `${session.title} · ${t('Generating title…')}` : session.title}
              >
                {/* A riposo il segno del provider; quando lavora o ti aspetta, lo stato. */}
                <span className="grid w-3.5 shrink-0 place-items-center">
                  {sessionState(session) === 'idle' ? <AgentMark agent={session.agent} size={13} /> : <SessionGlyph state={sessionState(session)} />}
                </span>
                <span className={cn('truncate', active && 'font-medium', session.titleGenerating && 'animate-pulse motion-reduce:animate-none')}>{session.title}</span>
                {agentBrowser[id]?.action && <Globe role="img" aria-label={t('The agent is using the browser')} className="size-3 shrink-0 text-running" strokeWidth={2} />}
                {/* Colonna affiancata: il numero (oltre al colore) dice quale; pieno se è la colonna attiva. */}
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
      {browsers.map((tab) => {
        const active = tab.id === activeBrowser
        const live = browserStates[tab.id]
        const label = browserTabLabel(live, tab.url, tab.title)
        return (
          <div key={tab.id} role="tab" data-tab-id={tab.id} data-tab-kind="browser" aria-selected={active} className={cn('group flex h-7 max-w-[180px] min-w-[84px] shrink items-center gap-1 rounded-md pr-0.5 pl-2 text-sm text-muted-foreground select-none data-[dragging=true]:bg-accent', active ? 'bg-accent text-foreground' : 'hover:bg-accent/60')}>
            <button type="button" onClick={() => select({ kind: 'browser', projectId, tabId: tab.id })} className="flex min-w-0 flex-1 items-center gap-1.5 outline-none focus-visible:underline" title={live?.url || tab.url || label}>
              {/* Mentre la pagina carica, lo stesso anello delle sessioni in corso al posto del globo. */}
              <span className="grid w-3.5 shrink-0 place-items-center">
                {live?.loading ? (
                  <span aria-hidden className="block size-[11px] rounded-full border-[1.6px] border-border border-t-running animate-spin motion-reduce:animate-none motion-reduce:border-dotted motion-reduce:border-running" />
                ) : (
                  <Globe aria-hidden className="size-3.5" strokeWidth={1.75} />
                )}
              </span>
              <span className={cn('truncate', active && 'font-medium')}>{label}</span>
            </button>
            <button
              type="button"
              data-tab-close
              aria-label={t('Close {title}', { title: label })}
              onClick={() => closeBrowser(projectId, tab.id)}
              className={cn('grid size-[18px] shrink-0 place-items-center rounded text-faint outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50', !active && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
      {agentTabs.map((agent) => {
        const id = agent.tabId
        const active = id === activeBrowser
        const live = browserStates[id]
        const session = sessions[agent.sessionId]
        const page = live?.url ? browserAddress(live.url) : null
        const label = page ? t('Agent · {page}', { page }) : t('Agent browser')
        const status = agentStatusText(agent)
        const waiting = Boolean(agent.action?.waitingForYou)
        const closeNote = t('Close the agent’s browser. This stops it.')
        return (
          <div key={id} role="tab" data-tab-id={id} data-tab-kind="agent" aria-selected={active} className={cn('group flex h-7 max-w-[180px] min-w-[84px] shrink items-center gap-1 rounded-md pr-0.5 pl-2 text-sm text-muted-foreground select-none', active ? 'bg-accent text-foreground' : 'hover:bg-accent/60')}>
            <button type="button" onClick={() => select({ kind: 'browser', projectId, tabId: id })} className="flex min-w-0 flex-1 items-center gap-1.5 outline-none focus-visible:underline" title={`${session.title} · ${status}`}>
              <Bot aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
              <span className={cn('truncate', active && 'font-medium')}>{label}</span>
              {/* Lo stato ha una forma propria oltre al colore: anello = lavora, avviso = ti aspetta, stop = fermato. */}
              {agent.stopped ? (
                <OctagonX role="img" aria-label={t('Stopped')} className="size-3 shrink-0" strokeWidth={2} />
              ) : waiting ? (
                <CircleAlert role="img" aria-label={t('Waiting for you')} className="size-3 shrink-0 text-attention" strokeWidth={2.2} />
              ) : agent.action ? (
                <span role="img" aria-label={t('Working')} className="block size-[11px] shrink-0 rounded-full border-[1.6px] border-border border-t-running animate-spin motion-reduce:animate-none motion-reduce:border-dotted motion-reduce:border-running" />
              ) : null}
            </button>
            <button
              type="button"
              data-tab-close
              aria-label={`${t('Close {title}', { title: label })}. ${closeNote}`}
              title={closeNote}
              onClick={() => closeBrowser(projectId, id)}
              className={cn('grid size-[18px] shrink-0 place-items-center rounded text-faint outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50', !active && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
      {activeSessionId === null && !activeFile && !activeBrowser && (visible.length > 0 || files.length > 0 || browsers.length > 0) && (
        <div role="tab" aria-selected className="flex h-7 shrink-0 items-center rounded-md bg-accent px-2.5 text-xs font-medium text-foreground">
          {t('New chat')}
        </div>
      )}
      </div>
      {agentWorking.length > 0 && (
        <button
          type="button"
          onClick={() => select({ kind: 'browser', projectId, tabId: agentWorking[0].tabId })}
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
      {(visible.length > 0 || files.length > 0 || browsers.length > 0) && (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t('New tab')}
            className="no-drag grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent/60"
          >
            <Plus className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-auto min-w-48">
            <DropdownMenuItem onClick={() => select({ kind: 'new', projectId })}>
              {t('New chat')}
              <Kbd className="ml-auto pl-3">{shortcutLabel('chat.new')}</Kbd>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openBrowser(projectId)}>{t('Open browser')}</DropdownMenuItem>
            {stoppedAgents.map((agent) => (
              <DropdownMenuItem key={agent.sessionId} onClick={() => void useApp.getState().resumeAgentBrowser(agent.sessionId).catch(() => undefined)}>
                {stoppedAgents.length > 1 ? t('Resume the agent’s browser · {title}', { title: sessions[agent.sessionId]?.title ?? '' }) : t('Resume the agent’s browser')}
              </DropdownMenuItem>
            ))}
            {browsers.length > 0 && <DropdownMenuItem onClick={() => openBrowser(projectId, { fresh: true })}>{t('New browser tab')}</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {visible.length > 0 && (
        <Tooltip>
          {/* aria-disabled e non disabled: il tooltip che spiega il perché deve restare raggiungibile da mouse e tastiera. */}
          <TooltipTrigger
            aria-label={t('Split')}
            aria-disabled={splitBlocked ? true : undefined}
            onClick={() => {
              if (!splitBlocked) splitActive()
            }}
            className={cn(
              'no-drag grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent/60',
              splitBlocked && 'opacity-40 hover:bg-transparent hover:text-muted-foreground'
            )}
          >
            <Columns2 aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="flex-col items-start gap-0.5">
            <span className="flex items-center gap-1.5">
              {splitBlocked ?? (hasCandidate ? t('Split') : t('Open a new chat in a column'))}
              {shortcutLabel('chat.split') && <Kbd>{shortcutLabel('chat.split')}</Kbd>}
            </span>
            <span className="opacity-70">{t('{key}click a tab to add or remove its column', { key: modKey })}</span>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
