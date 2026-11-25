// Terminal panel at the bottom or right (⌃`): the project's terminals in tabs. They stay alive when you switch project
// or close the panel; they close only with the ×.
import { useEffect, useMemo, useRef } from 'react'
import { ChevronDown, ChevronRight, PanelBottom, PanelRight, Play, Plus, RotateCcw, SquareTerminal, X } from 'lucide-react'
import type { TerminalInfo } from '@shared/protocol'
import { request, send } from '@/lib/host-client'
import { disposeTerminal, focusNextTerminal } from '@/lib/terminal-registry'
import { cn } from '@/lib/utils'
import { DEFAULT_TERMINAL_HEIGHT, DEFAULT_TERMINAL_WIDTH, useApp } from '@/store/app-store'
import { TerminalView } from './terminal-view'
import { t } from '@shared/i18n'

const NO_TERMINALS: TerminalInfo[] = []

/** Start actions and worktree services are processes launched by Ladder: same icon, port and restart. */
const launched = (terminal: TerminalInfo) => terminal.kind === 'run' || terminal.kind === 'service'

/** Panel terminals for a project: shells, actions and services, not the CLIs of terminal sessions. */
export function usePanelTerminals(projectId: string | null): TerminalInfo[] {
  const terminals = useApp((s) => s.terminals)
  return useMemo(() => {
    if (!projectId) return NO_TERMINALS
    const list = Object.values(terminals).filter((t) => t.projectId === projectId && t.kind !== 'agent')
    return list.length ? list.sort((a, b) => a.createdAt - b.createdAt) : NO_TERMINALS
  }, [terminals, projectId])
}

export async function newShell(projectId: string, sessionId: string | null, cwd?: string): Promise<TerminalInfo> {
  focusNextTerminal()
  const terminal = await request<TerminalInfo>({ type: 'terminal.create', projectId, sessionId, cwd })
  useApp.getState().setTerminalPanel(projectId, { open: true, active: terminal.id })
  return terminal
}

export function closeTerminal(id: string): void {
  disposeTerminal(id)
  send({ type: 'terminal.close', id })
}

interface TerminalPanelProps {
  projectId: string
  sessionId: string | null
  cwd: string
  composerKey: string | null
}

export function TerminalPanel({ projectId, sessionId, cwd, composerKey }: TerminalPanelProps) {
  const panel = useApp((s) => s.ui[projectId]?.terminal)
  const setPanel = useApp((s) => s.setTerminalPanel)
  const terminals = usePanelTerminals(projectId)
  const height = panel?.height ?? DEFAULT_TERMINAL_HEIGHT
  const width = panel?.width ?? DEFAULT_TERMINAL_WIDTH
  const right = panel?.side === 'right'
  const active = terminals.find((t) => t.id === panel?.active) ?? terminals[terminals.length - 1] ?? null
  const creating = useRef(false)

  // Panel opened with no terminals: one is opened in the session's folder.
  useEffect(() => {
    if (terminals.length > 0 || creating.current) return
    creating.current = true
    void newShell(projectId, sessionId, cwd).finally(() => (creating.current = false))
  }, [terminals.length, projectId, sessionId, cwd])

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const startHeight = height
    const startWidth = width
    const max = Math.round(window.innerHeight * 0.7)
    const maxWidth = Math.round(window.innerWidth * 0.6)
    const move = (e: PointerEvent) =>
      right
        ? setPanel(projectId, { width: Math.min(maxWidth, Math.max(280, startWidth + startX - e.clientX)) })
        : setPanel(projectId, { height: Math.min(max, Math.max(120, startHeight + startY - e.clientY)) })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <section aria-label={t('Terminals')} className={cn('relative flex shrink-0 flex-col border-border bg-background', right ? 'border-l' : 'border-t')} style={right ? { width } : { height }}>
      <div
        role="separator"
        aria-orientation={right ? 'vertical' : 'horizontal'}
        aria-label={t('Resize terminal panel')}
        onPointerDown={startResize}
        className={cn('absolute z-10', right ? 'top-0 bottom-0 -left-1 w-2 cursor-col-resize' : 'right-0 -top-1 left-0 h-2 cursor-row-resize')}
      />
      <div className={cn('flex shrink-0 items-center gap-0.5 border-b border-border px-2 [&_button]:no-drag', right ? 'drag h-11' : 'h-8')} role="tablist" aria-label={t('Project terminals')}>
        {terminals.map((terminal) => {
          const selected = terminal.id === active?.id
          return (
            <div
              key={terminal.id}
              className={cn(
                'group flex h-6 max-w-[220px] min-w-0 items-center gap-1 rounded-md pr-0.5 pl-2 text-xs',
                selected ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => {
                  focusNextTerminal()
                  setPanel(projectId, { active: terminal.id })
                }}
                title={`${terminal.command ?? terminal.title} · ${terminal.cwd}${terminal.port ? ` · LADDER_PORT ${terminal.port}` : ''}`}
                className="flex min-w-0 items-center gap-1.5 outline-none focus-visible:underline"
              >
                {launched(terminal) ? <Play className="size-3 shrink-0" /> : <SquareTerminal className="size-3 shrink-0" />}
                <span className="truncate">{terminal.title}</span>
                {launched(terminal) && terminal.port && <span className="shrink-0 font-mono text-xs text-faint">:{terminal.port}</span>}
                {terminal.state !== 'running' && (
                  <span className={cn('shrink-0 text-xs', terminal.exitCode ? 'text-destructive' : 'text-faint')}>
                    {terminal.state === 'stopped' ? t('stopped') : terminal.exitCode ? t('exited {code}', { code: terminal.exitCode }) : t('done')}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label={t('Close {title}', { title: terminal.title })}
                onClick={() => {
                  // Closing the last terminal hides the panel instead of opening another.
                  if (terminals.length === 1) setPanel(projectId, { open: false, active: null })
                  closeTerminal(terminal.id)
                }}
                className="grid size-5 shrink-0 place-items-center rounded opacity-60 outline-none hover:bg-background/60 hover:opacity-100 focus-visible:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          )
        })}
        <button
          type="button"
          aria-label={t('New terminal')}
          title={t('New terminal')}
          onClick={() => void newShell(projectId, sessionId, cwd)}
          className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Plus className="size-3.5" />
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap pl-1">
          {active && active.state !== 'running' && launched(active) && (
            <button
              type="button"
              onClick={() => send({ type: 'terminal.restart', id: active.id })}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <RotateCcw className="size-3" />
              {t('Restart')}
            </button>
          )}
          {active?.port && active.kind !== 'service' && <span className="font-mono text-xs text-faint">LADDER_PORT {active.port}</span>}
          <button
            type="button"
            aria-label={right ? t('Move terminal to the bottom') : t('Move terminal to the right')}
            title={right ? t('Move terminal to the bottom') : t('Move terminal to the right')}
            onClick={() => setPanel(projectId, { side: right ? 'bottom' : 'right' })}
            className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {right ? <PanelBottom className="size-3.5" /> : <PanelRight className="size-3.5" />}
          </button>
          <button
            type="button"
            aria-label={t('Hide terminal panel')}
            title={t('Hide (⌃`)')}
            onClick={() => setPanel(projectId, { open: false })}
            className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {right ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        </div>
      </div>
      {active ? (
        <TerminalView key={active.id} id={active.id} composerKey={composerKey} className="flex-1 px-2 pt-1" />
      ) : (
        <div className="grid flex-1 place-items-center text-sm text-muted-foreground">{t('Opening a terminal…')}</div>
      )}
    </section>
  )
}
