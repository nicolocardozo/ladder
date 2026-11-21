// Profili (LAD-23): più account per Claude Code e Codex. Elenchi, stato in uso e scelte per progetto e sessione.
// Senza profili nello store (fixture, host vecchio) ogni agente ha il solo predefinito, sintetizzato qui.
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

/** Id normalizzato: il predefinito è sempre `default:<agente>`, anche se l'host lo manda assente o null. */
export function normalizeProfileId(agent: ProfileAgent, id: string | null | undefined): string {
  return isDefaultProfileId(id) ? defaultProfileId(agent) : id!
}

/** Id da mandare all'host: assente per il predefinito. */
export function hostProfileId(id: string | null | undefined): string | undefined {
  return isDefaultProfileId(id) ? undefined : id!
}

/** Profili di un agente, predefinito per primo, poi per data di creazione. Il predefinito manca? Lo si sintetizza. */
export function profilesOf(all: Profile[], agent: ProfileAgent): Profile[] {
  const own = all.filter((p) => p.agent === agent).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.addedAt - b.addedAt)
  if (own.some((p) => p.isDefault)) return own
  return [{ id: defaultProfileId(agent), agent, name: t('Default'), configDir: null, isDefault: true, addedAt: 0 }, ...own]
}

export function useProfiles(agent: AgentId | null | undefined): Profile[] {
  const all = useApp((s) => s.profiles)
  return useMemo(() => (agent && isProfileAgent(agent) ? profilesOf(all, agent) : []), [all, agent])
}

/** Stato dell'agente per un profilo: il predefinito sta in `agents`, gli altri in `profileAgents`. */
export function agentStatusFor(state: Pick<ReturnType<typeof useApp.getState>, 'agents' | 'profileAgents'>, agent: AgentId, profileId?: string | null): AgentStatus | null {
  if (!isDefaultProfileId(profileId)) return state.profileAgents[profileId!] ?? null
  return state.agents.find((a) => a.agent === agent) ?? null
}

export function connectionFor(state: Pick<ReturnType<typeof useApp.getState>, 'connections' | 'profileConnections'>, agent: ProfileAgent, profileId?: string | null): ConnectionStatus | undefined {
  return isDefaultProfileId(profileId) ? state.connections[agent] : state.profileConnections[profileId!]
}

/** Stato dell'agente per il profilo dato. Un profilo senza stato proprio (non ancora letto) non prende in prestito quello del predefinito. */
export function useAgentStatusFor(agent: AgentId | null | undefined, profileId?: string | null): AgentStatus | null {
  return useApp((s) => (agent ? agentStatusFor(s, agent, profileId) : null))
}

/**
 * Come si nomina l'agente di una sessione nei testi: il nome del suo stato (Claude Code, Codex, un agente ACP) oppure,
 * in una sessione terminale, "<comando> in the terminal". Senza sessione, il predefinito.
 */
export function useSessionAgentLabel(session: SessionSummary | null | undefined): string {
  const status = useAgentStatusFor(session?.agent, session?.profileId)
  const fallback = useApp((s) => s.agents.find((a) => a.agent === session?.agent)?.name)
  if (session?.mode === 'terminal') return t('{command} in the terminal', { command: session.command ?? 'claude' })
  return status?.name ?? fallback ?? FALLBACK_AGENT.name
}

/** Profilo scelto dal progetto per l'agente (assente = predefinito), se esiste ancora. */
export function projectProfileId(project: Project | null | undefined, agent: ProfileAgent, profiles: Profile[]): string {
  const chosen = project?.profiles?.[agent]
  return chosen && profiles.some((p) => p.id === chosen) ? chosen : defaultProfileId(agent)
}

/**
 * Nome del profilo di una sessione, solo se l'agente ne ha più di uno: chi ne ha uno non vede niente di nuovo.
 * Il profilo non cambia dopo la creazione.
 */
export function useSessionProfileName(session: Pick<SessionSummary, 'agent' | 'profileId'> | null | undefined): string | null {
  const agent = session?.agent
  const profiles = useProfiles(agent)
  if (!session || !agent || !isProfileAgent(agent) || profiles.length < 2) return null
  const id = normalizeProfileId(agent, session.profileId)
  return profiles.find((p) => p.id === id)?.name ?? null
}

/** Nome da mostrare per un profilo: "Claude · Lavoro" quando l'agente ne ha più d'uno, il solo nome dell'agente altrimenti. */
export function profileTitle(agentName: string, profile: Profile, count: number): string {
  return count > 1 ? `${agentName} · ${profile.name}` : agentName
}
