// Subscriptions with usage limits: one account per native agent and profile, with the sessions running on it.
// The limits panel in the composer and Settings → Subscriptions read from here.
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId, AgentStatus, SessionSummary } from '@shared/protocol'
import { isLinked } from '@/lib/connections'
import { agentsRunning } from '@/lib/session-state'
import { PROFILE_AGENTS, connectionFor, hostProfileId, isProfileAgent, normalizeProfileId, profilesOf } from '@/lib/profiles'
import { useApp } from '@/store/app-store'

/** Stable key of an account: the agent and, for Claude and Codex, the profile (the default is always `default:<agent>`). */
export function accountKey(agent: AgentId, profileId?: string | null): string {
  return isProfileAgent(agent) ? `${agent}:${normalizeProfileId(agent, profileId)}` : agent
}

/** The session consumes the plan right now: working, starting, waiting for an answer in the turn, or idle but with subagents still working. */
export function isInUse(session: SessionSummary): boolean {
  return session.run === 'running' || session.run === 'starting' || session.run === 'waiting' || agentsRunning(session) > 0
}

/** Sessions in use per account (key of `accountKey`), in a single pass. */
export function sessionsInUse(sessions: Iterable<SessionSummary>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const session of sessions) if (isInUse(session)) counts[accountKey(session.agent, session.profileId)] = (counts[accountKey(session.agent, session.profileId)] ?? 0) + 1
  return counts
}

/** Sessions in use with that account: same agent and same profile. */
export function runningSessionsOn(sessions: Iterable<SessionSummary>, agent: AgentId, profileId?: string | null): number {
  return sessionsInUse(sessions)[accountKey(agent, profileId)] ?? 0
}

export interface UsageAccount {
  key: string
  agent: AgentId
  /** Profile to pass to the host: absent for the default and for agents without profiles. */
  profileId: string | undefined
  /** Profile name, only if the agent has more than one. */
  profileName: string | null
  status: AgentStatus | null
  /** Only native agents expose limits and can be reread. */
  native: boolean
  /** It is the open session's account. */
  current: boolean
  running: number
}

/**
 * Connected Claude and Codex accounts (one per profile), with the open session's account first.
 * The session's account always appears, even if it isn't a native agent or the connection can't be read.
 */
export function useUsageAccounts(current: { agent: AgentId; profileId?: string | null }): UsageAccount[] {
  const agents = useApp((s) => s.agents)
  const profileAgents = useApp((s) => s.profileAgents)
  const profiles = useApp((s) => s.profiles)
  const connections = useApp((s) => s.connections)
  const profileConnections = useApp((s) => s.profileConnections)
  // An object of counts, compared field by field: the panel doesn't redraw on every session event.
  const inUse = useApp(useShallow((s) => sessionsInUse(Object.values(s.sessions))))
  const { agent: currentAgent, profileId: currentProfile } = current
  return useMemo(() => {
    const currentKey = accountKey(currentAgent, currentProfile)
    const statusOf = (agent: AgentId, id: string | undefined) => (id ? (profileAgents[id] ?? null) : (agents.find((a) => a.agent === agent) ?? null))
    const list: UsageAccount[] = []
    const add = (agent: AgentId, profileId: string | undefined, profileName: string | null): void => {
      const key = accountKey(agent, profileId)
      if (list.some((a) => a.key === key)) return
      const status = statusOf(agent, profileId)
      list.push({ key, agent, profileId, profileName, status, native: status ? status.kind === 'native' : isProfileAgent(agent), current: key === currentKey, running: inUse[key] ?? 0 })
    }
    for (const agent of PROFILE_AGENTS) {
      const own = profilesOf(profiles, agent)
      for (const profile of own) {
        const id = profile.isDefault ? undefined : profile.id
        const connection = connectionFor({ connections, profileConnections }, agent, profile.id)
        const key = accountKey(agent, profile.id)
        // Connected; or, if the host doesn't send connections, an available agent with an account.
        const linked = connection ? isLinked(connection) : Boolean(statusOf(agent, id)?.available && statusOf(agent, id)?.account)
        if (linked || key === currentKey) add(agent, id, own.length > 1 ? profile.name : null)
      }
    }
    // The session's account is always there: a removed profile or an agent without profiles still appear, without a profile name.
    add(currentAgent, hostProfileId(currentProfile), null)
    // The session's account first, the others in the usual order.
    return list.sort((a, b) => Number(b.current) - Number(a.current))
  }, [agents, profileAgents, profiles, connections, profileConnections, inUse, currentAgent, currentProfile])
}
