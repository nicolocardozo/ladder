import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Ellipsis, ExternalLink, FolderGit2, FolderPlus, GitBranch, HardDrive, PanelRight } from 'lucide-react'
import type { ChatItem, Effort, PermissionLevel, Project, RequestResponse, SessionSummary } from '@shared/protocol'
import { addProjectFromDialog } from '@/components/app-sidebar'
import { ChatView } from '@/components/chat/chat-view'
import { Composer } from '@/components/composer'
import { IconButton } from '@/components/icon-button'
import { TabBar } from '@/components/tab-bar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { request, send } from '@/lib/host-client'
import { useApp } from '@/store/app-store'

const EMPTY_ITEMS: ChatItem[] = []

function TopBar({ children, project }: { children?: ReactNode; project: Project | null }) {
  return (
    <div className="drag flex h-11 shrink-0 items-center gap-2 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {project && (
        <button
          type="button"
          onClick={() => void window.ladder?.openInEditor(project.path)}
          className="no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Apri in Cursor
          <ExternalLink className="size-3.5" />
        </button>
      )}
      <IconButton icon={Ellipsis} label="Altre azioni" />
      <IconButton icon={PanelRight} label="Ispettore" shortcut="⌘⌥I" />
    </div>
  )
}

const contextButton =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent'

function useClaudeStatus() {
  const agents = useApp((s) => s.agents)
  return agents.find((a) => a.agent === 'claude-code') ?? null
}

