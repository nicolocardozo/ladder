// Modello ed effort con cui parte una sessione che non li ha scelti: predefinito di Ladder (progetto, poi globale),
// poi quello dell'agente (AgentStatus.models[].isDefault / defaultEffort). Funzioni pure.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AgentId, AgentStatus, Effort, SessionDefaults } from '@shared/protocol'
import { t } from '@shared/i18n'
import { EFFORTS } from '@/lib/agents'
import { request } from '@/lib/host-client'

export type DefaultSource = 'project' | 'global' | 'agent'
export interface Effective<T> {
  value: T | null
  source: DefaultSource | null
}

type Models = AgentStatus['models']

const NONE = { value: null, source: null } as const

/** Risposta di `agents.defaults`: i predefiniti dell'agente per un progetto. known false = configurazione che Ladder non sa risolvere. */
export interface AgentDefaults {
  model: string | null
  effort: Effort | null
  known: boolean
}

/**
 * `ladder`: predefiniti di Ladder (progetto, poi globale); valgono solo alla creazione, quindi una sessione già avviata passa null.
 * `agentDefaults`: risposta dell'host per il progetto; senza, si ripiega su `isDefault` a livello utente.
 */
export interface DefaultLevels {
  project?: SessionDefaults | null
  global?: SessionDefaults | null
}

export function effectiveModel(agent: AgentId, models: Models, ladder?: DefaultLevels | null, agentDefaults?: AgentDefaults | null): Effective<string> {
  const known = (id: string | undefined | null) => (id && id !== 'default' && models.some((m) => m.id === id) ? id : null)
  const fromProject = known(ladder?.project?.models?.[agent])
  if (fromProject) return { value: fromProject, source: 'project' }
  const fromGlobal = known(ladder?.global?.models?.[agent])
  if (fromGlobal) return { value: fromGlobal, source: 'global' }
  if (agentDefaults) {
    const id = agentDefaults.known ? known(agentDefaults.model) : null
    return id ? { value: id, source: 'agent' } : NONE
  }
  const own = models.find((m) => m.isDefault)
  return own ? { value: own.id, source: 'agent' } : NONE
}

/** `reported`: l'effort che l'agente dice di usare davvero (SessionSummary.effortEffective). Vince su tutto. */
export function effectiveEffort(agent: AgentId, models: Models, model: string | null, ladder?: DefaultLevels | null, reported?: Effort | null, agentDefaults?: AgentDefaults | null): Effective<Effort> {
  if (reported) return { value: reported, source: 'agent' }
  const levels = (model ? models.find((m) => m.id === model)?.efforts : undefined) ?? EFFORTS.map((e) => e.id)
  const valid = (e: Effort | undefined | null) => (e && EFFORTS.some((x) => x.id === e) && levels.includes(e) ? e : null)
  const fromProject = valid(ladder?.project?.efforts?.[agent])
  if (fromProject) return { value: fromProject, source: 'project' }
  const fromGlobal = valid(ladder?.global?.efforts?.[agent])
  if (fromGlobal) return { value: fromGlobal, source: 'global' }
  if (agentDefaults && !agentDefaults.known) return NONE
  const own = valid(agentDefaults && agentDefaults.model === model ? agentDefaults.effort : models.find((m) => m.id === model)?.defaultEffort)
  return own ? { value: own, source: 'agent' } : NONE
}

// Cache per agente + progetto + profilo: si ricarica al focus della finestra e quando cambia lo stato dell'agente.
const cache = new Map<string, AgentDefaults>()
const listeners = new Set<() => void>()
let revision = 0
/** Chiave stabile dello stato di un agente: modelli, isDefault e defaultEffort. Usage e limiti non la cambiano, quindi non rilanciano agents.defaults. */
export function defaultsToken(status: Pick<AgentStatus, 'agent' | 'profileId' | 'models'> | null | undefined): string {
  return status ? `${status.agent}:${status.profileId ?? ''}:${status.models.map((m) => `${m.id}${m.isDefault ? '*' : ''}${m.defaultEffort ?? ''}`).join(',')}` : ''
}
const keyOf = (agent: AgentId, projectId: string, profileId?: string) => `${agent}|${projectId}|${profileId ?? ''}`
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener))

function load(agent: AgentId, projectId: string, profileId?: string) {
  const key = keyOf(agent, projectId, profileId)
  request<AgentDefaults>({ type: 'agents.defaults', agent, projectId, profileId })
    .then((data) => {
      const old = cache.get(key)
      if (old && old.model === data.model && old.effort === data.effort && old.known === data.known) return
      cache.set(key, data)
      revision++
      listeners.forEach((l) => l())
    })
    .catch(() => undefined)
}

export interface DefaultsTarget {
  agent: AgentId
  /** Profilo per l'host (assente = predefinito). */
  profileId?: string
  /** `defaultsToken(status)`: quando cambia, si ricarica. */
  token?: string
}

/** Predefiniti dell'agente per un progetto, per agente. Mancano finché l'host non risponde o senza progetto: allora si ripiega su isDefault. */
export function useAgentDefaultsMap(projectId: string | null | undefined, targets: DefaultsTarget[]): Partial<Record<AgentId, AgentDefaults>> {
  const version = useSyncExternalStore(subscribe, () => revision)
  const spec = targets.map((x) => `${x.agent}|${x.profileId ?? ''}|${x.token ?? ''}`).join(',')
  useEffect(() => {
    if (!projectId) return
    const run = () => targets.forEach((x) => load(x.agent, projectId, x.profileId))
    run()
    window.addEventListener('focus', run)
    return () => window.removeEventListener('focus', run)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, spec])
  return useMemo(() => {
    const out: Partial<Record<AgentId, AgentDefaults>> = {}
    if (projectId) for (const x of targets) out[x.agent] = cache.get(keyOf(x.agent, projectId, x.profileId)) ?? out[x.agent]
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, spec, version])
}

export function useAgentDefaults(agent: AgentId | null | undefined, projectId: string | null | undefined, profileId: string | undefined, token?: string): AgentDefaults | null {
  const targets = useMemo<DefaultsTarget[]>(() => (agent ? [{ agent, profileId, token }] : []), [agent, profileId, token])
  const map = useAgentDefaultsMap(projectId, targets)
  return (agent && map[agent]) || null
}

/** Testo del tooltip del badge Default. */
export function defaultSourceHint(source: DefaultSource | null, agentName: string): string {
  if (source === 'project') return t('Default from Ladder settings (project)')
  if (source === 'global') return t('Default from Ladder settings (all projects)')
  return t('Default of {agent}', { agent: agentName })
}
