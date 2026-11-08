import { useEffect } from 'react'
import { AppSidebar } from '@/components/app-sidebar'
import { CommandPalette } from '@/components/command-palette'
import { NewChat, SessionView } from '@/components/main-views'
import { NewFromDialog } from '@/components/new-from'
import { QuickOpen } from '@/components/quick-open'
import { focusNextTerminal } from '@/lib/terminal-registry'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SettingsDialog } from '@/components/settings-dialog'
import { useSettings } from '@/hooks/use-theme'
import { isElectron, onHostConnect, onHostEvent, request, send } from '@/lib/host-client'
import { useApp } from '@/store/app-store'
import type { HostEvent } from '@shared/protocol'
import { t } from '@shared/i18n'

export function App() {
  const selection = useApp((s) => s.selection)
  const connected = useApp((s) => s.connected)
  const sidebarOpen = useApp((s) => s.sidebarOpen)

  // Tema cambiato da un'altra finestra e "Impostazioni…" dal menu dell'app (⌘,).
  useEffect(() => {
    const offTheme = window.ladder?.theme.onChange((id) => useSettings.getState().receiveTheme(id))
    const offSettings = window.ladder?.onOpenSettings(() => useSettings.getState().setSettingsOpen(true))
    return () => {
      offTheme?.()
      offSettings?.()
    }
  }, [])

  // Preferenze (notifiche, limite di sessioni) e clic sulle notifiche o sui link ladder://.
  useEffect(() => {
    void window.ladder?.prefs.get().then((prefs) => useApp.getState().setPrefs(prefs))
    const offPrefs = window.ladder?.prefs.onChange((prefs) => useApp.getState().setPrefs(prefs))
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
    const report = () => {
      const { selection } = useApp.getState()
      window.ladder?.setView({ projectId: selection.projectId, sessionId: selection.kind === 'session' ? selection.sessionId : null })
    }
    report()
    const offStore = useApp.subscribe((state, prev) => {
      if (state.selection === prev.selection) return
      report()
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
        })
        .catch(() => undefined)
    })
    return () => {
      offEvent()
      offConnect()
    }
  }, [])

  // Scorciatoie globali: ⌘K comandi, ⌘P file, ⌘B sidebar, ⌘[ ⌘] indietro e avanti, ⌘N nuova chat, ⌘⇧N da issue,
  // ⌘1…9 progetti, ⌘⌥1…4 ispettore, ⌃` terminale, ⌘W chiude la tab, ⌘. ferma la sessione aperta.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const state = useApp.getState()
      const projectId = state.selection.projectId
      // ⌃` (il tasto a sinistra dell'1, su qualunque tastiera): pannello terminale del progetto.
      if (event.ctrlKey && !event.metaKey && event.code === 'Backquote') {
        event.preventDefault()
        if (!projectId || state.paletteOpen || state.quickOpen) return
        const open = Boolean(state.ui[projectId]?.terminal?.open)
        if (!open) focusNextTerminal()
        state.setTerminalPanel(projectId, { open: !open })
        return
      }
      if (!event.metaKey || event.ctrlKey) return
      const { selection: current, select } = state
      const key = event.key.toLowerCase()
      const plain = !event.shiftKey && !event.altKey

      if (plain && key === 'k') {
        event.preventDefault()
        state.setQuickOpen(false)
        state.setPaletteOpen(!state.paletteOpen)
        return
      }
      if (plain && key === 'p') {
        event.preventDefault()
        state.setPaletteOpen(false)
        state.setQuickOpen(!state.quickOpen)
        return
      }
      // Con la palette aperta le altre scorciatoie aspettano: agirebbero sotto la finestra di dialogo.
      if (state.paletteOpen || state.quickOpen) return

      // ⌘⌥1…4: Modifiche, File, Cronologia, Merge. Con ⌥ event.key cambia carattere: conta il tasto fisico.
      if (event.altKey && !event.shiftKey && projectId && /^Digit[1234]$/.test(event.code)) {
        event.preventDefault()
        const tab = (['changes', 'files', 'history', 'merge'] as const)[Number(event.code.slice(5)) - 1]
        state.toggleInspector(projectId, tab)
        return
      }

      if (plain && key === 'b') {
        event.preventDefault()
        state.toggleSidebar()
        return
      }
      // Su tastiere dove [ e ] richiedono ⌥ (per esempio quella italiana) event.key resta la parentesi.
      if (!event.shiftKey && (event.key === '[' || event.key === ']')) {
        event.preventDefault()
        state.navigate(event.key === '[' ? -1 : 1)
        return
      }
      const digit = Number(event.key)
      if (plain && digit >= 1 && digit <= 9) {
        const project = state.projects[digit - 1]
        if (project) {
          event.preventDefault()
          state.selectProject(project.id)
        }
        return
      }
      // ⌘⇧A: prossima sessione che ti aspetta, in qualunque progetto.
      if (event.shiftKey && key === 'a') {
        event.preventDefault()
        state.goToNextWaiting()
        return
      }
      if (!event.shiftKey && key === 'w' && current.kind === 'session') {
        event.preventDefault()
        state.closeTab(current.projectId, current.sessionId)
        return
      }
      // ⌘⇧N: nuova sessione da una issue, una PR o un branch.
      if (event.shiftKey && !event.altKey && key === 'n') {
        event.preventDefault()
        if (current.projectId) state.setNewFromOpen(true)
        return
      }
      if (!event.shiftKey && key === 'n') {
        event.preventDefault()
        select({ kind: 'new', projectId: current.projectId })
      } else if (event.key === '.' && current.kind === 'session') {
        event.preventDefault()
        send({ type: 'session.interrupt', sessionId: current.sessionId })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full">
        {sidebarOpen && <AppSidebar />}
        {!connected ? (
          <main className="drag grid flex-1 place-items-center bg-background text-sm text-muted-foreground">{t('Starting Ladder…')}</main>
        ) : selection.kind === 'session' ? (
          <SessionView sessionId={selection.sessionId} />
        ) : (
          <NewChat projectId={selection.projectId} />
        )}
      </div>
      <CommandPalette />
      <QuickOpen />
      <NewFromDialog />
      <SettingsDialog />
    </TooltipProvider>
  )
}
