import { FileTabView, UnsavedFileDialog } from '@/components/file-tab'
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { AppSidebar } from '@/components/app-sidebar'
import { CommandPalette } from '@/components/command-palette'
import { NewChat, SessionView } from '@/components/main-views'
import { Onboarding } from '@/components/connections/onboarding'
import { NewFromDialog } from '@/components/new-from'
import { AdviceDialog } from '@/components/advice-dialog'
import { HandoffDialog } from '@/components/handoff-dialog'
import { PlanDialog } from '@/components/plan-dialog'
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
import { UpdateToast } from '@/components/update-toast'

export function App() {
  const selection = useApp((s) => s.selection)
  const connected = useApp((s) => s.connected)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const sidebarNotice = useApp((s) => s.sidebarNotice)
  const clearSidebarNotice = useApp((s) => s.clearSidebarNotice)
  const onboarding = useApp((s) => s.onboarding)

  // Theme changed from another window and "Settings…" from the app menu (⌘,).
  useEffect(() => {
    const offTheme = window.ladder?.theme.onChange((id) => useSettings.getState().receiveTheme(id))
    const offSettings = window.ladder?.onOpenSettings(() => useSettings.getState().setSettingsOpen(true))
    return () => {
      offTheme?.()
      offSettings?.()
    }
  }, [])

  // Built-in browser: tab states (including tabs that aren't open) come from main and go into the store.
  useEffect(() => window.ladder?.browser?.onEvent((state) => useApp.getState().setBrowserState(state)), [])

  // Agent browser: on every (re)connection the state of all sessions is re-read (new window or restarted host);
  // changes arrive via the `browser.agent` event, handled in the store. Without the app (web preview) there is nothing to read.
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

  // Preferences (notifications) and clicks on notifications or ladder:// links.
  useEffect(() => {
    void window.ladder?.prefs.get().then((prefs) => useApp.getState().setPrefs(prefs))
    const offPrefs = window.ladder?.prefs.onChange((prefs) => {
      if (!prefsPending()) useApp.getState().setPrefs(prefs)
    })
    let waitingOpen: { sessionId: string; itemId: string | null } | null = null
    const tryOpen = () => {
      const target = waitingOpen
      if (!target) return
      // Cleared before opening: opening updates the store, which would otherwise call tryOpen again.
      waitingOpen = null
      if (!useApp.getState().openSessionAt(target.sessionId, target.itemId)) waitingOpen = target
    }
    const offOpen = window.ladder?.onOpenSession((target) => {
      // With a freshly opened window the session arrives with the snapshot: retry when it is there.
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

  // What you are looking at: main doesn't notify the session in front of you. Entering and leaving a project
  // updates "While you were away": if you come back after more than 30 minutes the summary appears.
  useEffect(() => {
    let sent = ''
    const report = () => {
      const state = useApp.getState()
      const { selection } = state
      const sessionId = selection.kind === 'session' ? selection.sessionId : null
      // With side-by-side columns all of them are visible, not just the active one.
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
    // While you look at the project with the window active, the last visit advances.
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

  // Connection with the host: incoming events and a full snapshot on every (re)connection.
  useEffect(() => {
    const { applyEvent } = useApp.getState()
    const offEvent = onHostEvent(applyEvent)
    const offConnect = onHostConnect(() => {
      request<Extract<HostEvent, { type: 'snapshot' }>>({ type: 'hello' })
        .then((snapshot) => {
          applyEvent(snapshot)
          // Sessions already loaded are reloaded: the host may have been restarted.
          for (const sessionId of Object.keys(useApp.getState().items)) send({ type: 'session.open', sessionId })
          // The snapshot already carries the connections; if they are missing (host without them), they are requested.
          if (!snapshot.connections) refreshConnections()
        })
        .catch(() => undefined)
    })
    return () => {
      offEvent()
      offConnect()
    }
  }, [])

  // First launch: if no agent is connected, "Connect your subscriptions" appears. Once open it stays until
  // Continue or Skip is pressed, even if an agent connects in the meantime; it doesn't reappear until the next launch.
  useEffect(() => {
    const check = () => {
      const state = useApp.getState()
      if (state.onboarding !== 'idle' || !state.connected || !state.connections['claude-code'] || !state.connections.codex) return
      state.setOnboarding(hasLinkedAgent() ? 'done' : 'open')
    }
    check()
    return useApp.subscribe(check)
  }, [])

  // Global shortcuts: the registry is in shared/shortcuts.ts, the actions in lib/shortcuts.ts.
  useEffect(() => {
    window.addEventListener('keydown', handleGlobalKeydown)
    // With focus in the native browser page the keyboard doesn't go through the renderer: main forwards the app shortcuts.
    const offForwarded = window.ladder?.browser?.onShortcut?.((e) => handleGlobalKeydown({ key: e.key, code: e.code, metaKey: e.meta, ctrlKey: e.ctrl, altKey: e.alt, shiftKey: e.shift }))
    return () => {
      window.removeEventListener('keydown', handleGlobalKeydown)
      offForwarded?.()
    }
  }, [])

  if (!isElectron) {
    // The command sits in a <code> inside the sentence: the translated text is split around {command}.
    const [before, after = ''] = t('Ladder runs inside Electron: start it with {command}. For the chat components, use /preview.html.').split('{command}')
    return (
      <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
        {before}
        <code className="font-mono">pnpm dev</code>
        {after}
      </div>
    )
  }

  // With unsaved files the close stops: the main process asks what to do.
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
      <UpdateToast />
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
      <HandoffDialog />
      <AdviceDialog />
      <PlanDialog />
      <UnsavedFileDialog />
    </TooltipProvider>
  )
}
