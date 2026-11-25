// Modulo "Nuova sessione" (LAD-89): risolve i valori del modulo dai predefiniti che il Mac manda per progetto, e le scelte
// dell'utente sopra. Solo logica pura (niente React Native), provata con node --test.
//
// Regole:
// - progetto: quello in cui si è (schermata sessione o progetto), poi l'ultimo usato, poi il primo nell'ordine del Mac;
// - agente: `defaults.agent`, poi `lastAgent`, poi il primo ammesso; ammessi = `allowed` (vuoto = tutti) fra i disponibili;
// - profilo (account): quello assegnato al progetto per l'agente, altrimenti il predefinito; solo se l'agente ne ha più d'uno si sceglie,
//   ma si manda sempre (il Mac, senza, userebbe l'account del progetto);
// - modello ed effort: `launch[agente]` com'è (null = predefinito dell'agente, e si mostra il modello `isDefault`); se l'utente cambia
//   agente o account, un modello che il nuovo stato non ha torna a null;
// - permesso: `defaults.permission` (già ridotto dal Mac); sopra il tetto del progetto o Full con l'accesso spento = livello spento con il motivo.
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
  /** Il progetto in cui l'utente si trova adesso, se c'è. */
  contextProjectId?: string | null
  /** L'ultimo progetto in cui ha avviato una sessione dal telefono. */
  lastProjectId?: string | null
}

/** Scelte dell'utente: ciò che manca segue i predefiniti. `profileId`: null = account predefinito. */
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
  /** Perché è spento: sopra il tetto del progetto, o Full spento sul Mac. */
  reason: 'max' | 'full-off' | null
}

export interface ModelOption {
  id: string
  label: string
}

export interface FormValues {
  projectId: string | null
  agent: AgentId | null
  /** Agenti fra cui scegliere (ammessi e disponibili). */
  agentOptions: AgentId[]
  /** Account fra cui scegliere; vuoto per gli agenti senza account. Con un solo elemento non si chiede. */
  profileOptions: RemoteProfile[]
  /** Account scelto (id vero, anche il predefinito) o null senza account. */
  profile: RemoteProfile | null
  /** Id da mandare a `session.create`: sempre quello dell'account scelto (anche `default:<agente>`) quando l'agente ne ha; senza, il Mac userebbe l'account assegnato al progetto e vaglierebbe il modello su quello. */
  profileId: string | undefined
  status: RemoteAgentStatus | null
  modelOptions: ModelOption[]
  /** Modello da mandare (null = predefinito dell'agente). */
  model: string | null
  /** Etichetta del modello che parte davvero (quello scelto o, con null, il predefinito dell'agente); null se non noto. */
  effectiveModelLabel: string | null
  /** Nome del modello con cui parte l'agente quando non se ne sceglie uno (`isDefault`); null se non noto. */
  defaultModelLabel: string | null
  /** Livelli di effort fra cui scegliere per il modello effettivo; vuoto = l'agente non ne ha. */
  effortOptions: Effort[]
  effort: Effort | null
  /** Effort con cui parte l'agente quando non se ne sceglie uno, se noto. */
  defaultEffort: Effort | null
  permission: PermissionLevel
  levels: LevelOption[]
}

/** Le sezioni del Mac con i loro progetti (stessa logica della Home), per scegliere il progetto. */
export function projectSections(projects: Project[], groups: ProjectGroupsState | null | undefined): { id: string; name: string | null; projects: Project[] }[] {
  const home = buildHome({ projects, sessions: [], projectGroups: groups, collapsed: {} })
  return home.sections.map((s: SectionModel) => ({ id: s.id, name: s.titled ? s.name : null, projects: s.projects.map((r) => r.project) }))
}

/** Progetto iniziale: dove si è, poi l'ultimo usato, poi il primo nell'ordine del Mac. */
export function pickProject(input: Pick<FormInput, 'projects' | 'projectGroups' | 'contextProjectId' | 'lastProjectId'>): string | null {
  const exists = (id: string | null | undefined): id is string => !!id && input.projects.some((p) => p.id === id)
  if (exists(input.contextProjectId)) return input.contextProjectId
  if (exists(input.lastProjectId)) return input.lastProjectId
  return projectSections(input.projects, input.projectGroups)[0]?.projects[0]?.id ?? null
}

