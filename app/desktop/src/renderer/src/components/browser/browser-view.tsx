// Browser integrato in una tab (LAD-57). La pagina è una vista nativa del main sopra un segnaposto DOM: qui si comunicano
// rettangolo e visibilità, e si disegna tutto il resto (barra, errori, stati vuoti). Con un popup, la palette o un
// trascinamento sopra l'area la vista si nasconde, perché la vista nativa starebbe sopra l'HTML.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Bot, Camera, CircleAlert, CircleCheck, ExternalLink, Globe, MoreHorizontal, OctagonX, Play, RotateCw, Square, TextQuote, X } from 'lucide-react'
import type { AgentBrowserState, BrowserAction, BrowserState } from '@shared/protocol'
import { t } from '@shared/i18n'
import { describeLoadError } from '@/components/browser/load-error'
import { TopBar, Workspace } from '@/components/main-views'
import { TabBar } from '@/components/tab-bar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agentStatusText, agentTabSession, describeAgentDone, isAgentTabId } from '@/lib/browser-agent'
import { browserAddress } from '@/lib/browser-tabs'
import { request } from '@/lib/host-client'
import { screenshotToChat, selectionToChat, type ToChat } from '@/lib/browser-chat'
import { useOverlayOpen } from '@/lib/native-overlay'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

const barButton =
  'no-drag grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 aria-expanded:bg-accent aria-expanded:text-foreground'

type Feedback = { kind: 'shot' | 'quote'; text: string; ok: boolean }

/** Botone con la sola icona: etichetta accessibile, suggerimento sopra (sotto la barra c'è la pagina nativa) e, a richiesta, l'esito di un'azione. */
function BarButton({ label, onClick, disabled, feedback, children }: { label: string; onClick: () => void; disabled?: boolean; feedback?: Feedback | null; children: ReactNode }) {
  const [hover, setHover] = useState(false)
  return (
    <Tooltip open={hover || Boolean(feedback)} onOpenChange={setHover}>
      <TooltipTrigger render={<button type="button" />} aria-label={label} disabled={disabled} onClick={onClick} className={barButton}>
        {children}
      </TooltipTrigger>
      <TooltipContent side="top">
        {feedback ? (
          <span className="flex items-center gap-1.5">
            {feedback.ok ? <CircleCheck aria-hidden className="size-3.5" /> : <CircleAlert aria-hidden className="size-3.5" />}
            {feedback.text}
          </span>
        ) : (
          label
        )}
      </TooltipContent>
    </Tooltip>
  )
}

export function BrowserTabView({ projectId, tabId }: { projectId: string; tabId: string }) {
  const project = useApp((s) => s.projects.find((p) => p.id === projectId) ?? null)
  if (!project) return null
  return (
    <Workspace project={project} session={null} root={project.path} composerKey={`new:${project.id}`}>
      <TopBar project={project} session={null} root={project.path}>
        <TabBar projectId={project.id} activeSessionId={null} activeBrowser={tabId} />
      </TopBar>
      <BrowserBody projectId={projectId} tabId={tabId} />
    </Workspace>
  )
}

