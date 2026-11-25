// Advice from other agents: who can be asked and how /advisor and /committee are parsed.
import type { AgentId, AgentStatus, SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { request } from '@/lib/host-client'
import { parseHandoffArgs } from '@/lib/handoff'
import { useApp } from '@/store/app-store'

export const COMMITTEE_MIN = 2
export const COMMITTEE_MAX = 4

/** Why the session cannot ask for advice; null if it can. Also applies while it works. */
export function adviceBlockedReason(session: Pick<SessionSummary, 'mode' | 'archived' | 'parent'>): string | null {
  if (session.mode !== 'chat') return t('Only chat sessions can ask for advice.')
  if (session.archived) return t('Restore this session to ask for advice.')
  if (session.parent) return t('This session is itself advice for another session.')
  return null
}

/** Agents that can be asked: available and allowed by the project. Includes the session agent, which gives a second opinion. */
export function adviceAgents(agents: AgentStatus[], allowed: string[] = []): AgentStatus[] {
  return agents.filter((a) => a.available && (allowed.length === 0 || allowed.includes(a.agent)))
}

/** Why a committee cannot be formed with these agents; null if it can. */
export function committeeBlockedReason(eligible: AgentStatus[]): string | null {
  if (eligible.length >= COMMITTEE_MIN) return null
  if (eligible.length === 1) return t('A committee needs at least two different agents, and only {agent} is available here. Check Settings or the project’s allowed agents.', { agent: eligible[0].name })
  return t('No agent is available here. Check Settings or the project’s allowed agents.')
}

/**
 * /advisor <agent> [question]: with a recognized agent the advice starts immediately; without one, or with a name that cannot be asked,
 * the dialog opens in single mode with the text as the question. /committee [question] always opens the committee dialog.
 * `onError` receives the rejection reason (or null when it starts).
 */
export function runAdviceCommand(
  session: SessionSummary,
  mode: 'advisor' | 'committee',
  args: string,
  agents: AgentStatus[],
  allowed: string[],
  onError: (message: string | null) => void
): void {
  const reason = adviceBlockedReason(session)
  if (reason) return onError(reason)
  onError(null)
  const eligible = adviceAgents(agents, allowed)
  if (mode === 'committee') {
    const blocked = committeeBlockedReason(eligible)
    if (blocked) return onError(blocked)
    return useApp.getState().setAdviceDialog({ sessionId: session.id, mode, question: args.trim() || undefined })
  }
  const parsed = parseHandoffArgs(args, eligible)
  if (!parsed) {
    const known = parseHandoffArgs(args, agents)
    if (known) {
      const name = agents.find((a) => a.agent === known.agent)?.name ?? known.agent
      return onError(t('{agent} is not available for advice here.', { agent: name }))
    }
    return useApp.getState().setAdviceDialog({ sessionId: session.id, mode, question: args.trim() || undefined })
  }
  request({ type: 'session.advise', sessionId: session.id, agents: [{ agent: parsed.agent as AgentId }], question: parsed.note }).catch((e: Error) => onError(e.message))
}