/** Agenti disponibili e ammessi dal progetto, senza doppioni (un agente con più account compare una volta). */
export function usableAgents(agents: RemoteAgentStatus[], def: RemoteProjectDefaults | undefined): AgentId[] {
  const out: AgentId[] = []
  for (const a of agents) {
    if (!a.available || out.includes(a.agent)) continue
    if (def && def.allowed.length > 0 && !def.allowed.includes(a.agent)) continue
    out.push(a.agent)
  }
  return out
}

/** Livelli di permesso con quelli spenti e il motivo. */
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

  // Account: scelto, altrimenti quello assegnato al progetto, altrimenti il predefinito.
  const profileOptions = agent && isProfileAgent(agent) ? profilesOf(input.profiles, agent) : []
  const assigned = agent && isProfileAgent(agent) ? project?.profiles?.[agent as 'claude-code' | 'codex'] : undefined
  const wanted = picks.profileId !== undefined ? picks.profileId : assigned
  const profile = profileOptions.find((p) => sameAccount(p, wanted)) ?? profileOptions.find((p) => p.isDefault) ?? profileOptions[0] ?? null
  const profileId = profile?.id
  const status = agent ? statusFor(input.agents, agent, profile?.isDefault ? null : profile?.id) : null

  // Modello: scelto, altrimenti quello di Ladder (launch); uno che questo account non ha torna al predefinito dell'agente.
  const modelOptions = (status?.models ?? []).map((m) => ({ id: m.id, label: m.label }))
  const launch = agent ? def?.launch[agent] : undefined
  const valid = (id: string | null | undefined): id is string => !!id && modelOptions.some((m) => m.id === id)
  const model = picks.model !== undefined ? (valid(picks.model) ? picks.model : null) : valid(launch?.model) ? launch!.model : null
  const modelInfo = status?.models.find((m) => (model ? m.id === model : m.isDefault))
  // Effort: solo quelli del modello effettivo (senza `efforts` l'agente non ne ha); uno non accettato torna al predefinito.
  const effortOptions = modelInfo?.efforts ?? []
  const okEffort = (e: Effort | null | undefined): e is Effort => !!e && effortOptions.includes(e)
  const effort = picks.effort !== undefined ? (okEffort(picks.effort) ? picks.effort : null) : okEffort(launch?.effort) ? launch!.effort : null

  // Permesso: scelto, altrimenti quello proposto dal Mac; se spento, il più alto consentito.
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

/** Il testo si può mandare: non vuoto (dopo trim; con almeno un'immagine può esserlo) e non oltre il limite dell'host. */
export const messageError = (text: string, images = 0): 'empty' | 'long' | null => (text.length > MAX_MESSAGE ? 'long' : text.trim().length === 0 && images === 0 ? 'empty' : null)

/** Comando `session.create` dal modulo risolto; null se manca qualcosa (progetto, agente). */
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

/** Etichetta di un livello di effort ("Extra high"). */
export const effortName = (effort: Effort): string => ({ low: t('Low'), medium: t('Medium'), high: t('High'), xhigh: t('Extra high'), max: t('Max') })[effort]

/**
 * Una sessione nata da questa richiesta ma di cui non è arrivato il risultato (timeout, collegamento caduto dopo l'invio): il Mac manda
 * `session.upsert` di solito prima del risultato, quindi se c'è una sessione nuova (id non presente prima) dello stesso progetto, agente e
 * account, con il primo messaggio come titolo (o creata dopo l'invio), la richiesta è andata a buon fine e non va rimandata.
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
  // Più di una candidata: quella col titolo uguale al primo messaggio; senza titolo uguale, la prima solo se è l'unica.
  const alike = (title: string) => {
    const n = Math.min(title.length, first.length, 20)
    return n > 0 && title.slice(0, n).toLowerCase() === first.slice(0, n).toLowerCase()
  }
  return match.find((s) => alike(s.title)) ?? (match.length === 1 ? match[0] : null)
}
