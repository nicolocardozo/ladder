// "New session" form: resolves the form values from the defaults the Mac sends per project, and the user's choices
// on top. Pure logic only (no React Native), tested with node --test.
//
// Rules:
// - project: the one you are in (session or project screen), then the last used, then the first in the Mac's order;
// - agent: `defaults.agent`, then `lastAgent`, then the first allowed; allowed = `allowed` (empty = all) among the available ones;
// - profile (account): the one assigned to the project for the agent, otherwise the default; it is chosen only if the agent has more than one,
//   but it is always sent (without it the Mac would use the project's account);
// - model and effort: `launch[agent]` as is (null = the agent's default, and the `isDefault` model is shown); if the user changes
//   agent or account, a model that the new state does not have goes back to null;
// - permission: `defaults.permission` (already reduced by the Mac); above the project's ceiling or Full with access off = level off with the reason.
import type { AgentId, Attachment, Effort, PermissionLevel, Project, ProjectGroupsState, RemoteAgentStatus, RemoteProfile, RemoteProjectDefaults, SessionSummary } from '../../../desktop/src/shared/protocol.ts'
import { t } from '../../../desktop/src/shared/i18n.ts'
import { buildHome, type SectionModel } from './home-model.ts'
import { allowedLevel, PERMISSION_LEVELS } from './permission.ts'
import { isDefaultProfileId, isProfileAgent, profilesOf, statusFor } from './usage.ts'

export const MAX_MESSAGE = 200_000

export interface FormInput {
  projects: Project[]
  projectGroups: ProjectGroupsState | null | undefined
  defaults: Record<string, RemoteProjectDefaults>
  agents: RemoteAgentStatus[]
  profiles: RemoteProfile[]
  permissionsMax: Record<string, PermissionLevel | null>
  allowFull: boolean
  /** The project the user is in right now, if any. */
  contextProjectId?: string | null
  /** The last project in which a session was started from the phone. */
  lastProjectId?: string | null
}

/** User choices: what is missing follows the defaults. `profileId`: null = default account. */
export interface Picks {
  projectId?: string | null
  agent?: AgentId
  profileId?: string | null
  model?: string | null
  effort?: Effort | null
  permission?: PermissionLevel
}

export interface LevelOption {
  level: PermissionLevel
  allowed: boolean
  /** Why it is off: above the project's ceiling, or Full off on the Mac. */
  reason: 'max' | 'full-off' | null
}

export interface ModelOption {
  id: string
  label: string
}

export interface FormValues {
  projectId: string | null
  agent: AgentId | null
  /** Agents to choose from (allowed and available). */
  agentOptions: AgentId[]
  /** Accounts to choose from; empty for agents without accounts. With a single element it is not asked. */
  profileOptions: RemoteProfile[]
  /** Chosen account (real id, the default too) or null without accounts. */
  profile: RemoteProfile | null
  /** Id to send to `session.create`: always that of the chosen account (also `default:<agent>`) when the agent has any; without it, the Mac would use the account assigned to the project and validate the model against that. */
  profileId: string | undefined
  status: RemoteAgentStatus | null
  modelOptions: ModelOption[]
  /** Model to send (null = the agent's default). */
  model: string | null
  /** Label of the model that actually starts (the chosen one or, with null, the agent's default); null if unknown. */
  effectiveModelLabel: string | null
  /** Name of the model the agent starts with when none is chosen (`isDefault`); null if unknown. */
  defaultModelLabel: string | null
  /** Effort levels to choose from for the effective model; empty = the agent has none. */
  effortOptions: Effort[]
  effort: Effort | null
  /** Effort the agent starts with when none is chosen, if known. */
  defaultEffort: Effort | null
  permission: PermissionLevel
  levels: LevelOption[]
}

