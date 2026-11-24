import { FileTabView, UnsavedFileDialog } from '@/components/file-tab'
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { AppSidebar } from '@/components/app-sidebar'
import { CommandPalette } from '@/components/command-palette'
import { NewChat, SessionView } from '@/components/main-views'
import { Onboarding } from '@/components/connections/onboarding'
import { NewFromDialog } from '@/components/new-from'
import { SavePresetDialog } from '@/components/preset-dialog'
import { QuickOpen } from '@/components/quick-open'
import { handleGlobalKeydown } from '@/lib/shortcuts'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SettingsDialog } from '@/components/settings-dialog'
import { useSettings } from '@/hooks/use-theme'
import { prefsPending } from '@/hooks/use-prefs'
import { isElectron, onHostConnect, onHostEvent, request, send } from '@/lib/host-client'
import { hasLinkedAgent, refreshConnections } from '@/lib/connections'
import { liveColumns, useApp } from '@/store/app-store'
import type { AgentBrowserState, HostEvent } from '@shared/protocol'
import { t } from '@shared/i18n'

export function App() {
  const selection = useApp((s) => s.selection)
  const connected = useApp((s) => s.connected)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const sidebarNotice = useApp((s) => s.sidebarNotice)
  const clearSidebarNotice = useApp((s) => s.clearSidebarNotice)
  const onboarding = useApp((s) => s.onboarding)

  // Tema cambiato da un'altra finestra e "Impostazioni…" dal menu dell'app (⌘,).
  useEffect(() => {
    const offTheme = window.ladder?.theme.onChange((id) => useSettings.getState().receiveTheme(id))
    const offSettings = window.ladder?.onOpenSettings(() => useSettings.getState().setSettingsOpen(true))
    return () => {
      offTheme?.()
      offSettings?.()
    }
  }, [])

  // Browser integrato: gli stati delle tab (anche di quelle non aperte) arrivano dal main e vanno nello store.
  useEffect(() => window.ladder?.browser?.onEvent((state) => useApp.getState().setBrowserState(state)), [])

  // Browser dell'agente: a ogni (ri)connessione si rilegge lo stato di tutte le sessioni (finestra appena aperta o host ripartito);
  // i cambiamenti arrivano dall'evento `browser.agent`, gestito nello store. Senza app (anteprima web) non c'è nulla da leggere.
  useEffect(
    () =>
      onHostConnect(() => {
        if (!isElectron) return
        void request<AgentBrowserState[]>({ type: 'browser.agent.state' })
          .then((list) => useApp.getState().loadAgentBrowser(Array.isArray(list) ? list : []))
          .catch(() => undefined)
      }),
    []
  )

  // Preferenze (notifiche) e clic sulle notifiche o sui link ladder://.
  useEffect(() => {
    void window.ladder?.prefs.get().then((prefs) => useApp.getState().setPrefs(prefs))
    const offPrefs = window.ladder?.prefs.onChange((prefs) => {
      if (!prefsPending()) useApp.getState().setPrefs(prefs)
    })
    let waitingOpen: { sessionId: string; itemId: string | null } | null = null
    const tryOpen = () => {
      const target = waitingOpen
      if (!target) return
      // Si svuota prima di aprire: l'apertura aggiorna lo store, che altrimenti richiamerebbe tryOpen.
      waitingOpen = null
      if (!useApp.getState().openSessionAt(target.sessionId, target.itemId)) waitingOpen = target
    }
    const offOpen = window.ladder?.onOpenSession((target) => {
      // Con la finestra appena aperta la sessione arriva con lo snapshot: si riprova quando c'è.
      waitingOpen = target
      tryOpen()
    })
    const offStore = useApp.subscribe((state) => {
      if (waitingOpen && state.connected) tryOpen()
    })
    return () => {
      offPrefs?.()
      offOpen?.()
      offStore()
    }
  }, [])

  // Cosa stai guardando: il main non notifica la sessione che hai davanti. Entrare e uscire da un progetto
  // aggiorna "Mentre eri via": se torni dopo più di 30 minuti compare il riepilogo.
  useEffect(() => {
    let sent = ''
    const report = () => {
      const state = useApp.getState()
      const { selection } = state
      const sessionId = selection.kind === 'session' ? selection.sessionId : null
      // Con le colonne affiancate sono visibili tutte, non solo l'attiva.
      const columns = selection.projectId && sessionId ? liveColumns(state, selection.projectId) : []
      const visibleSessionIds = columns.length > 1 && sessionId && columns.includes(sessionId) ? columns : sessionId ? [sessionId] : []
      const key = JSON.stringify([selection.projectId, sessionId, visibleSessionIds])
      if (key === sent) return
      sent = key
      window.ladder?.setView({ projectId: selection.projectId, sessionId, visibleSessionIds })
    }
    report()
    const offStore = useApp.subscribe((state, prev) => {
      if (state.ui !== prev.ui || state.sessions !== prev.sessions) report()
      if (state.selection === prev.selection) return
      const now = state.selection.projectId
      const before = prev.selection.projectId
      if (now === before) return
      if (before) {
        state.markSeen(before)
        state.dismissAway(before)
      }
      if (now && document.hasFocus()) state.checkAway(now)
    })
    const current = () => useApp.getState().selection.projectId
    const onFocus = () => {
      const projectId = current()
      if (projectId) useApp.getState().checkAway(projectId)
      report()
    }
    const onBlur = () => {
      const projectId = current()
      if (projectId) useApp.getState().markSeen(projectId)
    }
    // Mentre guardi il progetto con la finestra attiva, l'ultima visita avanza.
    const timer = window.setInterval(() => {
      const projectId = current()
      if (projectId && document.hasFocus()) useApp.getState().markSeen(projectId)
    }, 60_000)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      offStore()
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Collegamento con l'host: eventi in arrivo e istantanea completa a ogni (ri)connessione.
  useEffect(() => {
    const { applyEvent } = useApp.getState()
    const offEvent = onHostEvent(applyEvent)
    const offConnect = onHostConnect(() => {
      request<Extract<HostEvent, { type: 'snapshot' }>>({ type: 'hello' })
        .then((snapshot) => {
          applyEvent(snapshot)
          // Le sessioni già caricate si ricaricano: l'host potrebbe essere stato riavviato.
          for (const sessionId of Object.keys(useApp.getState().items)) send({ type: 'session.open', sessionId })
          // Lo snapshot porta già i collegamenti; se mancano (host senza), si chiedono.
          if (!snapshot.connections) refreshConnections()
        })
        .catch(() => undefined)
    })
    return () => {
      offEvent()
      offConnect()
    }
  }, [])

  // Primo avvio: se nessun agente è collegato compare "Collega i tuoi abbonamenti". Una volta aperta resta finché non si
  // preme Continua o Salta, anche se nel frattempo un agente si collega; fino al prossimo avvio non ricompare.
  useEffect(() => {
    const check = () => {
      const state = useApp.getState()
      if (state.onboarding !== 'idle' || !state.connected || !state.connections['claude-code'] || !state.connections.codex) return
      state.setOnboarding(hasLinkedAgent() ? 'done' : 'open')
    }
    check()
    return useApp.subscribe(check)
  }, [])

  // Scorciatoie globali: il registro è in shared/shortcuts.ts, le azioni in lib/shortcuts.ts.
  useEffect(() => {
    window.addEventListener('keydown', handleGlobalKeydown)
    // Con il focus nella pagina nativa del browser la tastiera non passa dal renderer: il main inoltra le scorciatoie di app.
    const offForwarded = window.ladder?.browser?.onShortcut?.((e) => handleGlobalKeydown({ key: e.key, code: e.code, metaKey: e.meta, ctrlKey: e.ctrl, altKey: e.alt, shiftKey: e.shift }))
    return () => {
      window.removeEventListener('keydown', handleGlobalKeydown)
      offForwarded?.()
    }
  }, [])

  if (!isElectron) {
    // Il comando sta in un <code> dentro la frase: si divide il testo tradotto attorno a {command}.
    const [before, after = ''] = t('Ladder runs inside Electron: start it with {command}. For the chat components, use /preview.html.').split('{command}')
    return (
      <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
        {before}
        <code className="font-mono">pnpm dev</code>
        {after}
      </div>
    )
  }

  // Con file non salvati la chiusura si ferma: il processo main chiede cosa fare.
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!Object.values(useApp.getState().dirtyFiles).some(Boolean)) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full">
        {onboarding === 'open' ? (
          <Onboarding onDone={() => useApp.getState().setOnboarding('done')} />
        ) : (
          <>
        {sidebarOpen && <AppSidebar />}
        {!connected ? (
          <main className="drag grid flex-1 place-items-center bg-background text-sm text-muted-foreground">{t('Starting Ladder…')}</main>
        ) : selection.kind === 'session' ? (
          <SessionView sessionId={selection.sessionId} />
        ) : selection.kind === 'file' ? (
          <FileTabView key={`${selection.root}\n${selection.path}`} projectId={selection.projectId} root={selection.root} path={selection.path} />
        ) : (
          <NewChat projectId={selection.projectId} />
        )}
          </>
        )}
      </div>
      {!sidebarOpen && sidebarNotice && (
        <div role="alert" className="fixed bottom-3 left-3 z-50 flex min-h-7 max-w-80 items-center rounded-md border border-border bg-popover pr-1 pl-2.5 text-xs text-destructive shadow-md">
          <span className="min-w-0 flex-1 py-1">{sidebarNotice}</span>
          <button
            type="button"
            aria-label={t('Dismiss')}
            onClick={clearSidebarNotice}
            className="grid size-5 shrink-0 place-items-center rounded text-faint outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-3" />
          </button>
        </div>
      )}
      <CommandPalette />
      <QuickOpen />
      <NewFromDialog />
      <SettingsDialog />
      <SavePresetDialog />
      <UnsavedFileDialog />
    </TooltipProvider>
  )
}
