// New-session defaults for the phone: same rules as the renderer's resolveSessionDefaults, but on the Mac.
// Pure functions, relative imports and only `import type`: the file also runs under `node --test`.
import type { AgentId, AgentStatus, Effort, PermissionLevel, RemoteProjectDefaults, SessionDefaults } from '../../shared/protocol.ts'

const LEVELS: PermissionLevel[] = ['plan', 'ask', 'edit', 'full']
const EFFORT_IDS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Only the native agents (Claude Code and Codex) have effort. */
export const supportsEffort = (agent: AgentId): boolean => agent === 'claude-code' || agent === 'codex'

export function capPermission(level: PermissionLevel, max: PermissionLevel | null | undefined): PermissionLevel {
  if (!max) return level
  return LEVELS.indexOf(level) > LEVELS.indexOf(max) ? max : level
}

export const isValidModel = (status: Pick<AgentStatus, 'models'> | undefined, model: string | null | undefined): model is string => Boolean(model && status?.models.some((m) => m.id === model))

/** An effort is valid if the agent supports it and the model (or, with no model, at least one) accepts it; with no known models it is valid only with no model. */
export function isValidEffort(status: Pick<AgentStatus, 'agent' | 'models'> | undefined, model: string | null, effort: Effort | null | undefined): effort is Effort {
  if (!effort || !status || !supportsEffort(status.agent) || !EFFORT_IDS.includes(effort)) return false
  const candidates = model ? status.models.filter((m) => m.id === model) : status.models
  if (candidates.length === 0) return !model
  return candidates.some((m) => m.efforts === undefined || m.efforts.includes(effort))
}

export interface ProjectDefaultsInput {
  /** State of each agent for the account assigned to the project (the project's profile, or the default). */
  agents: Pick<AgentStatus, 'agent' | 'available' | 'models'>[]
  /** ProjectUiState.defaults. */
  project?: SessionDefaults | null
  /** AppPrefs.defaults. */
  global?: SessionDefaults | null
  /** The TOML [agents] default. */
  tomlAgent?: AgentId | null
  lastAgent?: AgentId | null
  allowed: AgentId[]
  maxPermission: PermissionLevel | null
  /** The agent's model and effort for the project (agent config), when known. */
  agentDefaults: (agent: AgentId) => { model: string | null; effort: Effort | null; known: boolean } | null
}

export function resolveRemoteDefaults(input: ProjectDefaultsInput): RemoteProjectDefaults {
  const { project, global } = input
  const usable = (agent: AgentId | null | undefined): agent is AgentId =>
    Boolean(agent) && (input.allowed.length === 0 || input.allowed.includes(agent as AgentId)) && input.agents.some((s) => s.agent === agent && s.available)
  const candidates: (AgentId | null | undefined)[] = [project?.agent, input.tomlAgent, global?.agent, input.lastAgent, 'claude-code', ...input.agents.map((a) => a.agent)]
  const agent = candidates.find(usable) ?? null
  const launch: RemoteProjectDefaults['launch'] = {}
  for (const status of input.agents) {
    if (!usable(status.agent)) continue
    // Like the renderer's resolveSessionDefaults: only what Ladder chooses (project, then global); otherwise null and the session follows the agent.
    const pick = (level: SessionDefaults | null | undefined) => (isValidModel(status, level?.models?.[status.agent]) ? level!.models![status.agent]! : null)
    const model = pick(project) ?? pick(global)
    // Effort is validated against the final model; with no model chosen, against the one the agent starts with.
    const own = input.agentDefaults(status.agent)
    const startModel = model ?? (own?.known && isValidModel(status, own.model) ? own.model : (status.models.find((m) => m.isDefault)?.id ?? null))
    const pickEffort = (level: SessionDefaults | null | undefined) => {
      const e = level?.efforts?.[status.agent]
      return isValidEffort(status, startModel, e) ? e : null
    }
    launch[status.agent] = { model, effort: pickEffort(project) ?? pickEffort(global) }
  }
  // 'full' with "Allow Full access from phone" off is lowered by the gateway (the Mac does not know that here).
  const permission = capPermission(project?.permission ?? global?.permission ?? 'edit', input.maxPermission)
  return { allowed: input.allowed, agent, lastAgent: input.lastAgent ?? null, launch, permission }
}