function BrowserBody({ projectId, tabId }: { projectId: string; tabId: string }) {
  const api = window.ladder?.browser
  // Modalità agente: la tab è dell'agente di una sessione. Effimera (niente URL salvato), indirizzo in sola lettura, stop sempre a portata.
  const agentSession = isAgentTabId(tabId) ? agentTabSession(tabId) : null
  const agent = useApp((s) => (agentSession ? s.agentBrowser[agentSession] : undefined))
  const saved = useApp((s) => (agentSession ? undefined : s.ui[projectId]?.browserTabs?.find((tab) => tab.id === tabId)))
  const state = useApp((s) => s.browserStates[tabId]) as BrowserState | undefined
  const devServer = useApp((s) => s.devServers[projectId])
  const paletteOpen = useApp((s) => s.paletteOpen)
  const quickOpen = useApp((s) => s.quickOpen)
  const setBrowserState = useApp((s) => s.setBrowserState)
  const overlay = useOverlayOpen()
  const [ready, setReady] = useState(false)
  const [missing, setMissing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const feedbackTimer = useRef<number>(0)
  const savedUrl = useRef(saved?.url ?? '')

  // La vista nativa nasce (o si ritrova) all'apertura della tab; uscendo dalla tab si nasconde ma non si distrugge.
  useEffect(() => {
    if (!api) return
    let alive = true
    setReady(false)
    void api.open(tabId, projectId, savedUrl.current || undefined).then((next) => {
      if (!alive) return
      // Per una tab dell'agente che il main non ha (più) non c'è nulla da mostrare: la UI non può crearla.
      if (!next) {
        if (agentSession) {
          setMissing(true)
          // Con lo stato ancora attivo la tab è di un'altra finestra: lo store la nasconde e porta altrove.
          void useApp.getState().probeAgentBrowser(agentSession, true)
        }
        return
      }
      setMissing(false)
      setBrowserState(next)
      setReady(true)
    })
    return () => {
      alive = false
      api.setVisible(tabId, false)
    }
  }, [api, tabId, projectId, agentSession, setBrowserState])

  const url = state?.url ?? saved?.url ?? ''
  const pageError = state?.error ?? null
  const blank = url === '' && !pageError && !localError
  // Con un errore o senza pagina si vede il segnaposto DOM al posto della vista nativa.
  const showNative = ready && !missing && !blank && !pageError && !localError && !overlay && !paletteOpen && !quickOpen

  // Rettangolo: segue il segnaposto. Il ResizeObserver prende i cambi di dimensione (sidebar, ispettore, terminale),
  // la finestra e lo scroll gli spostamenti; un controllo lento copre lo spostamento senza cambio di misura.
  const last = useRef('')
  const pushBounds = useCallback(() => {
    const el = area.current
    if (!api || !el) return
    const rect = el.getBoundingClientRect()
    const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    const key = `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}`
    if (key === last.current) return
    last.current = key
    api.setBounds(tabId, bounds)
  }, [api, tabId])
  useLayoutEffect(() => {
    if (!api || !ready) return
    last.current = ''
    pushBounds()
    const observer = new ResizeObserver(pushBounds)
    if (area.current) observer.observe(area.current)
    window.addEventListener('resize', pushBounds)
    window.addEventListener('scroll', pushBounds, true)
    const timer = window.setInterval(pushBounds, 500)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', pushBounds)
      window.removeEventListener('scroll', pushBounds, true)
      window.clearInterval(timer)
    }
  }, [api, ready, pushBounds])
  // Prima il rettangolo, poi la visibilità: la vista non appare mai nel posto vecchio.
  useLayoutEffect(() => {
    if (!api || !ready) return
    if (showNative) pushBounds()
    api.setVisible(tabId, showNative)
  }, [api, ready, showNative, tabId, pushBounds])

  // ⌘L porta il cursore nell'indirizzo, come in ogni browser. ⌘R no: nel menu di Ladder ricarica la finestra dell'app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (agentSession) return
      if (!event.metaKey || event.shiftKey || event.altKey || event.ctrlKey || event.key.toLowerCase() !== 'l') return
      if (useApp.getState().paletteOpen || useApp.getState().quickOpen) return
      event.preventDefault()
      input.current?.focus()
      input.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [agentSession])

  useEffect(() => () => window.clearTimeout(feedbackTimer.current), [])

  // Avviso non bloccante (es. un link mailto: bloccato): la pagina resta; sparisce da solo dopo qualche secondo.
  const notice = state?.notice ?? null
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setDismissedNotice(notice), 8000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // ⌘L premuto mentre la pagina nativa ha il focus: il main lo inoltra e il cursore va nell'indirizzo.
  useEffect(
    () =>
      api?.onShortcut?.((event) => {
        if (agentSession) return
        if (!event.meta || event.shift || event.alt || event.ctrl || event.key.toLowerCase() !== 'l') return
        input.current?.focus()
        input.current?.select()
      }),
    [api, agentSession]
  )

  const run = (action: BrowserAction) => {
    setLocalError(null)
    void api?.action(tabId, action)
  }

  const go = async (text: string) => {
    if (!api) return
    const result = await api.navigate(tabId, text)
    if (result.ok) {
      // Subito l'indirizzo nuovo: gli eventi del main arrivano un attimo dopo e non devono far lampeggiare lo stato vuoto.
      if (state) setBrowserState({ ...state, url: result.url, loading: true, error: null })
      setLocalError(null)
      setEditing(false)
      input.current?.blur()
      void api.action(tabId, 'focus')
    } else setLocalError(result.error)
  }

  const tell = (kind: Feedback['kind'], result: ToChat, doneText: string) => {
    window.clearTimeout(feedbackTimer.current)
    setFeedback({ kind, ok: result.ok, text: result.ok ? t('{what} added to {chat}', { what: doneText, chat: result.title ?? t('the new chat') }) : result.error })
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 3200)
  }

  if (!api)
    return (
      <div className="relative min-h-0 flex-1">
        <Unavailable />
      </div>
    )

  const loading = Boolean(state?.loading)
  const shown = editing ? draft : url
  const hasPage = url !== '' && !blank
  const devAddress = devServer ? browserAddress(devServer.url) : null
  let devOrigin: string | null = null
  try {
    devOrigin = devServer ? new URL(devServer.url).origin : null
  } catch {
    devOrigin = devServer?.url ?? null
  }
  const showDev = !agentSession && Boolean(devServer && devOrigin && !url.startsWith(devOrigin))

  return (
    <>
      <div role="toolbar" aria-label={t('Browser')} className="relative flex h-10 shrink-0 items-center gap-0.5 border-y border-border px-2">
        {agentSession ? (
          // La pagina la guida l'agente: niente indietro, avanti o ricarica; l'indirizzo è solo da leggere.
          <span className="no-drag ml-0.5 flex h-6 shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 text-xs font-medium text-foreground">
            <Bot aria-hidden className="size-3.5" strokeWidth={1.75} />
            {t('Agent')}
          </span>
        ) : (
          <>
            <BarButton label={t('Back')} disabled={!state?.canGoBack} onClick={() => run('back')}>
              <ArrowLeft className="size-4" strokeWidth={1.75} />
            </BarButton>
            <BarButton label={t('Forward')} disabled={!state?.canGoForward} onClick={() => run('forward')}>
              <ArrowRight className="size-4" strokeWidth={1.75} />
            </BarButton>
            {loading ? (
              <BarButton label={t('Stop loading')} onClick={() => run('stop')}>
                <X className="size-4" strokeWidth={1.75} />
              </BarButton>
            ) : (
              <BarButton label={t('Reload')} disabled={!hasPage} onClick={() => run('reload')}>
                <RotateCw className="size-4" strokeWidth={1.75} />
              </BarButton>
            )}
          </>
        )}
        {agentSession ? (
          <input
            type="text"
            readOnly
            spellCheck={false}
            aria-readonly="true"
            aria-label={t('Address (read only)')}
            placeholder={t('The agent hasn’t opened a page yet')}
            value={url}
            title={url || undefined}
            className="no-drag mx-1 h-7 w-full min-w-0 flex-1 rounded-md border border-input bg-muted/40 px-2.5 text-sm text-muted-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        ) : (
        <form
          className="mx-1 min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            void go(draft)
          }}
        >
          <input
            ref={input}
            type="text"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={t('Address')}
            aria-keyshortcuts="Meta+L"
            aria-invalid={localError ? true : undefined}
            placeholder={t('Enter an address')}
            value={shown}
            onFocus={(event) => {
              setDraft(url)
              setEditing(true)
              event.currentTarget.select()
            }}
            onChange={(event) => {
              setDraft(event.target.value)
              setLocalError(null)
            }}
            onBlur={() => setEditing(false)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              setLocalError(null)
              setEditing(false)
              event.currentTarget.blur()
            }}
            className="h-7 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
          />
        </form>
        )}
        <BarButton label={t('Add screenshot to chat')} disabled={!hasPage || Boolean(pageError)} feedback={feedback?.kind === 'shot' ? feedback : null} onClick={() => void screenshotToChat(projectId, tabId).then((r) => tell('shot', r, t('Screenshot')))}>
          {feedback?.kind === 'shot' ? feedback.ok ? <CircleCheck className="size-4" strokeWidth={1.75} /> : <CircleAlert className="size-4 text-destructive" strokeWidth={1.75} /> : <Camera className="size-4" strokeWidth={1.75} />}
        </BarButton>
        <BarButton label={t('Add selection to chat')} disabled={!hasPage || Boolean(pageError)} feedback={feedback?.kind === 'quote' ? feedback : null} onClick={() => void selectionToChat(projectId, tabId).then((r) => tell('quote', r, t('Selection')))}>
          {feedback?.kind === 'quote' ? feedback.ok ? <CircleCheck className="size-4" strokeWidth={1.75} /> : <CircleAlert className="size-4 text-destructive" strokeWidth={1.75} /> : <TextQuote className="size-4" strokeWidth={1.75} />}
        </BarButton>
        <BarButton label={t('Open in system browser')} disabled={!hasPage} onClick={() => void api.openExternal(tabId)}>
          <ExternalLink className="size-4" strokeWidth={1.75} />
        </BarButton>
        {!agentSession && (
          <DropdownMenu>
            <DropdownMenuTrigger aria-label={t('More browser actions')} disabled={!hasPage} className={barButton}>
              <MoreHorizontal className="size-4" strokeWidth={1.75} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-44">
              <DropdownMenuItem onClick={() => run('hard-reload')}>{t('Hard reload')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => run('devtools')}>{t('Developer tools')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/* Caricamento: una riga sul bordo inferiore, sempre presente, così la barra non cambia altezza. */}
        <span aria-hidden className={cn('pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden transition-opacity', loading ? 'opacity-100' : 'opacity-0')}>
          <span className="block h-full w-1/3 animate-[browser-load_1.1s_ease-in-out_infinite] rounded-full bg-running motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-60" />
        </span>
      </div>
      <span role="status" className="sr-only">
        {loading ? t('Loading page…') : ''}
      </span>
      {agentSession && <AgentStrip sessionId={agentSession} state={agent} />}
      {notice && notice !== dismissedNotice && (
        <div role="status" className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
          <CircleAlert aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={notice}>
            {notice}
          </span>
          <button
            type="button"
            aria-label={t('Dismiss')}
            onClick={() => setDismissedNotice(notice)}
            className="grid size-5 shrink-0 place-items-center rounded text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-3" />
          </button>
        </div>
      )}
      {showDev && devServer && devAddress && (
        <div role="status" className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
          <Globe aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{t('{address} is running in the terminal.', { address: devAddress })}</span>
          <Button size="xs" variant="outline" onClick={() => useApp.getState().openBrowser(projectId, { url: devServer.url })}>
            {t('Open {address}', { address: devAddress })}
          </Button>
          <button
            type="button"
            aria-label={t('Dismiss')}
            onClick={() => useApp.getState().dismissDevServer(projectId)}
            className="grid size-5 shrink-0 place-items-center rounded text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-3" />
          </button>
        </div>
      )}
      {/* Segnaposto: la vista nativa ne copre il rettangolo. Quel che c'è dentro si vede solo quando la vista è nascosta. */}
      <div ref={area} data-browser-area className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {pageError ? (
          <ErrorPage error={describeLoadError(pageError)} onRetry={agentSession ? undefined : () => run('reload')} onExternal={() => void api.openExternal(tabId)} canExternal={/^https?:/i.test(pageError.url)} />
        ) : localError ? (
          <ErrorPage error={{ title: t('Can’t open this address'), detail: localError, hint: t('Use an address that starts with http or https, like localhost:5173.'), technical: null }} onFix={() => input.current?.focus()} />
        ) : agentSession && (missing || blank) ? (
          <AgentEmpty missing={missing} />
        ) : blank ? (
          <EmptyPage devAddress={devAddress} onOpenDev={devServer ? () => useApp.getState().openBrowser(projectId, { url: devServer.url }) : undefined} onType={() => input.current?.focus()} />
        ) : null}
      </div>
    </>
  )
}

