import { useEffect } from 'react'
import { AppSidebar } from '@/components/app-sidebar'
import { NewChat, SessionView } from '@/components/main-views'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useTheme } from '@/hooks/use-theme'
import { isElectron, onHostConnect, onHostEvent, request, send } from '@/lib/host-client'
import { useApp } from '@/store/app-store'
import type { HostEvent } from '@shared/protocol'

export function App() {
  const theme = useTheme()
  const selection = useApp((s) => s.selection)
  const connected = useApp((s) => s.connected)

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

  // Scorciatoie globali: ⌘N nuova chat, ⌘1…9 progetti, ⌘W chiude la tab, ⌘. ferma la sessione aperta.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey) return
      const { selection: current, select } = useApp.getState()
      const digit = Number(event.key)
      if (!event.shiftKey && !event.altKey && digit >= 1 && digit <= 9) {
        const project = useApp.getState().projects[digit - 1]
        if (project) {
          event.preventDefault()
          useApp.getState().selectProject(project.id)
        }
        return
      }
      if (!event.shiftKey && event.key.toLowerCase() === 'w' && current.kind === 'session') {
        event.preventDefault()
        useApp.getState().closeTab(current.projectId, current.sessionId)
        return
      }
      if (!event.shiftKey && event.key.toLowerCase() === 'n') {
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
    return (
      <div className="grid h-full place-items-center p-8 text-center text-[13px] text-muted-foreground">
        Ladder gira dentro Electron: avvialo con <code className="font-mono">pnpm dev</code>. Per i componenti della chat usa /preview.html.
      </div>
    )
  }

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full">
        <AppSidebar themeMode={theme.mode} onCycleTheme={theme.cycle} />
        {!connected ? (
          <main className="grid flex-1 place-items-center bg-background text-[13px] text-muted-foreground">Avvio di Ladder…</main>
        ) : selection.kind === 'session' ? (
          <SessionView sessionId={selection.sessionId} />
        ) : (
          <NewChat projectId={selection.projectId} />
        )}
      </div>
    </TooltipProvider>
  )
}
