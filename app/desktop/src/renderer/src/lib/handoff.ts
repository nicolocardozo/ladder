// "Hand off to…": when a session can hand off its work and how the agent typed in /handoff is recognized.
import type { AgentId, AgentStatus, SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'

/** Why the session cannot hand off its work now; null if it can. Only idle, non-archived chats. */
export function handoffBlockedReason(session: Pick<SessionSummary, 'mode' | 'run' | 'archived'>): string | null {
  if (session.mode !== 'chat') return t('Only chat sessions can be handed off.')
  if (session.archived) return t('Restore this session to hand it off.')
  if (session.run !== 'idle' && session.run !== 'error') return t('Wait for the current turn to finish.')
  return null
}

/** Agents to hand off to: available, allowed by the project, different from the session one. */
export function handoffTargets(agents: AgentStatus[], current: AgentId, allowed: string[] = []): AgentStatus[] {
  return agents.filter((a) => a.agent !== current && a.available && (allowed.length === 0 || allowed.includes(a.agent)))
}

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * Arguments of "/handoff <agent> [note]": the first token (or the first two, for "claude code") that matches the id or name
 * of an agent among `targets`. Null if none is recognized: then the dialog opens.
 */
export function parseHandoffArgs(args: string, targets: AgentStatus[]): { agent: AgentId; note: string } | null {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  const matches = (token: string, a: AgentStatus) => {
    const key = norm(token)
    if (!key) return false
    const names = [norm(a.agent.replace(/^acp:/, '')), norm(a.name), norm(a.agent === 'claude-code' ? 'claude' : '')].filter(Boolean)
    return names.includes(key)
  }
  for (const size of [2, 1]) {
    if (words.length < size) continue
    const token = words.slice(0, size).join(' ')
    const found = targets.find((a) => matches(token, a))
    if (found) return { agent: found.agent, note: words.slice(size).join(' ') }
  }
  return null
}

/**
 * /handoff [agent] [note]: with a recognized agent the handoff starts immediately, otherwise "Hand off to…" opens with the note already filled in.
 * `onError` receives the rejection reason (or null when it starts); the caller shows it, as for the other commands.
 */
export function runHandoffCommand(session: SessionSummary, args: string, agents: AgentStatus[], allowed: string[], onError: (message: string | null) => void): void {
  const reason = handoffBlockedReason(session)
  if (reason) return onError(reason)
  onError(null)
  const targets = handoffTargets(agents, session.agent, allowed)
  const parsed = parseHandoffArgs(args, targets)
  if (!parsed) {
    // A known agent that is not allowed, not available or already the session one: say why, instead of opening the dialog with that name as the note.
    const known = parseHandoffArgs(args, agents)
    if (known) {
      const name = agents.find((a) => a.agent === known.agent)?.name ?? known.agent
      return onError(known.agent === session.agent ? t('This session already runs on {agent}.', { agent: name }) : t('{agent} is not available for a handoff here.', { agent: name }))
    }
  }
  if (!parsed) return useApp.getState().setHandoffDialog({ sessionId: session.id, note: args.trim() || undefined })
  request({ type: 'session.handoff', sessionId: session.id, agent: parsed.agent, note: parsed.note || null }).catch((e: Error) => onError(e.message))
}
