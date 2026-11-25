// Pezzi condivisi dei sotto-agenti: segno di stato, testi del modello e dell'effort, token.
import { Check, CircleX, Square } from 'lucide-react'
import { useCallback } from 'react'
import { localeTag, t } from '@shared/i18n'
import type { AgentId, SubagentInfo } from '@shared/protocol'
import { modelLabel } from '@/components/agent-mark'
import { RunningRing } from '@/components/status'
import { EFFORTS } from '@/lib/agents'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

export function formatTokens(n: number): string {
  return new Intl.NumberFormat(localeTag(), { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

/** Stato in uno slot da 16 px: anello, spunta menta, croce rosa, quadrato tenue. */
export function StatusMark({ status, className }: { status: SubagentInfo['status']; className?: string }) {
  switch (status) {
    case 'running':
      return <RunningRing className={className} />
    case 'done':
      return <Check role="img" aria-label={t('Completed')} className={cn('size-3.5 text-success', className)} strokeWidth={2.4} />
    case 'error':
      return <CircleX role="img" aria-label={t('Error')} className={cn('size-3.5 text-destructive', className)} strokeWidth={2.2} />
    default:
      return <Square role="img" aria-label={t('Stopped')} className={cn('size-3 text-muted-foreground', className)} strokeWidth={2.4} />
  }
}

export function effortLabel(effort: SubagentInfo['effort']): string | null {
  if (!effort) return null
  const label = EFFORTS.find((e) => e.id === effort)?.label
  return label ? t(label).toLowerCase() : effort
}

/**
 * Il modello di un sotto-agente come lo mostra la UI: quello suo, o (se non noto) quello della sessione con "inherited".
 * Restituisce una funzione stabile finché non cambiano agente e modello della sessione.
 */
export function useAgentModel(agent: AgentId, sessionModel: string | null): (a: Pick<SubagentInfo, 'model'> & { kind?: string | null }) => string | null {
  const agents = useApp((s) => s.agents)
  return useCallback(
    (a) => {
      // A delegation has kind = the provider agent name: its model is read from that agent's catalog,
      // and without a model it does not inherit the session one (it uses its agent default).
      const own = a.kind ? agents.find((x) => x.name === a.kind && x.agent !== agent) : undefined
      // Without a model the delegation uses its agent default, never the parent one.
      if (own) return modelLabel(own, a.model) ?? t('Default model')
      const status = agents.find((x) => x.agent === agent) ?? null
      if (a.model) return modelLabel(status, a.model)
      const inherited = modelLabel(status, sessionModel)
      return inherited ? t('{model} (inherited)', { model: inherited }) : null
    },
    [agents, agent, sessionModel]
  )
}

/** Agent of a delegation: the subagent with kind = name of another installed agent; null for regular subagents. */
export function useDelegateAgent(kind: string | null | undefined, sessionAgent: AgentId): AgentId | null {
  return useApp((s) => (kind ? (s.agents.find((x) => x.name === kind && x.agent !== sessionAgent)?.agent ?? null) : null))
}
