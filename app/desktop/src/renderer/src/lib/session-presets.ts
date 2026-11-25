// Session presets: pure logic to validate them on read, summarize and name them, plus the few gestures that touch the store.
// They are not the account profiles (lib/profiles.ts): here `SessionPreset` is a saved combination of agent, model, effort and permissions.
import type { AgentId, AgentStatus, Effort, PermissionLevel, Profile, Project, SessionPreset, SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { modelLabel } from '@/components/agent-mark'
import { send } from '@/lib/host-client'
import { EFFORTS, levelLabel, supportsEffort } from '@/lib/agents'
import { agentStatusFor, isProfileAgent, normalizeProfileId, profilesOf, projectProfileId } from '@/lib/profiles'
import { capPermission, isValidEffort, isValidModel, launchModel } from '@/lib/session-defaults'
import { useApp } from '@/store/app-store'

/** Limits chosen by main (cleanPresets in main/index.ts): beyond them, presets are dropped without notice. */
export const PRESET_NAME_MAX = 40
export const PRESET_NOTE_MAX = 300
export const PRESET_PROMPT_MAX = 4000
export const PRESET_MAX = 50

/** What in the preset is no longer valid here and falls back to the defaults. */
export type PresetIssue = 'agent' | 'account' | 'model' | 'effort' | 'permission' | 'worktree'

export interface PresetContext {
  agents: AgentStatus[]
  profileAgents: Record<string, AgentStatus>
  profiles: Profile[]
  project: Project | null
  /** Agents allowed by the project; empty = all. */
  allowed: AgentId[]
  maxPermission: PermissionLevel | null
  /** Model each agent starts with when no choice is made (the host's default for the project). */
  agentModels?: Partial<Record<AgentId, string | null>>
}

/** A preset read against the current state: the values still valid and the list of discarded ones. */
export interface AppliedPreset {
  /** Null if the agent is no longer available or allowed: then agent, account, model and effort fall back to the defaults. */
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

/** Discreet phrase for the list of what was corrected; empty string if there is nothing. */
export function presetIssuesNote(name: string, issues: PresetIssue[]): string {
  if (issues.length === 0) return ''
  return t('“{name}” no longer fits here, so Ladder adjusted: {items}.', { name, items: issues.map((issue) => t(ISSUE_LABEL[issue])).join(', ') })
}

/** Validates the preset against the project's agents, accounts, models and limits. Never throws: what is invalid is dropped and reported. */
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
  // Account: only if it still exists and belongs to this agent. Missing in the preset = the project's.
  let profileId: string | null = null
  if (preset.profileId && isProfileAgent(agent)) {
    const known = profilesOf(ctx.profiles, agent).some((p) => p.id === normalizeProfileId(agent, preset.profileId))
    if (known) profileId = normalizeProfileId(agent, preset.profileId)
    else issues.push('account')
  } else if (preset.profileId) {
    issues.push('account')
  }
  // Models and effort are those of the account the session starts with.
  const effectiveProfile = isProfileAgent(agent) ? (profileId ?? projectProfileId(ctx.project, agent, profilesOf(ctx.profiles, agent))) : null
  const status = (isProfileAgent(agent) ? agentStatusFor(ctx, agent, effectiveProfile) : null) ?? base
  // Without a model list (the agent hasn't started yet) the choice can't be disproved: it is kept.
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

/** Inline error for the name, or null if fine. Main drops duplicates ignoring case, so it is said right away here. */
export function presetNameError(name: string, presets: SessionPreset[], ignoreId?: string | null, submitting = false): string | null {
  const clean = name.trim()
  if (!clean) return submitting ? t('Give the profile a name.') : null
  const lower = clean.toLowerCase()
  if (presets.some((p) => p.id !== ignoreId && p.name.toLowerCase() === lower)) return t('A session profile named “{name}” already exists.', { name: clean })
  return null
}

/** Starting point of "Save as preset": the session's agent, account, model, effort and permissions, worktree if it has one. */
export function presetFromSession(session: SessionSummary, profiles: Profile[]): Partial<SessionPreset> {
  // The account is saved only if the agent has more than one: with just one there is nothing to distinguish.
  const profileId = isProfileAgent(session.agent) && profilesOf(profiles, session.agent).length > 1 ? normalizeProfileId(session.agent, session.profileId) : null
  return { agent: session.agent, profileId, model: session.model, effort: session.effort, permission: session.permission, worktree: session.worktree !== null }
}

/** Opens "Save as preset" for a session. */
export function openSavePreset(sessionId: string): void {
  const state = useApp.getState()
  const session = state.sessions[sessionId]
  if (!session || session.mode !== 'chat') return
  state.setPresetEditor({ seed: presetFromSession(session, state.profiles) })
}

/** Writes or removes the project's default preset in the UI state (`defaultPreset`). */
export function setProjectDefaultPreset(projectId: string, presetId: string | null): void {
  const current = useApp.getState().ui[projectId] ?? { tabs: [], activeTab: null, scroll: {} }
  const { defaultPreset: _old, ...rest } = current
  const state = presetId ? { ...rest, defaultPreset: presetId } : rest
  useApp.getState().setUi(projectId, state)
  send({ type: 'ui.set', projectId, state })
}
