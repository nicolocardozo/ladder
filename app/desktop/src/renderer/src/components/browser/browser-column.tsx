// Colonna browser del progetto: una sola, a destra delle colonne di chat e a sinistra del resto del pannello di destra.
// L'intestazione è la striscia delle pagine (tab salvate e browser degli agenti); sotto, la pagina attiva (BrowserBody).
// Un solo BrowserBody alla volta: cambiando pagina o chiudendo la colonna la vista nativa precedente si nasconde da sola.
import { useEffect, useRef } from 'react'
import { Bot, CircleAlert, Globe, OctagonX, Plus, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { BrowserBody } from '@/components/browser/browser-view'
import { ResizeHandle } from '@/components/resize-handle'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agentStatusText, agentTabSession, isAgentTabId } from '@/lib/browser-agent'
import { BROWSER_COLUMN } from '@/lib/browser-column'
import { browserAddress, browserTabLabel } from '@/lib/browser-tabs'
import { clamp, MIN_CONTENT_WIDTH } from '@/lib/panel-size'
import { cn } from '@/lib/utils'
import { browserColumnActive, browserColumnTabs, isBrowserColumnOpen, useApp } from '@/store/app-store'

const iconButton =
  'no-drag grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent data-[popup-open]:text-foreground'
const tabClass = 'group flex h-7 max-w-[180px] min-w-[84px] shrink-0 items-center gap-1 rounded-md pr-0.5 pl-2 text-sm text-muted-foreground select-none'
const closeClass = 'grid size-[18px] shrink-0 place-items-center rounded text-faint outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50'
const spinner = 'block size-[11px] shrink-0 rounded-full border-[1.6px] border-border border-t-running animate-spin motion-reduce:animate-none motion-reduce:border-dotted motion-reduce:border-running'

export function BrowserColumn({ projectId }: { projectId: string }) {
  const open = useApp((s) => isBrowserColumnOpen(s, projectId))
  // Aperta ma senza più pagine (sessione archiviata col suo agente, progetto cambiato): si chiude davvero,
  // così una pagina che arriva dopo non la riapre da sola.
  const stale = useApp((s) => Boolean(s.ui[projectId]?.browserColumn?.open) && browserColumnTabs(s, projectId).length === 0)
  useEffect(() => {
    if (stale) useApp.getState().closeBrowserColumn(projectId)
  }, [stale, projectId])
  return open ? <Column projectId={projectId} /> : null
}

