// Predefiniti di una nuova sessione: funzione pura, senza React né store.
// Ordine: progetto (ProjectUiState.defaults) → [agents] default del TOML (solo agente) → globali (AppPrefs.defaults)
// → ultimo agente usato → Claude Code o il primo disponibile.
import type { AgentId, AgentStatus, Effort, PermissionLevel, SessionDefaults } from '@shared/protocol'
import { EFFORTS, LEVEL_ORDER, supportsEffort } from '@/lib/agents'

export interface ResolveInput {
  agents: AgentStatus[]
  project?: SessionDefaults | null
  global?: SessionDefaults | null
  /** [agents] default del TOML del progetto. */
  tomlAgent?: AgentId | null
  lastAgent?: AgentId | null
  /** Agenti ammessi dal progetto; vuoto = tutti. */
  allowed?: AgentId[]
  maxPermission?: PermissionLevel | null
  /** Scelta esplicita dell'utente: vince su ogni predefinito. */
  forceAgent?: AgentId | null
  /** Modello con cui parte ogni agente senza una scelta (predefinito dell'agente per il progetto); senza, il suo isDefault. */
  agentModels?: Partial<Record<AgentId, string | null>>
}

export interface Resolved {
  agent: AgentId | null
  model: string | null
  effort: Effort | null
  permission: PermissionLevel
}

/** Riduce il livello al massimo del progetto. */
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

/** Un effort vale se l'agente lo supporta e il modello (o, senza modello, almeno uno) lo accetta. */
export function isValidEffort(status: AgentStatus | undefined, model: string | null, effort: Effort | null | undefined): effort is Effort {
  if (!effort || !status || !supportsEffort(status.agent) || !EFFORTS.some((e) => e.id === effort)) return false
  const candidates = model ? status.models.filter((m) => m.id === model) : status.models
  if (candidates.length === 0) return !model // modelli non ancora noti: nessuna conferma possibile se c'è un modello
  return candidates.some((m) => m.efforts === undefined || m.efforts.includes(effort))
}

/** Modello con cui parte un agente: il primo valido tra i livelli (dal più specifico). Un solo punto, per resolver e controlli. */
export function pickModel(status: AgentStatus | undefined, ...levels: (SessionDefaults | null | undefined)[]): string | null {
  return (status && levels.map((d) => d?.models?.[status.agent]).find((m) => isValidModel(status, m))) || null
}

/** Effort con cui parte un agente, validato contro il modello finale. */
export function pickEffort(status: AgentStatus | undefined, model: string | null, ...levels: (SessionDefaults | null | undefined)[]): Effort | null {
  return (status && levels.map((d) => d?.efforts?.[status.agent]).find((e) => isValidEffort(status, model, e))) || null
}

/** Modello che parte quando nessun livello ne sceglie uno: predefinito dell'agente (per il progetto, se noto), poi isDefault. */
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
  // Senza modello scelto parte quello dell'agente: l'effort si valida contro quello, come fa il composer.
  const effort = pickEffort(status, model ?? launchModel(status, input.agentModels), project, global)
  const permission = capPermission(project?.permission ?? global?.permission ?? 'edit', input.maxPermission)
  return { agent, model, effort, permission }
}

/** Parti di un predefinito salvato che non valgono più (agente assente o non ammesso, modello o effort sconosciuti). */
export interface DefaultsIssues {
  agent: boolean
  models: AgentId[]
  efforts: AgentId[]
}

/** `lower`: il livello sotto, che il resolver usa quando il modello di questo non vale; serve a validare l'effort con lo stesso modello. */
export function defaultsIssues(defaults: SessionDefaults | null | undefined, agents: AgentStatus[], allowed: AgentId[] = [], lower?: SessionDefaults | null, agentModels?: Partial<Record<AgentId, string | null>>): DefaultsIssues {
  const issues: DefaultsIssues = { agent: false, models: [], efforts: [] }
  if (!defaults) return issues
  if (defaults.agent) issues.agent = !agents.some((s) => s.agent === defaults.agent && s.available) || (allowed.length > 0 && !allowed.includes(defaults.agent))
  for (const [id, model] of Object.entries(defaults.models ?? {})) {
    const status = agents.find((s) => s.agent === id)
    // 'default' è l'alias di "nessun modello": eredita, non è un modello sconosciuto.
    if (status && status.models.length > 0 && model !== 'default' && !isValidModel(status, model)) issues.models.push(id as AgentId)
  }
  for (const [id, effort] of Object.entries(defaults.efforts ?? {})) {
    const status = agents.find((s) => s.agent === id)
    if (status && status.models.length > 0 && !isValidEffort(status, pickModel(status, defaults, lower) ?? launchModel(status, agentModels), effort)) issues.efforts.push(id as AgentId)
  }
  return issues
}

/** Toglie campi vuoti: un oggetto senza nulla diventa undefined, così non si salva rumore. */
export function compactDefaults(d: SessionDefaults): SessionDefaults | undefined {
  const out: SessionDefaults = {}
  if (d.agent) out.agent = d.agent
  if (d.models && Object.keys(d.models).length > 0) out.models = d.models
  if (d.efforts && Object.keys(d.efforts).length > 0) out.efforts = d.efforts
  if (d.permission) out.permission = d.permission
  return Object.keys(out).length > 0 ? out : undefined
}
