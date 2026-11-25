// Defaults for a new session: pure function, no React or store.
// Order: project (ProjectUiState.defaults) → TOML [agents] default (agent only) → globals (AppPrefs.defaults)
// → last used agent → Claude Code or the first available.
import type { AgentId, AgentStatus, Effort, PermissionLevel, SessionDefaults } from '@shared/protocol'
import { EFFORTS, LEVEL_ORDER, supportsEffort } from '@/lib/agents'

export interface ResolveInput {
  agents: AgentStatus[]
  project?: SessionDefaults | null
  global?: SessionDefaults | null
  /** TOML [agents] default of the project. */
  tomlAgent?: AgentId | null
  lastAgent?: AgentId | null
  /** Agents allowed by the project; empty = all. */
  allowed?: AgentId[]
  maxPermission?: PermissionLevel | null
  /** Explicit user choice: wins over every default. */
  forceAgent?: AgentId | null
  /** Model each agent starts with when no choice is made (the agent's default for the project); without it, its isDefault. */
  agentModels?: Partial<Record<AgentId, string | null>>
}

export interface Resolved {
  agent: AgentId | null
  model: string | null
  effort: Effort | null
  permission: PermissionLevel
}

/** Clamps the level to the project's maximum. */
export function capPermission(level: PermissionLevel, max: PermissionLevel | null | undefined): PermissionLevel {
  if (!max) return level
  return LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(max) ? max : level
}

function isUsable(agent: AgentId | null | undefined, input: ResolveInput): agent is AgentId {
  if (!agent) return false
  if (input.allowed && input.allowed.length > 0 && !input.allowed.includes(agent)) return false
  return input.agents.some((s) => s.agent === agent && s.available)
}

export function isValidModel(status: AgentStatus | undefined, model: string | null | undefined): model is string {
  return Boolean(model && status?.models.some((m) => m.id === model))
}

/** An effort is valid if the agent supports it and the model (or, with no model, at least one) accepts it. */
export function isValidEffort(status: AgentStatus | undefined, model: string | null, effort: Effort | null | undefined): effort is Effort {
  if (!effort || !status || !supportsEffort(status.agent) || !EFFORTS.some((e) => e.id === effort)) return false
  const candidates = model ? status.models.filter((m) => m.id === model) : status.models
  if (candidates.length === 0) return !model // models not known yet: no confirmation possible if there is a model
  return candidates.some((m) => m.efforts === undefined || m.efforts.includes(effort))
}

/** Model an agent starts with: the first valid across the levels (most specific first). A single place, for the resolver and the controls. */
export function pickModel(status: AgentStatus | undefined, ...levels: (SessionDefaults | null | undefined)[]): string | null {
  return (status && levels.map((d) => d?.models?.[status.agent]).find((m) => isValidModel(status, m))) || null
}

/** Effort an agent starts with, validated against the final model. */
export function pickEffort(status: AgentStatus | undefined, model: string | null, ...levels: (SessionDefaults | null | undefined)[]): Effort | null {
  return (status && levels.map((d) => d?.efforts?.[status.agent]).find((e) => isValidEffort(status, model, e))) || null
}

/** Model that starts when no level picks one: the agent's default (for the project, if known), then isDefault. */
export function launchModel(status: AgentStatus | undefined, agentModels?: Partial<Record<AgentId, string | null>>): string | null {
  if (!status) return null
  const fromHost = agentModels?.[status.agent]
  return (isValidModel(status, fromHost) ? fromHost : null) ?? status.models.find((m) => m.isDefault)?.id ?? null
}

export function resolveSessionDefaults(input: ResolveInput): Resolved {
  const { project, global } = input
  const candidates: (AgentId | null | undefined)[] = [input.forceAgent, project?.agent, input.tomlAgent, global?.agent, input.lastAgent, 'claude-code', ...input.agents.map((a) => a.agent)]
  const agent = candidates.find((a): a is AgentId => isUsable(a, input)) ?? null
  const status = agent ? input.agents.find((a) => a.agent === agent) : undefined
  const model = pickModel(status, project, global)
  // With no model chosen the agent's own starts: the effort is validated against that, as the composer does.
  const effort = pickEffort(status, model ?? launchModel(status, input.agentModels), project, global)
  const permission = capPermission(project?.permission ?? global?.permission ?? 'edit', input.maxPermission)
  return { agent, model, effort, permission }
}

/** Parts of a saved default that are no longer valid (agent missing or not allowed, unknown model or effort). */
export interface DefaultsIssues {
  agent: boolean
  models: AgentId[]
  efforts: AgentId[]
}

/** `lower`: the level below, which the resolver uses when this level's model is not valid; it lets the effort be validated with the same model. */
export function defaultsIssues(defaults: SessionDefaults | null | undefined, agents: AgentStatus[], allowed: AgentId[] = [], lower?: SessionDefaults | null, agentModels?: Partial<Record<AgentId, string | null>>): DefaultsIssues {
  const issues: DefaultsIssues = { agent: false, models: [], efforts: [] }
  if (!defaults) return issues
  if (defaults.agent) issues.agent = !agents.some((s) => s.agent === defaults.agent && s.available) || (allowed.length > 0 && !allowed.includes(defaults.agent))
  for (const [id, model] of Object.entries(defaults.models ?? {})) {
    const status = agents.find((s) => s.agent === id)
    // 'default' is the alias for "no model": it inherits, it is not an unknown model.
    if (status && status.models.length > 0 && model !== 'default' && !isValidModel(status, model)) issues.models.push(id as AgentId)
  }
  for (const [id, effort] of Object.entries(defaults.efforts ?? {})) {
    const status = agents.find((s) => s.agent === id)
    if (status && status.models.length > 0 && !isValidEffort(status, pickModel(status, defaults, lower) ?? launchModel(status, agentModels), effort)) issues.efforts.push(id as AgentId)
  }
  return issues
}

/** Removes empty fields: an object with nothing in it becomes undefined, so no noise is saved. */
export function compactDefaults(d: SessionDefaults): SessionDefaults | undefined {
  const out: SessionDefaults = {}
  if (d.agent) out.agent = d.agent
  if (d.models && Object.keys(d.models).length > 0) out.models = d.models
  if (d.efforts && Object.keys(d.efforts).length > 0) out.efforts = d.efforts
  if (d.permission) out.permission = d.permission
  return Object.keys(out).length > 0 ? out : undefined
}
