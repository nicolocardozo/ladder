// Abbonamenti con limiti d'uso (LAD-82): un account per agente nativo e profilo, con le sessioni in corso su di esso.
// Il pannello dei limiti nel composer e Impostazioni → Abbonamenti leggono da qui.
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId, AgentStatus, SessionSummary } from '@shared/protocol'
import { isLinked } from '@/lib/connections'
import { agentsRunning } from '@/lib/session-state'
import { PROFILE_AGENTS, connectionFor, hostProfileId, isProfileAgent, normalizeProfileId, profilesOf } from '@/lib/profiles'
import { useApp } from '@/store/app-store'

/** Chiave stabile di un account: l'agente e, per Claude e Codex, il profilo (il predefinito è sempre `default:<agente>`). */
export function accountKey(agent: AgentId, profileId?: string | null): string {
  return isProfileAgent(agent) ? `${agent}:${normalizeProfileId(agent, profileId)}` : agent
}

/** La sessione consuma il piano adesso: lavora, parte, aspetta una risposta nel turno, o è ferma ma con sotto-agenti ancora al lavoro. */
export function isInUse(session: SessionSummary): boolean {
  return session.run === 'running' || session.run === 'starting' || session.run === 'waiting' || agentsRunning(session) > 0
}

/** Sessioni in uso per account (chiave di `accountKey`), in un solo passaggio. */
export function sessionsInUse(sessions: Iterable<SessionSummary>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const session of sessions) if (isInUse(session)) counts[accountKey(session.agent, session.profileId)] = (counts[accountKey(session.agent, session.profileId)] ?? 0) + 1
  return counts
}

/** Sessioni in uso con quell'account: stesso agente e stesso profilo. */
export function runningSessionsOn(sessions: Iterable<SessionSummary>, agent: AgentId, profileId?: string | null): number {
  return sessionsInUse(sessions)[accountKey(agent, profileId)] ?? 0
}

export interface UsageAccount {
  key: string
  agent: AgentId
  /** Profilo da passare all'host: assente per il predefinito e per gli agenti senza profili. */
  profileId: string | undefined
  /** Nome del profilo, solo se l'agente ne ha più di uno. */
  profileName: string | null
  status: AgentStatus | null
  /** Solo gli agenti nativi espongono i limiti e si possono rileggere. */
  native: boolean
  /** È l'account della sessione aperta. */
  current: boolean
  running: number
}

/**
 * Account collegati di Claude e Codex (uno per profilo), con quello della sessione aperta per primo.
 * L'account della sessione compare sempre, anche se non è un agente nativo o se il collegamento non è leggibile.
 */
export function useUsageAccounts(current: { agent: AgentId; profileId?: string | null }): UsageAccount[] {
  const agents = useApp((s) => s.agents)
  const profileAgents = useApp((s) => s.profileAgents)
  const profiles = useApp((s) => s.profiles)
  const connections = useApp((s) => s.connections)
  const profileConnections = useApp((s) => s.profileConnections)
  // Un oggetto di conteggi, confrontato campo per campo: il pannello non si ridisegna a ogni evento di una sessione.
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
        // Collegato; o, se l'host non manda i collegamenti, un agente disponibile con un account.
        const linked = connection ? isLinked(connection) : Boolean(statusOf(agent, id)?.available && statusOf(agent, id)?.account)
        if (linked || key === currentKey) add(agent, id, own.length > 1 ? profile.name : null)
      }
    }
    // L'account della sessione c'è sempre: un profilo rimosso o un agente senza profili compaiono lo stesso, senza nome di profilo.
    add(currentAgent, hostProfileId(currentProfile), null)
    // L'account della sessione per primo, gli altri nell'ordine di sempre.
    return list.sort((a, b) => Number(b.current) - Number(a.current))
  }, [agents, profileAgents, profiles, connections, profileConnections, inUse, currentAgent, currentProfile])
}
