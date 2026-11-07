import { ChevronDown, Ellipsis, ExternalLink, FolderGit2, GitBranch, HardDrive, PanelRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Composer } from '@/components/composer'
import { IconButton } from '@/components/icon-button'
import { SessionGlyph } from '@/components/status'
import type { ProjectSummary, SessionSummary } from '@/data/sample'
import { agentById, type AgentId } from '@/lib/agents'

function TopBar({ children }: { children?: ReactNode }) {
  return (
    <div className="drag flex h-11 shrink-0 items-center gap-2 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <button
        type="button"
        className="no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Apri in Cursor
        <ExternalLink className="size-3.5" />
      </button>
      <IconButton icon={Ellipsis} label="Altre azioni" />
      <IconButton icon={PanelRight} label="Ispettore" shortcut="⌘⌥I" />
    </div>
  )
}

function ContextButton({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {icon}
      {children}
      <ChevronDown className="size-3 text-faint" />
    </button>
  )
}

interface NewChatProps {
  project: ProjectSummary
  agent: AgentId
  onAgentChange: (agent: AgentId) => void
}

/** Nuova chat: composer al centro con progetto, branch e cartella sopra, come nella finestra agenti di Cursor. */
export function NewChat({ project, agent, onAgentChange }: NewChatProps) {
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <TopBar />
      <div className="flex flex-1 flex-col items-center justify-center px-8 pb-[14vh]">
        <div className="w-full max-w-[680px]">
          <div className="mb-2 flex items-center gap-0.5 pl-1">
            <ContextButton icon={<FolderGit2 className="size-3.5" />}>{project.name}</ContextButton>
            <ContextButton icon={<GitBranch className="size-3.5" />}>{project.branch}</ContextButton>
            <ContextButton icon={<HardDrive className="size-3.5" />}>Checkout principale</ContextButton>
          </div>
          <Composer agent={agent} onAgentChange={onAgentChange} />
          <p className="mt-3 pl-1 text-[11.5px] text-faint">
            <kbd className="font-mono">⌘N</kbd> nuova chat · <kbd className="font-mono">⌘⇧A</kbd> prossima attesa ·{' '}
            <kbd className="font-mono">⌘K</kbd> cerca · <kbd className="font-mono">⌃`</kbd> terminale
          </p>
        </div>
      </div>
    </main>
  )
}

interface SessionViewProps {
  project: ProjectSummary
  session: SessionSummary
}

/** Sessione esistente. Nella fase 0 mostra solo intestazione e composer: la conversazione arriva nella fase 1. */
export function SessionView({ project, session }: SessionViewProps) {
  const agent = agentById(session.agent)
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <TopBar>
        <span className="no-drag flex min-w-0 items-center gap-2 pl-1">
          <SessionGlyph state={session.state} />
          <span className="truncate text-[13px] font-semibold">{session.title}</span>
          <span className="truncate text-[12px] text-muted-foreground">
            {project.name} · {project.branch} · {agent.name}
          </span>
        </span>
      </TopBar>
      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <p className="max-w-sm text-center text-[13px] text-muted-foreground">
          La conversazione di questa sessione arriva nella fase 1, con l’adapter di {agent.name}.
        </p>
      </div>
      <div className="flex justify-center px-6 pb-4">
        <Composer agent={session.agent} agentLocked className="max-w-[680px]" />
      </div>
    </main>
  )
}