/** The Mac's sections with their projects (same logic as the Home), to choose the project. */
export function projectSections(projects: Project[], groups: ProjectGroupsState | null | undefined): { id: string; name: string | null; projects: Project[] }[] {
  const home = buildHome({ projects, sessions: [], projectGroups: groups, collapsed: {} })
  return home.sections.map((s: SectionModel) => ({ id: s.id, name: s.titled ? s.name : null, projects: s.projects.map((r) => r.project) }))
}

/** Initial project: where you are, then the last used, then the first in the Mac's order. */
export function pickProject(input: Pick<FormInput, 'projects' | 'projectGroups' | 'contextProjectId' | 'lastProjectId'>): string | null {
  const exists = (id: string | null | undefined): id is string => !!id && input.projects.some((p) => p.id === id)
  if (exists(input.contextProjectId)) return input.contextProjectId
  if (exists(input.lastProjectId)) return input.lastProjectId
  return projectSections(input.projects, input.projectGroups)[0]?.projects[0]?.id ?? null
}

/** Agents available and allowed by the project, without duplicates (an agent with several accounts appears once). */
export function usableAgents(agents: RemoteAgentStatus[], def: RemoteProjectDefaults | undefined): AgentId[] {
  const out: AgentId[] = []
  for (const a of agents) {
    if (!a.available || out.includes(a.agent)) continue
    if (def && def.allowed.length > 0 && !def.allowed.includes(a.agent)) continue
    out.push(a.agent)
  }
  return out
}

/** Permission levels with the disabled ones and the reason. */
export function permissionLevels(max: PermissionLevel | null | undefined, allowFull: boolean): LevelOption[] {
  return PERMISSION_LEVELS.map((level) => {
    if (!allowedLevel(level, max)) return { level, allowed: false, reason: 'max' as const }
    if (level === 'full' && !allowFull) return { level, allowed: false, reason: 'full-off' as const }
    return { level, allowed: true, reason: null }
  })
}

const sameAccount = (a: RemoteProfile, id: string | null | undefined): boolean => (a.isDefault ? isDefaultProfileId(id) : a.id === id)

export function resolveForm(input: FormInput, picks: Picks = {}): FormValues {
  const projectId = picks.projectId !== undefined && input.projects.some((p) => p.id === picks.projectId) ? picks.projectId : pickProject(input)
  const project = input.projects.find((p) => p.id === projectId)
  const def = projectId ? input.defaults[projectId] : undefined
  const agentOptions = usableAgents(input.agents, def)
  const first = [picks.agent, def?.agent, def?.lastAgent].find((a): a is AgentId => !!a && agentOptions.includes(a))
  const agent = first ?? agentOptions[0] ?? null

  // Account: chosen, otherwise the one assigned to the project, otherwise the default.
  const profileOptions = agent && isProfileAgent(agent) ? profilesOf(input.profiles, agent) : []
  const assigned = agent && isProfileAgent(agent) ? project?.profiles?.[agent as 'claude-code' | 'codex'] : undefined
  const wanted = picks.profileId !== undefined ? picks.profileId : assigned
  const profile = profileOptions.find((p) => sameAccount(p, wanted)) ?? profileOptions.find((p) => p.isDefault) ?? profileOptions[0] ?? null
  const profileId = profile?.id
  const status = agent ? statusFor(input.agents, agent, profile?.isDefault ? null : profile?.id) : null

  // Model: chosen, otherwise Ladder's (launch); one that this account does not have goes back to the agent's default.
  const modelOptions = (status?.models ?? []).map((m) => ({ id: m.id, label: m.label }))
  const launch = agent ? def?.launch[agent] : undefined
  const valid = (id: string | null | undefined): id is string => !!id && modelOptions.some((m) => m.id === id)
  const model = picks.model !== undefined ? (valid(picks.model) ? picks.model : null) : valid(launch?.model) ? launch!.model : null
  const modelInfo = status?.models.find((m) => (model ? m.id === model : m.isDefault))
  // Effort: only those of the effective model (without `efforts` the agent has none); one not accepted goes back to the default.
  const effortOptions = modelInfo?.efforts ?? []
  const okEffort = (e: Effort | null | undefined): e is Effort => !!e && effortOptions.includes(e)
  const effort = picks.effort !== undefined ? (okEffort(picks.effort) ? picks.effort : null) : okEffort(launch?.effort) ? launch!.effort : null

  // Permission: chosen, otherwise the one proposed by the Mac; if off, the highest allowed.
  const levels = permissionLevels(projectId ? input.permissionsMax[projectId] : null, input.allowFull)
  const wantedLevel = picks.permission ?? def?.permission ?? 'edit'
  const allowedNow = levels.filter((l) => l.allowed)
  const permission = levels.find((l) => l.level === wantedLevel && l.allowed)?.level ?? allowedNow.filter((l) => PERMISSION_LEVELS.indexOf(l.level) <= PERMISSION_LEVELS.indexOf(wantedLevel)).at(-1)?.level ?? allowedNow[0]?.level ?? 'plan'

  return {
    projectId,
    agent,
    agentOptions,
    profileOptions,
    profile,
    profileId,
    status,
    modelOptions,
    model,
    effectiveModelLabel: modelInfo?.label ?? null,
    defaultModelLabel: status?.models.find((m) => m.isDefault)?.label ?? null,
    effortOptions,
    effort,
    defaultEffort: modelInfo?.defaultEffort ?? null,
    permission,
    levels
  }
}

