// Profili di sessione (LAD-60): logica pura per validarli alla lettura, riassumerli e nominarli, più i pochi gesti che toccano lo store.
// Non sono i profili account di LAD-23 (lib/profiles.ts): qui `SessionPreset` è una combinazione salvata di agente, modello, effort e permessi.
import type { AgentId, AgentStatus, Effort, PermissionLevel, Profile, Project, SessionPreset, SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { modelLabel } from '@/components/agent-mark'
import { send } from '@/lib/host-client'
import { EFFORTS, levelLabel, supportsEffort } from '@/lib/agents'
import { agentStatusFor, isProfileAgent, normalizeProfileId, profilesOf, projectProfileId } from '@/lib/profiles'
import { capPermission, isValidEffort, isValidModel, launchModel } from '@/lib/session-defaults'
import { useApp } from '@/store/app-store'

/** Limiti scelti dal main (cleanPresets in main/index.ts): oltre, i profili vengono scartati senza avviso. */
export const PRESET_NAME_MAX = 40
export const PRESET_NOTE_MAX = 300
export const PRESET_PROMPT_MAX = 4000
export const PRESET_MAX = 50

/** Cosa del profilo non vale più qui e ricade sui predefiniti. */
export type PresetIssue = 'agent' | 'account' | 'model' | 'effort' | 'permission' | 'worktree'

export interface PresetContext {
  agents: AgentStatus[]
  profileAgents: Record<string, AgentStatus>
  profiles: Profile[]
  project: Project | null
  /** Agenti ammessi dal progetto; vuoto = tutti. */
  allowed: AgentId[]
  maxPermission: PermissionLevel | null
  /** Modello con cui parte ogni agente senza una scelta (predefinito dell'host per il progetto). */
  agentModels?: Partial<Record<AgentId, string | null>>
}

/** Un profilo letto contro lo stato attuale: i valori che valgono ancora e l'elenco di quelli scartati. */
export interface AppliedPreset {
  /** Null se l'agente non è più disponibile o ammesso: allora agente, account, modello ed effort ricadono sui predefiniti. */
  agent: AgentId | null
  profileId: string | null
  model: string | null
  effort: Effort | null
  permission: PermissionLevel
  worktree: boolean
  issues: PresetIssue[]
}

const ISSUE_LABEL: Record<PresetIssue, string> = {
  agent: 'agent (no longer available)',
  account: 'account (no longer available)',
  model: 'model (no longer offered)',
  effort: 'effort (not supported by the model)',
  permission: 'permissions (above the project maximum)',
  worktree: 'worktree (not a git project)'
}

/** Frase discreta per l'elenco di ciò che è stato corretto; stringa vuota se non c'è niente. */
export function presetIssuesNote(name: string, issues: PresetIssue[]): string {
  if (issues.length === 0) return ''
  return t('“{name}” no longer fits here, so Ladder adjusted: {items}.', { name, items: issues.map((issue) => t(ISSUE_LABEL[issue])).join(', ') })
}

/** Valida il profilo contro agenti, account, modelli e limiti del progetto. Non lancia mai: ciò che non vale si scarta e si segnala. */
export function applyPreset(preset: SessionPreset, ctx: PresetContext): AppliedPreset {
  const issues: PresetIssue[] = []
  const permission = capPermission(preset.permission, ctx.maxPermission)
  if (permission !== preset.permission) issues.push('permission')
  const worktree = preset.worktree && Boolean(ctx.project?.isGit)
  if (preset.worktree && !worktree) issues.push('worktree')

  const usable = ctx.agents.some((s) => s.agent === preset.agent && s.available) && (ctx.allowed.length === 0 || ctx.allowed.includes(preset.agent))
  if (!usable) return { agent: null, profileId: null, model: null, effort: null, permission, worktree, issues: ['agent', ...issues] }

  const agent = preset.agent
  const base = ctx.agents.find((s) => s.agent === agent)
  // Account: solo se esiste ancora ed è di questo agente. Assente nel profilo = quello del progetto.
  let profileId: string | null = null
  if (preset.profileId && isProfileAgent(agent)) {
    const known = profilesOf(ctx.profiles, agent).some((p) => p.id === normalizeProfileId(agent, preset.profileId))
    if (known) profileId = normalizeProfileId(agent, preset.profileId)
    else issues.push('account')
  } else if (preset.profileId) {
    issues.push('account')
  }
  // Modelli ed effort sono quelli dell'account con cui parte la sessione.
  const effectiveProfile = isProfileAgent(agent) ? (profileId ?? projectProfileId(ctx.project, agent, profilesOf(ctx.profiles, agent))) : null
  const status = (isProfileAgent(agent) ? agentStatusFor(ctx, agent, effectiveProfile) : null) ?? base
  // Senza elenco dei modelli (l'agente non è ancora partito) non si può smentire la scelta: si tiene.
  const known = Boolean(status && status.models.length > 0)

  let model: string | null = null
  if (preset.model) {
    if (!known || isValidModel(status, preset.model)) model = preset.model
    else issues.push('model')
  }
  let effort: Effort | null = null
  if (preset.effort && supportsEffort(agent)) {
    if (!known || isValidEffort(status, model ?? launchModel(status, ctx.agentModels), preset.effort)) effort = preset.effort
    else issues.push('effort')
  }
  return { agent, profileId, model, effort, permission, worktree, issues }
}

/** Riga di riepilogo: "Claude Code · Sonnet 5 · High · Edit · worktree". */
export function presetSummary(preset: SessionPreset, agents: AgentStatus[]): string {
  const status = agents.find((a) => a.agent === preset.agent)
  const effort = preset.effort ? EFFORTS.find((e) => e.id === preset.effort) : null
  return [
    status?.name ?? preset.agent.replace(/^acp:/, ''),
    modelLabel(status, preset.model),
    effort ? t(effort.label) : null,
    levelLabel(preset.permission),
    preset.worktree ? t('worktree') : null
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Errore inline per il nome, o null se va bene. Il main scarta i doppi senza distinguere le maiuscole, quindi qui si dice subito. */
export function presetNameError(name: string, presets: SessionPreset[], ignoreId?: string | null, submitting = false): string | null {
  const clean = name.trim()
  if (!clean) return submitting ? t('Give the profile a name.') : null
  const lower = clean.toLowerCase()
  if (presets.some((p) => p.id !== ignoreId && p.name.toLowerCase() === lower)) return t('A session profile named “{name}” already exists.', { name: clean })
  return null
}

/** Punto di partenza di "Salva come profilo": agente, account, modello, effort e permessi della sessione, worktree se ne ha uno. */
export function presetFromSession(session: SessionSummary, profiles: Profile[]): Partial<SessionPreset> {
  // L'account si salva solo se l'agente ne ha più d'uno: con uno solo non c'è niente da distinguere.
  const profileId = isProfileAgent(session.agent) && profilesOf(profiles, session.agent).length > 1 ? normalizeProfileId(session.agent, session.profileId) : null
  return { agent: session.agent, profileId, model: session.model, effort: session.effort, permission: session.permission, worktree: session.worktree !== null }
}

/** Apre "Salva come profilo" per una sessione. */
export function openSavePreset(sessionId: string): void {
  const state = useApp.getState()
  const session = state.sessions[sessionId]
  if (!session || session.mode !== 'chat') return
  state.setPresetEditor({ seed: presetFromSession(session, state.profiles) })
}

/** Scrive o toglie il profilo predefinito del progetto nello stato UI (`defaultPreset`). */
export function setProjectDefaultPreset(projectId: string, presetId: string | null): void {
  const current = useApp.getState().ui[projectId] ?? { tabs: [], activeTab: null, scroll: {} }
  const { defaultPreset: _old, ...rest } = current
  const state = presetId ? { ...rest, defaultPreset: presetId } : rest
  useApp.getState().setUi(projectId, state)
  send({ type: 'ui.set', projectId, state })
}