/** Nuova chat: composer al centro con progetto, branch e cartella sopra, come nella finestra agenti di Cursor. */
export function NewChat({ projectId }: { projectId: string | null }) {
  const projects = useApp((s) => s.projects)
  const select = useApp((s) => s.select)
  const claude = useClaudeStatus()
  const project = projects.find((p) => p.id === projectId) ?? projects[0] ?? null
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<Effort | null>(null)
  const [permission, setPermission] = useState<PermissionLevel>('edit')
  const [error, setError] = useState<string | null>(null)

  if (!project) {
    return (
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <TopBar project={null} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-[14vh] text-center">
          <p className="text-[15px] font-semibold">Aggiungi il primo progetto</p>
          <p className="max-w-sm text-[13px] text-muted-foreground">Scegli la cartella di un repository. Ladder apre le sessioni degli agenti lì dentro.</p>
          <button
            type="button"
            onClick={() => void addProjectFromDialog()}
            className="mt-2 inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <FolderPlus className="size-4" />
            Aggiungi progetto
          </button>
        </div>
      </main>
    )
  }

  const create = async (text: string) => {
    setError(null)
    try {
      const session = await request<SessionSummary>({
        type: 'session.create',
        projectId: project.id,
        agent: 'claude-code',
        text,
        model,
        effort,
        permission
      })
      send({ type: 'draft.set', key: `new:${project.id}`, text: '' })
      select({ kind: 'session', projectId: project.id, sessionId: session.id })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <TopBar project={project}>
        <TabBar projectId={project.id} activeSessionId={null} />
      </TopBar>
      <div className="flex flex-1 flex-col items-center justify-center px-8 pb-[14vh]">
        <div className="w-full max-w-[680px]">
          <div className="mb-2 flex items-center gap-0.5 pl-1">
            <DropdownMenu>
              <DropdownMenuTrigger className={contextButton}>
                <FolderGit2 className="size-3.5" />
                {project.name}
                <ChevronDown className="size-3 text-faint" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Progetto</DropdownMenuLabel>
                  {projects.map((p) => (
                    <DropdownMenuItem key={p.id} onClick={() => select({ kind: 'new', projectId: p.id })}>
                      <Check className={p.id === project.id ? 'size-3.5' : 'size-3.5 opacity-0'} />
                      {p.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onClick={() => void addProjectFromDialog()}>
                    <FolderPlus className="size-3.5" />
                    Aggiungi progetto…
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {project.branch && (
              <span className={contextButton}>
                <GitBranch className="size-3.5" />
                {project.branch}
              </span>
            )}
            <span className={contextButton}>
              <HardDrive className="size-3.5" />
              Checkout principale
            </span>
          </div>
          <Composer
            key={`new:${project.id}`}
            draftKey={`new:${project.id}`}
            agentName="Claude Code"
            models={claude?.models ?? []}
            model={model}
            onModelChange={setModel}
            effort={effort}
            onEffortChange={setEffort}
            permission={permission}
            onPermissionChange={setPermission}
            onSubmit={(text) => void create(text)}
            disabledReason={claude && !claude.available ? claude.error : null}
            autoFocus
          />
          {error && <p className="mt-2 pl-1 text-[12.5px] text-destructive">{error}</p>}
          <p className="mt-3 pl-1 text-[11.5px] text-faint">
            <kbd className="font-mono">⌘N</kbd> nuova chat · <kbd className="font-mono">⇧Tab</kbd> permessi · <kbd className="font-mono">⌘.</kbd> ferma
            {claude?.account && <> · Claude Code con {claude.account}</>}
            {claude?.version && <> · CLI {claude.version}</>}
          </p>
        </div>
      </div>
    </main>
  )
}

/** Sessione esistente: conversazione e composer. */
export function SessionView({ sessionId }: { sessionId: string }) {
  const session = useApp((s) => s.sessions[sessionId])
  const project = useApp((s) => s.projects.find((p) => p.id === s.sessions[sessionId]?.projectId) ?? null)
  const items = useApp((s) => s.items[sessionId] ?? EMPTY_ITEMS)
  const loaded = useApp((s) => sessionId in s.items)
  const firstUnread = useApp((s) => s.firstUnread[sessionId] ?? null)
  const ui = useApp((s) => (project ? s.ui[project.id] : undefined))
  const setUi = useApp((s) => s.setUi)
  const claude = useClaudeStatus()
  const [error, setError] = useState<string | null>(null)
  const uiTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!loaded) send({ type: 'session.open', sessionId })
  }, [sessionId, loaded])

  // Segna come letta quando la sessione è visibile, la finestra è attiva e il turno è finito.
  useEffect(() => {
    if (!session?.unread) return
    const mark = () => {
      if (document.hasFocus()) send({ type: 'session.read', sessionId })
    }
    const timer = window.setTimeout(mark, 1500)
    window.addEventListener('focus', mark)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', mark)
    }
  }, [sessionId, session?.unread, items.length])

  const onRespond = useCallback(
    (requestId: string, response: RequestResponse) => {
      request({ type: 'session.respond', sessionId, requestId, response }).catch((e: Error) => setError(e.message))
    },
    [sessionId]
  )

  const onOpenFile = useCallback(
    (path: string, line?: number) => {
      if (!project) return
      const absolute = path.startsWith('/') ? path : `${project.path}/${path}`
      void window.ladder?.openInEditor(absolute, line)
    },
    [project]
  )

  const initialAnchor = useMemo(() => ui?.scroll[sessionId] ?? null, [sessionId]) // solo all'apertura
  const onAnchorChange = useCallback(
    (anchor: { itemId: string; offset: number }) => {
      if (!project) return
      const current = useApp.getState().ui[project.id] ?? { tabs: [], activeTab: null, scroll: {} }
      const next = { ...current, activeTab: sessionId, scroll: { ...current.scroll, [sessionId]: anchor } }
      setUi(project.id, next)
      if (uiTimer.current) window.clearTimeout(uiTimer.current)
      uiTimer.current = window.setTimeout(() => send({ type: 'ui.set', projectId: project.id, state: next }), 400)
    },
    [project, sessionId, setUi]
  )

  if (!session) return <main className="flex-1 bg-background" />
  const running = session.run === 'running' || session.run === 'starting' || session.run === 'waiting'

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <TopBar project={project}>{project && <TabBar projectId={project.id} activeSessionId={sessionId} />}</TopBar>
      <div className="flex min-w-0 items-baseline gap-2 border-b border-border px-5 pb-2.5">
        <span className="truncate text-[13.5px] font-semibold">{session.title}</span>
        <span className="truncate text-[12px] text-muted-foreground">
          {project?.name}
          {project?.branch ? ` · ${project.branch}` : ''} · Claude Code
          {session.run === 'waiting' && <span className="font-semibold text-attention"> · {session.waitingLabel}</span>}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatView
          key={sessionId}
          sessionId={sessionId}
          items={items}
          run={session.run}
          activity={session.activity}
          firstUnreadSeq={firstUnread}
          initialAnchor={initialAnchor}
          onAnchorChange={onAnchorChange}
          onRespond={onRespond}
          onOpenFile={onOpenFile}
        />
      </div>
      <div className="flex flex-col items-center px-6 pb-4">
        {error && <p className="mb-2 w-full max-w-[680px] text-[12.5px] text-destructive">{error}</p>}
        <Composer
          key={sessionId}
          draftKey={sessionId}
          agentName="Claude Code"
          models={claude?.models ?? []}
          model={session.model}
          onModelChange={(model) => send({ type: 'session.model.set', sessionId, model })}
          effort={session.effort}
          permission={session.permission}
          onPermissionChange={(permission) => send({ type: 'session.permission.set', sessionId, permission })}
          running={running}
          onSubmit={(text) => request({ type: 'session.send', sessionId, text }).catch((e: Error) => setError(e.message))}
          onStop={() => send({ type: 'session.interrupt', sessionId })}
          queue={session.queue}
          onQueueChange={(queue) => send({ type: 'session.queue.set', sessionId, queue })}
          context={session.context}
          disabledReason={claude && !claude.available ? claude.error : null}
          autoFocus
          className="max-w-[680px]"
        />
      </div>
    </main>
  )
}
