// Profiles: multiple accounts for Claude Code and Codex. Lists, in-use state and choices per project and session.
// Without profiles in the store (fixtures, old host) every agent has only the default, synthesized here.
import { useMemo } from 'react'
import type { AgentId, AgentStatus, ConnectionStatus, Profile, ProfileAgent, Project, SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { FALLBACK_AGENT } from '@/lib/agents'
import { isDefaultProfileId } from '@/lib/profile-id'
import { useApp } from '@/store/app-store'

export { isDefaultProfileId }

export const PROFILE_AGENTS: ProfileAgent[] = ['claude-code', 'codex']

export function isProfileAgent(agent: AgentId): agent is ProfileAgent {
  return agent === 'claude-code' || agent === 'codex'
}

export function defaultProfileId(agent: ProfileAgent): string {
  return `default:${agent}`
}

/** Normalized id: the default is always `default:<agent>`, even if the host sends it absent or null. */
export function normalizeProfileId(agent: ProfileAgent, id: string | null | undefined): string {
  return isDefaultProfileId(id) ? defaultProfileId(agent) : id!
}

/** Id to send to the host: absent for the default. */
export function hostProfileId(id: string | null | undefined): string | undefined {
  return isDefaultProfileId(id) ? undefined : id!
}

/** An agent's profiles, default first, then by creation date. Default missing? It is synthesized. */
export function profilesOf(all: Profile[], agent: ProfileAgent): Profile[] {
  const own = all.filter((p) => p.agent === agent).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.addedAt - b.addedAt)
  if (own.some((p) => p.isDefault)) return own
  return [{ id: defaultProfileId(agent), agent, name: t('Default'), configDir: null, isDefault: true, addedAt: 0 }, ...own]
}

export function useProfiles(agent: AgentId | null | undefined): Profile[] {
  const all = useApp((s) => s.profiles)
  return useMemo(() => (agent && isProfileAgent(agent) ? profilesOf(all, agent) : []), [all, agent])
}

/** Agent state for a profile: the default lives in `agents`, the others in `profileAgents`. */
export function agentStatusFor(state: Pick<ReturnType<typeof useApp.getState>, 'agents' | 'profileAgents'>, agent: AgentId, profileId?: string | null): AgentStatus | null {
  if (!isDefaultProfileId(profileId)) return state.profileAgents[profileId!] ?? null
  return state.agents.find((a) => a.agent === agent) ?? null
}

export function connectionFor(state: Pick<ReturnType<typeof useApp.getState>, 'connections' | 'profileConnections'>, agent: ProfileAgent, profileId?: string | null): ConnectionStatus | undefined {
  return isDefaultProfileId(profileId) ? state.connections[agent] : state.profileConnections[profileId!]
}

/** Agent state for the given profile. A profile without its own state (not yet read) does not borrow the default's. */
export function useAgentStatusFor(agent: AgentId | null | undefined, profileId?: string | null): AgentStatus | null {
  return useApp((s) => (agent ? agentStatusFor(s, agent, profileId) : null))
}

/**
 * How to name a session's agent in texts: the name of its state (Claude Code, Codex, an ACP agent) or,
 * in a terminal session, "<command> in the terminal". Without a session, the default.
 */
export function useSessionAgentLabel(session: SessionSummary | null | undefined): string {
  const status = useAgentStatusFor(session?.agent, session?.profileId)
  const fallback = useApp((s) => s.agents.find((a) => a.agent === session?.agent)?.name)
  if (session?.mode === 'terminal') return t('{command} in the terminal', { command: session.command ?? 'claude' })
  return status?.name ?? fallback ?? FALLBACK_AGENT.name
}

/** Profile chosen by the project for the agent (absent = default), if it still exists. */
export function projectProfileId(project: Project | null | undefined, agent: ProfileAgent, profiles: Profile[]): string {
  const chosen = project?.profiles?.[agent]
  return chosen && profiles.some((p) => p.id === chosen) ? chosen : defaultProfileId(agent)
}

/**
 * Name of a session's profile, only if the agent has more than one: whoever has one sees nothing new.
 * The profile does not change after creation.
 */
export function useSessionProfileName(session: Pick<SessionSummary, 'agent' | 'profileId'> | null | undefined): string | null {
  const agent = session?.agent
  const profiles = useProfiles(agent)
  if (!session || !agent || !isProfileAgent(agent) || profiles.length < 2) return null
  const id = normalizeProfileId(agent, session.profileId)
  return profiles.find((p) => p.id === id)?.name ?? null
}

/** Name to show for a profile: "Claude · Work" when the agent has more than one, just the agent name otherwise. */
export function profileTitle(agentName: string, profile: Profile, count: number): string {
  return count > 1 ? `${agentName} · ${profile.name}` : agentName
}