function Column({ projectId }: { projectId: string }) {
  const ui = useApp((s) => s.ui)
  const agentBrowser = useApp((s) => s.agentBrowser)
  const agentForeign = useApp((s) => s.agentForeign)
  const sessions = useApp((s) => s.sessions)
  const browserStates = useApp((s) => s.browserStates)
  const width = useApp((s) => s.ui[projectId]?.browserColumn?.width)
  const { showBrowserColumn, closeBrowserColumn, closeBrowser, openBrowser, setBrowserColumnWidth, resumeAgentBrowser } = useApp.getState()
  const view = { ui, agentBrowser, agentForeign, sessions }
  const tabs = browserColumnTabs(view, projectId)
  const active = browserColumnActive(view, projectId)
  const saved = ui[projectId]?.browserTabs ?? []
  // Browser degli agenti fermati (stop esplicito o pagina chiusa): da qui si riattivano.
  const stopped = Object.values(agentBrowser).filter((agent) => agent.projectId === projectId && agent.enabled && !agent.closed && agent.stopped && Boolean(sessions[agent.sessionId]) && !sessions[agent.sessionId].archived)

  const panel = useRef<HTMLElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  // La pagina attiva resta in vista nella striscia quando le tab non ci stanno.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active, tabs.length])

  // Come l'ispettore: durante il trascinamento si ritocca il DOM, la misura si salva a fine gesto. Il massimo lascia al contenuto lo spazio minimo, tolto ciò che sta a destra.
  const maxWidth = () => {
    const parent = panel.current?.parentElement
    if (!parent) return BROWSER_COLUMN.min
    let others = 0
    for (const child of Array.from(parent.children)) if (child !== panel.current && !child.hasAttribute('data-split-area')) others += child.getBoundingClientRect().width
    return Math.max(BROWSER_COLUMN.min, parent.clientWidth - MIN_CONTENT_WIDTH - others)
  }
  const preview = (value: number) => {
    if (panel.current) panel.current.style.width = `${Math.round(value)}px`
  }
  const commit = (value: number) => {
    const next = clamp(Math.round(value), BROWSER_COLUMN.min, maxWidth())
    preview(next)
    setBrowserColumnWidth(projectId, next)
  }
  const reset = () => {
    // Il predefinito è una regola CSS: si toglie lo stile in linea e si dimentica la misura salvata.
    if (panel.current) panel.current.style.width = ''
    setBrowserColumnWidth(projectId, undefined)
  }

  return (
    <aside
      ref={panel}
      aria-label={t('Browser')}
      className="relative flex shrink flex-col border-l border-border bg-background"
      style={{ width: width ?? `max(${BROWSER_COLUMN.min}px, ${BROWSER_COLUMN.share * 100}%)`, minWidth: BROWSER_COLUMN.min, maxWidth: `calc(100% - ${MIN_CONTENT_WIDTH}px)` }}
    >
      <ResizeHandle
        label={t('Resize browser')}
        invert
        value={width ?? BROWSER_COLUMN.min}
        min={BROWSER_COLUMN.min}
        max={Math.max(width ?? BROWSER_COLUMN.min, BROWSER_COLUMN.min)}
        measure={() => ({ value: panel.current?.getBoundingClientRect().width ?? width ?? BROWSER_COLUMN.min, min: BROWSER_COLUMN.min, max: maxWidth() })}
        onPreview={preview}
        onCommit={commit}
        onReset={reset}
        className="absolute inset-y-0 -left-1"
      />
      <div className="drag flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-2">
        <div ref={strip} role="tablist" aria-label={t('Browser pages')} className="no-drag flex min-w-0 items-center gap-0.5 overflow-x-auto no-scrollbar">
          {tabs.map((id) => {
            const selected = id === active
            const live = browserStates[id]
            if (isAgentTabId(id)) {
              const agent = agentBrowser[agentTabSession(id)]
              const session = sessions[agent.sessionId]
              const page = live?.url ? browserAddress(live.url) : null
              const label = page ? t('Agent · {page}', { page }) : t('Agent browser')
              const status = agentStatusText(agent)
              const closeNote = t('Close the agent’s browser. This stops it.')
              return (
                <div key={id} role="tab" aria-selected={selected} className={cn(tabClass, selected ? 'bg-accent text-foreground' : 'hover:bg-accent/60')}>
                  <button type="button" onClick={() => showBrowserColumn(projectId, id)} className="flex min-w-0 flex-1 items-center gap-1.5 outline-none focus-visible:underline" title={`${session.title} · ${status}`}>
                    <Bot aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
                    <span className={cn('truncate', selected && 'font-medium')}>{label}</span>
                    {/* Lo stato ha una forma propria oltre al colore: anello = lavora, avviso = ti aspetta, stop = fermato. */}
                    {agent.stopped ? (
                      <OctagonX role="img" aria-label={t('Stopped')} className="size-3 shrink-0" strokeWidth={2} />
                    ) : agent.action?.waitingForYou ? (
                      <CircleAlert role="img" aria-label={t('Waiting for you')} className="size-3 shrink-0 text-attention" strokeWidth={2.2} />
                    ) : agent.action ? (
                      <span role="img" aria-label={t('Working')} className={spinner} />
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('Close {title}', { title: label })}. ${closeNote}`}
                    title={closeNote}
                    onClick={() => closeBrowser(projectId, id)}
                    className={cn(closeClass, !selected && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )
            }
            const tab = saved.find((entry) => entry.id === id)
            const label = browserTabLabel(live, tab?.url, tab?.title)
            return (
              <div key={id} role="tab" aria-selected={selected} className={cn(tabClass, selected ? 'bg-accent text-foreground' : 'hover:bg-accent/60')}>
                <button type="button" onClick={() => showBrowserColumn(projectId, id)} className="flex min-w-0 flex-1 items-center gap-1.5 outline-none focus-visible:underline" title={live?.url || tab?.url || label}>
                  {/* Mentre la pagina carica, lo stesso anello delle sessioni in corso al posto del globo. */}
                  <span className="grid w-3.5 shrink-0 place-items-center">{live?.loading ? <span aria-hidden className={spinner} /> : <Globe aria-hidden className="size-3.5" strokeWidth={1.75} />}</span>
                  <span className={cn('truncate', selected && 'font-medium')}>{label}</span>
                </button>
                <button type="button" aria-label={t('Close {title}', { title: label })} onClick={() => closeBrowser(projectId, id)} className={cn(closeClass, !selected && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}>
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
        <Tooltip>
          <TooltipTrigger aria-label={t('New page')} onClick={() => openBrowser(projectId, { fresh: true })} className={iconButton}>
            <Plus aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('New page')}</TooltipContent>
        </Tooltip>
        {stopped.length > 0 && (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger render={<DropdownMenuTrigger aria-label={t('Agent browsers')} className={iconButton} />}>
                <Bot aria-hidden className="size-4" strokeWidth={1.75} />
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('Agent browsers')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-auto min-w-52">
              {stopped.map((agent) => (
                <DropdownMenuItem key={agent.sessionId} onClick={() => void resumeAgentBrowser(agent.sessionId).catch(() => undefined)}>
                  {stopped.length > 1 ? t('Resume the agent’s browser · {title}', { title: sessions[agent.sessionId]?.title ?? '' }) : t('Resume the agent’s browser')}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="min-w-0 flex-1" />
        <Tooltip>
          <TooltipTrigger aria-label={t('Close browser')} onClick={() => closeBrowserColumn(projectId)} className={iconButton}>
            <X aria-hidden className="size-4" strokeWidth={1.75} />
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('Close browser')}</TooltipContent>
        </Tooltip>
      </div>
      {active && (
        <div className="flex min-h-0 flex-1 flex-col">
          <BrowserBody key={active} projectId={projectId} tabId={active} />
        </div>
      )}
    </aside>
  )
}
