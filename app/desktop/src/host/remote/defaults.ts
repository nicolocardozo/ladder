// Predefiniti della nuova sessione per il telefono (LAD-89): stesse regole di resolveSessionDefaults del renderer, ma sul Mac.
// Funzioni pure, import relativi e solo `import type`: il file gira anche sotto `node --test`.
import type { AgentId, AgentStatus, Effort, PermissionLevel, RemoteProjectDefaults, SessionDefaults } from '../../shared/protocol.ts'

const LEVELS: PermissionLevel[] = ['plan', 'ask', 'edit', 'full']
const EFFORT_IDS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Solo gli agenti nativi (Claude Code e Codex) hanno l'effort. */
export const supportsEffort = (agent: AgentId): boolean => agent === 'claude-code' || agent === 'codex'

export function capPermission(level: PermissionLevel, max: PermissionLevel | null | undefined): PermissionLevel {
  if (!max) return level
  return LEVELS.indexOf(level) > LEVELS.indexOf(max) ? max : level
}

export const isValidModel = (status: Pick<AgentStatus, 'models'> | undefined, model: string | null | undefined): model is string => Boolean(model && status?.models.some((m) => m.id === model))

/** Un effort vale se l'agente lo supporta e il modello (o, senza modello, almeno uno) lo accetta; senza modelli noti vale solo senza modello. */
export function isValidEffort(status: Pick<AgentStatus, 'agent' | 'models'> | undefined, model: string | null, effort: Effort | null | undefined): effort is Effort {
  if (!effort || !status || !supportsEffort(status.agent) || !EFFORT_IDS.includes(effort)) return false
  const candidates = model ? status.models.filter((m) => m.id === model) : status.models
  if (candidates.length === 0) return !model
  return candidates.some((m) => m.efforts === undefined || m.efforts.includes(effort))
}

export interface ProjectDefaultsInput {
  /** Stato di ogni agente per l'account assegnato al progetto (profilo del progetto, o il predefinito). */
  agents: Pick<AgentStatus, 'agent' | 'available' | 'models'>[]
  /** ProjectUiState.defaults. */
  project?: SessionDefaults | null
  /** AppPrefs.defaults. */
  global?: SessionDefaults | null
  /** [agents] default del TOML. */
  tomlAgent?: AgentId | null
  lastAgent?: AgentId | null
  allowed: AgentId[]
  maxPermission: PermissionLevel | null
  /** Modello ed effort dell'agente per il progetto (config dell'agente), quando noti. */
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
    // Come resolveSessionDefaults del renderer: solo ciò che Ladder sceglie (progetto, poi globale); altrimenti null e la sessione segue l'agente.
    const pick = (level: SessionDefaults | null | undefined) => (isValidModel(status, level?.models?.[status.agent]) ? level!.models![status.agent]! : null)
    const model = pick(project) ?? pick(global)
    // L'effort si valida contro il modello finale; senza modello scelto, contro quello con cui parte l'agente.
    const own = input.agentDefaults(status.agent)
    const startModel = model ?? (own?.known && isValidModel(status, own.model) ? own.model : (status.models.find((m) => m.isDefault)?.id ?? null))
    const pickEffort = (level: SessionDefaults | null | undefined) => {
      const e = level?.efforts?.[status.agent]
      return isValidEffort(status, startModel, e) ? e : null
    }
    launch[status.agent] = { model, effort: pickEffort(project) ?? pickEffort(global) }
  }
  // 'full' con "Allow Full access from phone" spento lo riduce il gateway (il Mac qui non lo sa).
  const permission = capPermission(project?.permission ?? global?.permission ?? 'edit', input.maxPermission)
  return { allowed: input.allowed, agent, lastAgent: input.lastAgent ?? null, launch, permission }
}
