import { useEffect, useState } from 'react'
import { AppSidebar, type Selection } from '@/components/app-sidebar'
import { NewChat, SessionView } from '@/components/main-views'
import { TooltipProvider } from '@/components/ui/tooltip'
import { sampleProjects } from '@/data/sample'
import { useTheme } from '@/hooks/use-theme'
import type { AgentId } from '@/lib/agents'

export function App() {
  const theme = useTheme()
  const [projects] = useState(sampleProjects)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['acme-monorepo']))
  const [selection, setSelection] = useState<Selection>({ kind: 'new', projectId: 'acme-monorepo' })
  const [newChatAgent, setNewChatAgent] = useState<AgentId>('claude-code')

  // ⌘N apre una nuova chat nel progetto attivo.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        setSelection((s) => ({ kind: 'new', projectId: s.projectId }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleProject = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const project = projects.find((p) => p.id === selection.projectId) ?? projects[0]
  const session = selection.kind === 'session' ? project.sessions.find((s) => s.id === selection.sessionId) : undefined

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full">
        <AppSidebar
          projects={projects}
          expanded={expanded}
          selection={selection}
          themeMode={theme.mode}
          onToggleProject={toggleProject}
          onSelect={setSelection}
          onCycleTheme={theme.cycle}
        />
        {session ? (
          <SessionView project={project} session={session} />
        ) : (
          <NewChat project={project} agent={newChatAgent} onAgentChange={setNewChatAgent} />
        )}
      </div>
    </TooltipProvider>
  )
}
