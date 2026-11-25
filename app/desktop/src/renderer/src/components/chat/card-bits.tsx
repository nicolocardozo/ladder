// Common pieces of chat rows and system cards (handoffs, resumes, limits, reviews): header, opening line, host actions and reassignment.
import { ChevronRight, CircleStop } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { AgentId, HostCommand, Project } from '@shared/protocol'
import { AgentChoiceFields, useAgentChoice } from '@/components/agent-fields'
import { useProjectSettings } from '@/components/main-views'
import { Button } from '@/components/ui/button'
import { supportsEffort } from '@/lib/agents'
import { handoffTargets } from '@/lib/handoff'
import { request } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

export const rule = <span aria-hidden className="h-px min-w-4 flex-1 bg-border dark:bg-input/60" />
export const linkClass = 'shrink-0 rounded-[5px] px-1.5 py-0.5 text-xs font-medium text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50'
/** Card button: same height and weight as the advice ones. */
export const cardButton = 'h-7 text-sm font-medium'

/** Full-width opening line: symbol, sentence, optional action and rule. */
export function Head({ icon, children, action }: { icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-[22px] min-w-0 items-center gap-2 text-sm leading-[1.5] text-muted-foreground">
      <span className="flex size-[14px] shrink-0 items-center justify-center">{icon}</span>
      <p className="min-w-0 break-words">{children}</p>
      {action}
      {rule}
    </div>
  )
}

export function Disclosure({ id, open, onToggle, children }: { id: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={id}
      className="flex h-[22px] w-fit min-w-0 items-center gap-[7px] rounded-[5px] text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ChevronRight aria-hidden className={cn('size-3 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')} strokeWidth={2.2} />
      {children}
    </button>
  )
}

/** Readable agent name, as the sidebar writes it, usable in a list. */
export function useAgentNames() {
  const agents = useApp((s) => s.agents)
  return (id: AgentId) => agents.find((a) => a.agent === id)?.name ?? (id === 'claude-code' ? 'Claude Code' : id === 'codex' ? 'Codex' : id.replace(/^acp:/, ''))
}

/** Host commands from the cards: one at a time, with the error close at hand. `run` returns true on success. */
export function useHostAction() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = async (key: string, command: HostCommand): Promise<boolean> => {
    if (busy) return false
    setBusy(key)
    setError(null)
    try {
      await request(command)
      return true
    } catch (e) {
      if (alive.current) setError((e as Error).message)
      return false
    } finally {
      if (alive.current) setBusy(null)
    }
  }
  return { busy, error, run }
}

export function ActionError({ error, className }: { error: string | null; className?: string }) {
  if (!error) return null
  return (
    <p role="alert" className={cn('min-w-0 text-xs break-words text-destructive', className)}>
      {error}
    </p>
  )
}

/** Stop button for a running handoff (session.handoff.stop). */
export function StopButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <Button type="button" size="xs" variant="secondary" disabled={busy} aria-busy={busy} aria-label={t('Stop the handoff')} onClick={onClick} className="shrink-0 text-xs font-medium">
      <CircleStop aria-hidden />
      {t('Stop')}
    </Button>
  )
}

/** Choice of another agent, model and effort to resume a handoff (session.handoff.resume with `agent`). */
export function ReassignForm({ sessionId, itemId, own, failed, onClose }: { sessionId: string; itemId: string; own: AgentId; failed: AgentId; onClose: () => void }) {
  const session = useApp((s) => s.sessions[sessionId])
  const project = useApp((s) => s.projects.find((p) => p.id === session?.projectId) ?? null) as Project | null
  const agents = useApp((s) => s.agents)
  const settings = useProjectSettings(project)
  const targets = handoffTargets(agents, own, settings?.agents?.allowed ?? [])
  const choice = useAgentChoice(targets, targets.find((a) => a.agent !== failed)?.agent ?? failed)
  const { agent, model, effort } = choice
  const { busy, error, run } = useHostAction()
  const agentRef = useRef<HTMLButtonElement>(null)
  useEffect(() => agentRef.current?.focus(), [])
  const names = useAgentNames()

  const submit = async () => {
    if (!agent) return
    if (await run('reassign', { type: 'session.handoff.resume', sessionId, itemId, agent, model, effort: supportsEffort(agent) ? effort : null })) onClose()
  }
  return (
    <form
      aria-label={t('Hand off to another agent')}
      className="grid min-w-0 gap-2.5 rounded-[10px] border border-border px-3 py-2.5 dark:border-input/70"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      {targets.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('No other agent is available here. Check Settings or the project’s allowed agents.')}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
          <AgentChoiceFields choice={choice} targets={targets} agentRef={agentRef} />
        </div>
      )}
      <ActionError error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy !== null || !agent} aria-busy={busy === 'reassign'} className={cardButton}>
          {agent ? t('Resume with {agent}', { agent: names(agent) }) : t('Resume handoff')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} className={cardButton}>
          {t('Cancel')}
        </Button>
      </div>
    </form>
  )
}