/** The text can be sent: non-empty (after trim; with at least one image it may be empty) and within the host's limit. */
export const messageError = (text: string, images = 0): 'empty' | 'long' | null => (text.length > MAX_MESSAGE ? 'long' : text.trim().length === 0 && images === 0 ? 'empty' : null)

/** `session.create` command from the resolved form; null if something is missing (project, agent). */
export function createCommand(values: FormValues, text: string, attachments: Attachment[] = []) {
  if (!values.projectId || !values.agent) return null
  return {
    type: 'session.create' as const,
    projectId: values.projectId,
    agent: values.agent,
    text: text.trim(),
    model: values.model,
    effort: values.effort,
    permission: values.permission,
    ...(values.profileId ? { profileId: values.profileId } : {}),
    mode: 'chat' as const,
    ...(attachments.length > 0 ? { attachments } : {})
  }
}

/** Label of an effort level ("Extra high"). */
export const effortName = (effort: Effort): string => ({ low: t('Low'), medium: t('Medium'), high: t('High'), xhigh: t('Extra high'), max: t('Max') })[effort]

/**
 * A session born from this request but whose result never arrived (timeout, connection dropped after sending): the Mac usually sends
 * `session.upsert` before the result, so if there is a new session (id not present before) with the same project, agent and
 * account, with the first message as title (or created after sending), the request succeeded and must not be sent again.
 */
export function findCreated(sessions: SessionSummary[], knownIds: ReadonlySet<string>, command: { projectId: string; agent: AgentId; text: string; profileId?: string }, startedAt: number): SessionSummary | null {
  const first = command.text.trim().split('\n')[0].slice(0, 48)
  const match = sessions.filter(
    (s) =>
      !knownIds.has(s.id) &&
      !s.archived &&
      s.mode === 'chat' &&
      s.projectId === command.projectId &&
      s.agent === command.agent &&
      (command.profileId === undefined || isDefaultProfileId(command.profileId) === isDefaultProfileId(s.profileId)) &&
      s.createdAt >= startedAt - 5_000
  )
  // More than one candidate: the one whose title equals the first message; without a matching title, the first only if it is the only one.
  const alike = (title: string) => {
    const n = Math.min(title.length, first.length, 20)
    return n > 0 && title.slice(0, n).toLowerCase() === first.slice(0, n).toLowerCase()
  }
  return match.find((s) => alike(s.title)) ?? (match.length === 1 ? match[0] : null)
}
