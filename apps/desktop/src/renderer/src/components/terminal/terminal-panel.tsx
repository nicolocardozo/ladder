// Pannello terminale in basso (⌃`): i terminali del progetto in schede. Restano vivi quando cambi progetto
// o chiudi il pannello; si chiudono solo con la ×.
import { useEffect, useMemo, useRef } from 'react'
import { ChevronDown, Play, Plus, RotateCcw, SquareTerminal, X } from 'lucide-react'
import type { TerminalInfo } from '@shared/protocol'
import { request, send } from '@/lib/host-client'
import { disposeTerminal, focusNextTerminal } from '@/lib/terminal-registry'
import { cn } from '@/lib/utils'
import { DEFAULT_TERMINAL_HEIGHT, useApp } from '@/store/app-store'
import { TerminalView } from './terminal-view'

const NO_TERMINALS: TerminalInfo[] = []

/** Terminali del pannello per un progetto: shell e azioni, non le CLI delle sessioni terminale. */
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
  const active = terminals.find((t) => t.id === panel?.active) ?? terminals[terminals.length - 1] ?? null
  const creating = useRef(false)

  // Pannello aperto senza terminali: se ne apre uno nella cartella della sessione.
  useEffect(() => {
    if (terminals.length > 0 || creating.current) return
    creating.current = true
    void newShell(projectId, sessionId, cwd).finally(() => (creating.current = false))
  }, [terminals.length, projectId, sessionId, cwd])

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    const max = Math.round(window.innerHeight * 0.7)
    const move = (e: PointerEvent) => setPanel(projectId, { height: Math.min(max, Math.max(120, startHeight + startY - e.clientY)) })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <section aria-label="Terminali" className="relative flex shrink-0 flex-col border-t border-border bg-background" style={{ height }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Ridimensiona il pannello terminale"
        onPointerDown={startResize}
        className="absolute -top-1 right-0 left-0 z-10 h-2 cursor-row-resize"
      />
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-2" role="tablist" aria-label="Terminali del progetto">
        {terminals.map((t) => {
          const selected = t.id === active?.id
          return (
            <div
              key={t.id}
              className={cn(
                'group flex h-6 max-w-[220px] min-w-0 items-center gap-1 rounded-md pr-0.5 pl-2 text-[12px]',
                selected ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => {
                  focusNextTerminal()
                  setPanel(projectId, { active: t.id })
                }}
                title={`${t.command ?? t.title} · ${t.cwd}${t.port ? ` · LADDER_PORT ${t.port}` : ''}`}
                className="flex min-w-0 items-center gap-1.5 outline-none focus-visible:underline"
              >
                {t.kind === 'run' ? <Play className="size-3 shrink-0" /> : <SquareTerminal className="size-3 shrink-0" />}
                <span className="truncate">{t.title}</span>
                {t.kind === 'run' && t.port && <span className="shrink-0 font-mono text-[10.5px] text-faint">:{t.port}</span>}
                {t.state !== 'running' && (
                  <span className={cn('shrink-0 text-[11px]', t.exitCode ? 'text-destructive' : 'text-faint')}>
                    {t.state === 'stopped' ? 'fermo' : t.exitCode ? `uscito ${t.exitCode}` : 'finito'}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label={`Chiudi ${t.title}`}
                onClick={() => {
                  // Chiudere l'ultimo terminale nasconde il pannello invece di aprirne un altro.
                  if (terminals.length === 1) setPanel(projectId, { open: false, active: null })
                  closeTerminal(t.id)
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
          aria-label="Nuovo terminale"
          title="Nuovo terminale"
          onClick={() => void newShell(projectId, sessionId, cwd)}
          className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Plus className="size-3.5" />
        </button>
        <div className="ml-auto flex items-center gap-1">
          {active && active.state !== 'running' && active.kind === 'run' && (
            <button
              type="button"
              onClick={() => send({ type: 'terminal.restart', id: active.id })}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
            >
              <RotateCcw className="size-3" />
              Riavvia
            </button>
          )}
          {active?.port && <span className="font-mono text-[11px] text-faint">LADDER_PORT {active.port}</span>}
          <button
            type="button"
            aria-label="Nascondi il pannello terminale"
            title="Nascondi (⌃`)"
            onClick={() => setPanel(projectId, { open: false })}
            className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronDown className="size-3.5" />
          </button>
        </div>
      </div>
      {active ? (
        <TerminalView key={active.id} id={active.id} composerKey={composerKey} className="flex-1 px-2 pt-1" />
      ) : (
        <div className="grid flex-1 place-items-center text-[12.5px] text-muted-foreground">Apro un terminale…</div>
      )}
    </section>
  )
}