/**
 * Barra dell'agente sotto quella della pagina: due righe a altezza fissa (niente scatti quando lo stato cambia).
 * Prima riga: che cosa fa l'agente adesso e lo Stop (o "Resume" dopo lo stop). Seconda: ultima azione con il suo esito e i domini ammessi.
 * Il testo digitato dall'agente non arriva mai qui: `target` non lo contiene.
 */
function AgentStrip({ sessionId, state }: { sessionId: string; state: AgentBrowserState | undefined }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stopped = Boolean(state?.stopped)
  const active = Boolean(state && state.enabled && !state.closed && !stopped)
  const waiting = Boolean(state?.action?.waitingForYou)
  const status = agentStatusText(state)
  const last = state?.last ?? null
  const hosts = ['localhost', ...(state?.allowedHosts ?? []).filter((host) => host !== 'localhost')]
  const lastText = last ? (last.ok ? describeAgentDone(last) : `${describeAgentDone(last)} · ${last.error || t('It didn’t work')}`) : t('No actions yet')
  const allowedText = t('Allowed: {hosts}', { hosts: hosts.join(', ') })

  const control = (type: 'browser.agent.stop' | 'browser.agent.resume') => {
    setBusy(true)
    setError(null)
    request<AgentBrowserState | AgentBrowserState[] | null>({ type, sessionId })
      .then((next) => {
        const one = Array.isArray(next) ? next[0] : next
        if (one && one.sessionId === sessionId) useApp.getState().applyAgentBrowser(one)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  return (
    <div data-agent-strip className="shrink-0 border-b border-border">
      <div className="flex h-9 items-center gap-2 px-3">
        <span aria-hidden className="grid w-4 shrink-0 place-items-center">
          {stopped ? (
            <OctagonX className="size-3.5 text-muted-foreground" strokeWidth={2} />
          ) : waiting ? (
            <CircleAlert className="size-3.5 text-attention" strokeWidth={2.2} />
          ) : state?.action ? (
            <span className="block size-[11px] rounded-full border-[1.6px] border-border border-t-running animate-spin motion-reduce:animate-none motion-reduce:border-dotted motion-reduce:border-running" />
          ) : (
            <Bot className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
          )}
        </span>
        {/* Cambi di stato annunciati: "Sta aprendo localhost:5173…". */}
        <span role="status" className={cn('min-w-0 flex-1 truncate text-sm', state?.action && !stopped ? 'font-medium text-foreground' : 'text-muted-foreground')} title={status}>
          {status}
        </span>
        {error && (
          <span role="alert" className="min-w-0 max-w-[40%] truncate text-xs text-destructive" title={error}>
            {error}
          </span>
        )}
        {stopped ? (
          <Button size="sm" variant="outline" disabled={busy || !state} onClick={() => control('browser.agent.resume')}>
            <Play aria-hidden data-icon="inline-start" />
            {t('Resume')}
          </Button>
        ) : (
          active && (
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => control('browser.agent.stop')} aria-label={t('Stop the agent’s browser')}>
              <Square aria-hidden data-icon="inline-start" className="fill-current" />
              {t('Stop')}
            </Button>
          )
        )}
      </div>
      <div className="flex h-8 items-center gap-2 px-3 text-xs text-muted-foreground">
        <span aria-hidden className="grid w-4 shrink-0 place-items-center">
          {last ? last.ok ? <CircleCheck className="size-3" strokeWidth={2} /> : <CircleAlert className="size-3 text-destructive" strokeWidth={2} /> : null}
        </span>
        <span className={cn('min-w-0 flex-1 truncate', last && !last.ok && 'text-destructive')} title={lastText}>
          <span className="sr-only">{t('Last action: ')}</span>
          {lastText}
        </span>
        <span className="min-w-0 max-w-[50%] shrink truncate" title={allowedText}>
          {allowedText}
        </span>
      </div>
    </div>
  )
}

function AgentEmpty({ missing }: { missing: boolean }) {
  return (
    <Centered>
      <div className="flex max-w-sm flex-col items-start gap-3">
        <Bot aria-hidden className="size-5 text-muted-foreground" strokeWidth={1.75} />
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{missing ? t('This browser is closed') : t('The agent’s browser')}</h2>
          <p className="text-sm text-muted-foreground">
            {missing
              ? t('The agent’s browser isn’t open any more. To let the agent use it again, choose “Resume the agent’s browser” in the command palette or the + menu.')
              : t('The agent shows here what it opens. It uses a separate browser without your cookies, and only reaches localhost unless you allow another site.')}
          </p>
        </div>
      </div>
    </Centered>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="absolute inset-0 grid place-items-center overflow-auto p-8">{children}</div>
}

function EmptyPage({ devAddress, onOpenDev, onType }: { devAddress: string | null; onOpenDev?: () => void; onType: () => void }) {
  return (
    <Centered>
      <div className="flex max-w-sm flex-col items-start gap-3">
        <Globe aria-hidden className="size-5 text-muted-foreground" strokeWidth={1.75} />
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t('Browser')}</h2>
          <p className="text-sm text-muted-foreground">{t('Open a page next to your chat: a local development server, docs or a preview. Cookies stay in this project.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {onOpenDev && devAddress && (
            <Button size="sm" onClick={onOpenDev}>
              {t('Open {address}', { address: devAddress })}
            </Button>
          )}
          <Button size="sm" variant={onOpenDev ? 'outline' : 'default'} onClick={onType}>
            {t('Type an address')}
          </Button>
        </div>
      </div>
    </Centered>
  )
}

function ErrorPage({ error, onRetry, onExternal, canExternal, onFix }: { error: ReturnType<typeof describeLoadError>; onRetry?: () => void; onExternal?: () => void; canExternal?: boolean; onFix?: () => void }) {
  return (
    <Centered>
      <div role="alert" className="flex max-w-md flex-col items-start gap-3">
        <CircleAlert aria-hidden className="size-5 text-destructive" strokeWidth={1.75} />
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{error.title}</h2>
          <p className="text-sm text-muted-foreground">{error.detail}</p>
          {error.hint && <p className="text-sm text-muted-foreground">{error.hint}</p>}
        </div>
        <div className="flex items-center gap-2">
          {onRetry && (
            <Button size="sm" onClick={onRetry}>
              {t('Try again')}
            </Button>
          )}
          {onFix && (
            <Button size="sm" onClick={onFix}>
              {t('Edit address')}
            </Button>
          )}
          {onExternal && canExternal && (
            <Button size="sm" variant="outline" onClick={onExternal}>
              {t('Open in system browser')}
            </Button>
          )}
        </div>
        {error.technical && <code className="font-mono text-xs text-faint">{error.technical}</code>}
      </div>
    </Centered>
  )
}

/** Senza Electron (anteprima web) non c'è vista nativa: un segnaposto dice perché. */
function Unavailable() {
  return (
    <Centered>
      <div className="flex max-w-sm flex-col items-start gap-3">
        <Globe aria-hidden className="size-5 text-muted-foreground" strokeWidth={1.75} />
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t('Browser')}</h2>
          <p className="text-sm text-muted-foreground">{t('The browser is only available in the Ladder app.')}</p>
        </div>
      </div>
    </Centered>
  )
}
