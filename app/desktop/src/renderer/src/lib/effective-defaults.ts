// Model and effort a session starts with when it has not chosen them: Ladder's default (project, then global),
// then the agent's own (AgentStatus.models[].isDefault / defaultEffort). Pure functions.
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

/** Response of `agents.defaults`: the agent's defaults for a project. known false = a configuration Ladder cannot resolve. */
export interface AgentDefaults {
  model: string | null
  effort: Effort | null
  known: boolean
}

/**
 * `ladder`: Ladder's defaults (project, then global); they apply only at creation, so an already started session passes null.
 * `agentDefaults`: the host's response for the project; without it, fall back to user-level `isDefault`.
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

/** `reported`: the effort the agent says it actually uses (SessionSummary.effortEffective). Wins over everything. */
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

// Cache per agent + project + profile: reloaded on window focus and when the agent state changes.
const cache = new Map<string, AgentDefaults>()
const listeners = new Set<() => void>()
let revision = 0
/** Stable key of an agent's state: models, isDefault and defaultEffort. Usage and limits do not change it, so they do not relaunch agents.defaults. */
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
  /** Profile for the host (absent = default). */
  profileId?: string
  /** `defaultsToken(status)`: when it changes, reload. */
  token?: string
}

/** The agent's defaults for a project, per agent. Missing until the host answers or without a project: then fall back to isDefault. */
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

/** Tooltip text of the Default badge. */
export function defaultSourceHint(source: DefaultSource | null, agentName: string): string {
  if (source === 'project') return t('Default from Ladder settings (project)')
  if (source === 'global') return t('Default from Ladder settings (all projects)')
  return t('Default of {agent}', { agent: agentName })
}
