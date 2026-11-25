// Impostazioni → New sessions: predefiniti di agente, modello, effort e permesso (globali o per progetto) e tasto di invio.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AgentId, AgentStatus, Effort, PermissionLevel, ProfileAgent, Project, ProjectUiState, SendKey, SessionDefaults } from '@shared/protocol'
import { t } from '@shared/i18n'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Kbd } from '@/components/ui/kbd'
import { AgentMark, modelLabel } from '@/components/agent-mark'
import { EffortTrack, effortName } from '@/components/composer/effort-slider'
import { useProjectSettings } from '@/components/main-views'
import { ProjectAgentSwitches } from '@/components/settings-agent-switches'
import { ProjectDelegates } from '@/components/settings-delegates'
import { PresetsSection } from '@/components/settings-presets'
import { usePrefs } from '@/hooks/use-prefs'
import { agentBrowserEnabled } from '@/lib/browser-agent'
import { allowedLevels, EFFORTS, levelHint, levelLabel, permissionLevels, supportsEffort } from '@/lib/agents'
import { defaultsToken, effectiveEffort, effectiveModel, useAgentDefaults, type DefaultLevels } from '@/lib/effective-defaults'
import { request, send } from '@/lib/host-client'
import { agentStatusFor, defaultProfileId, hostProfileId, isProfileAgent, PROFILE_AGENTS, profilesOf, projectProfileId, useProfiles } from '@/lib/profiles'
import { altSendCombo, sendKeyCombos } from '@/lib/send-key'
import { compactDefaults, defaultsIssues, pickModel, resolveSessionDefaults } from '@/lib/session-defaults'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

const INHERIT = '__inherit'
const GLOBAL = '__global'
const OFF = '__off'
const ON = '__on'
const EMPTY: SessionDefaults = {}

function Row({ label, hint, warning, children }: { label: string; hint?: ReactNode; warning?: string | null; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        {warning ? <span className="text-xs text-destructive">{warning}</span> : hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  )
}

function AgentLabel({ agent, status }: { agent: AgentId; status?: AgentStatus }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AgentMark agent={agent} size={14} />
      <span className="truncate">{status?.name ?? agent.replace(/^acp:/, '')}</span>
    </span>
  )
}

/** Account con cui partono le nuove sessioni di un progetto, per agente. Solo se l'agente ha più di un profilo; le sessioni esistenti tengono il loro. */
function ProjectProfileRow({ project, agent }: { project: Project; agent: ProfileAgent }) {
  const profiles = useProfiles(agent)
  const status = useApp((s) => s.agents.find((a) => a.agent === agent))
  const [error, setError] = useState<string | null>(null)
  if (profiles.length < 2) return null
  const current = projectProfileId(project, agent, profiles)
  const choose = (id: string) => {
    const profileId = id === defaultProfileId(agent) ? null : id
    // Ottimista: si vede subito; se l'host rifiuta (per esempio profilo rimosso da un'altra finestra) si torna al progetto di prima.
    const before = project
    const { [agent]: _old, ...others } = project.profiles ?? {}
    const next: Project = { ...project, profiles: profileId ? { ...others, [agent]: profileId } : others }
    const replace = (value: Project) => useApp.setState((s) => ({ projects: s.projects.map((p) => (p.id === value.id ? value : p)) }))
    setError(null)
    replace(next)
    request({ type: 'project.profile', projectId: project.id, agent, profileId }).catch((e: Error) => {
      replace(before)
      setError(e.message)
    })
  }
  const label = t('{agent} account', { agent: status?.name ?? agent })
  return (
    <Row label={label} hint={t('New sessions in this project use it. Existing sessions keep theirs.')} warning={error}>
      <Select value={current} onValueChange={(value) => choose(String(value))}>
        <SelectTrigger aria-label={label} className="w-[220px]">
          <SelectValue>{(value: string) => profiles.find((p) => p.id === value)?.name ?? value}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {profiles.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  )
}

/** Testo scritto da un modello in questo progetto: segue l'impostazione globale oppure è spento qui. Non può accendere ciò che è spento globalmente. */
function ProjectGeneratedTextRow({ project, globalOn }: { project: Project; globalOn: boolean }) {
  const off = useApp((s) => s.ui[project.id]?.generatedText === false)
  const choose = (value: string) => {
    const current: ProjectUiState = useApp.getState().ui[project.id] ?? { tabs: [], activeTab: null, scroll: {} }
    const { generatedText: _old, ...rest } = current
    const state: ProjectUiState = value === OFF ? { ...rest, generatedText: false } : rest
    useApp.getState().setUi(project.id, state)
    send({ type: 'ui.set', projectId: project.id, state })
  }
  const label = t('Written text')
  return (
    <Row label={label} hint={off ? t('No written commit, PR or branch name in this project.') : globalOn ? t('Commit, PR and branch name can be written for you.') : t('Off for all projects, in Written text below.')}>
      <Select value={off ? OFF : INHERIT} onValueChange={(value) => choose(String(value))}>
        <SelectTrigger aria-label={label} className="w-[220px]">
          <SelectValue>{(value: string) => (value === OFF ? t('Off for this project') : t('Use global setting'))}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT}>{t('Use global setting')}</SelectItem>
          <SelectItem value={OFF}>{t('Off for this project')}</SelectItem>
        </SelectContent>
      </Select>
    </Row>
  )
}

/**
 * Accensione del browser per l'agente: spenta vale subito, accesa solo alla prossima ripartenza dell'agente di una sessione.
 * Se la sessione aperta (del progetto, o di uno qualunque con `projectId` null) non lo ha ancora, lo si dice.
 */
function AgentBrowserRestartNote({ projectId }: { projectId: string | null }) {
  const prefs = useApp((s) => s.prefs)
  const selection = useApp((s) => s.selection)
  const ui = useApp((s) => (selection.projectId ? s.ui[selection.projectId] : undefined))
  const agentOn = useApp((s) => (selection.kind === 'session' ? s.agentBrowser[selection.sessionId]?.enabled === true : false))
  const session = useApp((s) => (selection.kind === 'session' ? s.sessions[selection.sessionId] : undefined))
  if (!session || session.mode === 'terminal' || (projectId && session.projectId !== projectId)) return null
  if (!agentBrowserEnabled(prefs, ui) || agentOn) return null
  return (
    <span role="status" className="text-xs text-muted-foreground">
      {t('“{title}” is already running: it gets the browser the next time its agent restarts.', { title: session.title })}
    </span>
  )
}

/** Browser per l'agente in questo progetto: segue l'impostazione globale oppure la scavalca (acceso o spento). */
function ProjectAgentBrowserRow({ project, globalOn }: { project: Project; globalOn: boolean }) {
  const own = useApp((s) => s.ui[project.id]?.agentBrowser)
  const choose = (value: string) => {
    const current: ProjectUiState = useApp.getState().ui[project.id] ?? { tabs: [], activeTab: null, scroll: {} }
    // Assente = vale il globale.
    const { agentBrowser: _old, ...rest } = current
    const state: ProjectUiState = value === ON ? { ...rest, agentBrowser: true } : value === OFF ? { ...rest, agentBrowser: false } : rest
    useApp.getState().setUi(project.id, state)
    send({ type: 'ui.set', projectId: project.id, state })
  }
  const label = t('Browser for the agent')
  const value = own === true ? ON : own === false ? OFF : INHERIT
  const hint =
    own === true
      ? t('On in this project. Sessions pick it up the next time their agent restarts.')
      : own === false
        ? t('Off in this project. Sessions lose the browser right away.')
        : globalOn
          ? t('Follows the global setting, which is on.')
          : t('Follows the global setting, which is off.')
  return (
    <Row label={label} hint={<span className="flex flex-col gap-0.5"><span>{hint}</span><AgentBrowserRestartNote projectId={project.id} /></span>}>
      <Select value={value} onValueChange={(next) => choose(String(next))}>
        <SelectTrigger aria-label={label} className="w-[220px]">
          <SelectValue>{(v: string) => (v === ON ? t('On for this project') : v === OFF ? t('Off for this project') : t('Use global setting'))}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT}>{t('Use global setting')}</SelectItem>
          <SelectItem value={ON}>{t('On for this project')}</SelectItem>
          <SelectItem value={OFF}>{t('Off for this project')}</SelectItem>
        </SelectContent>
      </Select>
    </Row>
  )
}

export function DefaultsSection() {
  const [prefs, update] = usePrefs()
  const baseAgents = useApp((s) => s.agents)
  const profileAgents = useApp((s) => s.profileAgents)
  const allProfiles = useApp((s) => s.profiles)
  const projects = useApp((s) => s.projects)
  const selected = useApp((s) => s.selection.projectId)
  const [scope, setScope] = useState<string>(GLOBAL)
  const project = scope === GLOBAL ? null : (projects.find((p) => p.id === scope) ?? null)
  // Se il progetto scelto non esiste più, si torna a "All projects".
  useEffect(() => {
    if (scope !== GLOBAL && !project) setScope(GLOBAL)
  }, [scope, project])
  // Con un progetto scelto, modelli ed effort sono quelli dell'account che il progetto usa per quell'agente, non per forza il predefinito.
  const agents = useMemo(
    () =>
      baseAgents.map((a) => {
        if (!project || !isProfileAgent(a.agent)) return a
        const id = projectProfileId(project, a.agent, profilesOf(allProfiles, a.agent))
        return agentStatusFor({ agents: baseAgents, profileAgents }, a.agent, id) ?? { ...a, models: [] }
      }),
    [baseAgents, profileAgents, allProfiles, project]
  )
  const settings = useProjectSettings(project)
  const projectUi = useApp((s) => (project ? s.ui[project.id] : undefined))
  const lastAgent = projectUi?.lastAgent
  const allowed = (project ? (settings?.agents.allowed ?? []) : []) as AgentId[]
  const maxPermission = project ? (settings?.agents.permissionsMax ?? null) : null
  const tomlAgent = (project ? settings?.agents.default : null) as AgentId | null | undefined
  const globalDefaults = prefs?.defaults ?? EMPTY
  const own: SessionDefaults = (project ? projectUi?.defaults : globalDefaults) ?? EMPTY

  // "Inherit" = cosa si otterrebbe senza i valori di questo livello; "effective" = cosa parte davvero.
  const inherited = useMemo(
    () => resolveSessionDefaults({ agents, project: null, global: project ? globalDefaults : EMPTY, tomlAgent, lastAgent, allowed, maxPermission }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, globalDefaults, settings, lastAgent, project]
  )
  const effective = resolveSessionDefaults({ agents, project: project ? own : null, global: project ? globalDefaults : own, tomlAgent, lastAgent, allowed, maxPermission })
  const issues = defaultsIssues(own, agents, allowed, project ? globalDefaults : null, Object.fromEntries(agents.map((a) => [a.agent, a.models.find((m) => m.isDefault)?.id ?? null])))

  const write = (change: (d: SessionDefaults) => SessionDefaults) => {
    const next = compactDefaults(change({ ...own }))
    if (!project) {
      // Il main fa un merge superficiale: si manda l'oggetto defaults completo.
      update({ defaults: next ?? {} })
      return
    }
    const current: ProjectUiState = useApp.getState().ui[project.id] ?? { tabs: [], activeTab: null, scroll: {} }
    const { defaults: _old, ...rest } = current
    const state: ProjectUiState = next ? { ...rest, defaults: next } : rest
    useApp.getState().setUi(project.id, state)
    send({ type: 'ui.set', projectId: project.id, state })
  }

  // Predefiniti dell'agente per il progetto (host); senza progetto si ripiega su isDefault.
  const levelAgent: AgentId | null = own.agent && !issues.agent ? own.agent : effective.agent
  const levelStatus = agents.find((a) => a.agent === levelAgent)
  const levelProfile = project && levelAgent && isProfileAgent(levelAgent) ? hostProfileId(projectProfileId(project, levelAgent, profilesOf(allProfiles, levelAgent))) : undefined
  const agentDefaults = useAgentDefaults(levelAgent, project?.id, levelProfile, defaultsToken(levelStatus))

  if (!prefs) return <p className="text-sm text-muted-foreground">{t('Preferences are available in the app.')}</p>

  // Modello ed effort si salvano per agente: si modifica quello con cui parte questo livello.
  const editAgent: AgentId | null = own.agent && !issues.agent ? own.agent : effective.agent
  const editStatus = agents.find((a) => a.agent === editAgent)
  // Un 'default' salvato vale "nessun modello": eredita.
  const storedModel = editAgent && own.models?.[editAgent] !== 'default' ? own.models?.[editAgent] : undefined
  const modelKnown = Boolean(editStatus?.models.some((m) => m.id === storedModel))
  const storedEffort = editAgent ? own.efforts?.[editAgent] : undefined
  // Senza modello nei predefiniti parte quello dell'agente: i livelli di effort sono i suoi.
  const effortModelId = pickModel(editStatus, own, project ? globalDefaults : null) ?? (editAgent && editStatus ? effectiveModel(editAgent, editStatus.models, null, agentDefaults).value : null)
  const effortModel = editStatus?.models.find((m) => m.id === effortModelId)
  const allEfforts = EFFORTS.map((e) => e.id)
  const union = new Set<Effort>((editStatus?.models ?? []).flatMap((m) => m.efforts ?? allEfforts))
  const levels: Effort[] = effortModel?.efforts ?? (editStatus && editStatus.models.length > 0 ? allEfforts.filter((id) => union.has(id)) : allEfforts)
  const showEffort = Boolean(editAgent && supportsEffort(editAgent) && levels.length > 0)
  const levelsOk = allowedLevels(maxPermission)
  const hasValues = Boolean(compactDefaults(own))

  const agentOf = (a: AgentId) => agents.find((s) => s.agent === a)
  const inheritAgentLabel = project && inherited.agent ? (agentOf(inherited.agent)?.name ?? inherited.agent) : t('Last used')
  // Cosa parte senza i valori di questo livello: il livello sotto (tutti i progetti) e, in fondo, il predefinito dell'agente.
  const lower: DefaultLevels | null = project ? { global: globalDefaults } : null
  const inheritedModelId = editAgent && editStatus ? effectiveModel(editAgent, editStatus.models, lower, agentDefaults).value : null
  const effectiveModelName = inheritedModelId ? modelLabel(editStatus, inheritedModelId) : null
  // Riepilogo: ciò che parte davvero, con il predefinito dell'agente in fondo.
  const summaryStatus = effective.agent ? agentOf(effective.agent) : undefined
  const summaryModel = effective.agent && summaryStatus ? effectiveModel(effective.agent, summaryStatus.models, project ? { project: own, global: globalDefaults } : { global: own }, agentDefaults).value : null
  const summaryEffort = effective.agent && summaryStatus && supportsEffort(effective.agent) ? effectiveEffort(effective.agent, summaryStatus.models, summaryModel, project ? { project: own, global: globalDefaults } : { global: own }, null, agentDefaults).value : null
  const inheritedEffort = editAgent && editStatus ? effectiveEffort(editAgent, editStatus.models, effortModelId, lower, null, agentDefaults).value : null
  const forAgent = t('For {agent}', { agent: editStatus?.name ?? '' })

  return (
    <>
      <DialogTitle className="text-xl font-semibold">{t('New sessions')}</DialogTitle>
      <DialogDescription className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
        {t('What a new chat starts with. A project can have its own values; anything left on “Inherit” falls back to all projects, then to the last agent you used. You can always change them in the composer.')}
      </DialogDescription>

      <div className="mt-6 flex items-center gap-3">
        <span className="text-sm font-medium">{t('Applies to')}</span>
        <Select value={scope} onValueChange={(value) => setScope(String(value))}>
          <SelectTrigger aria-label={t('Applies to')} className="w-[240px]">
            <SelectValue>{(value: string) => (value === GLOBAL ? t('All projects') : (projects.find((p) => p.id === value)?.name ?? value))}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value={GLOBAL}>{t('All projects')}</SelectItem>
            {[...projects]
              .sort((a, b) => (a.id === selected ? -1 : b.id === selected ? 1 : 0))
              .map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          disabled={!hasValues}
          onClick={() => write(() => ({}))}
          className="ml-auto h-8 rounded-md border border-input px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {project ? t('Reset this project') : t('Reset all projects')}
        </button>
      </div>

      <div className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
        <Row
          label={t('Agent')}
          hint={own.agent ? null : t('Inherit: {value}', { value: inheritAgentLabel })}
          warning={issues.agent && own.agent ? t('{agent} is no longer available here; new sessions skip this default.', { agent: agentOf(own.agent)?.name ?? own.agent.replace(/^acp:/, '') }) : null}
        >
          <Select value={own.agent ?? INHERIT} onValueChange={(value) => write((d) => ({ ...d, agent: value === INHERIT ? null : (value as AgentId) }))}>
            <SelectTrigger aria-label={t('Agent')} className="w-[220px]">
              <SelectValue>{(value: string) => (value === INHERIT ? t('Inherit') : <AgentLabel agent={value as AgentId} status={agentOf(value as AgentId)} />)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>{t('Inherit')}</SelectItem>
              {own.agent && !agentOf(own.agent) && <SelectItem value={own.agent}>{own.agent.replace(/^acp:/, '')}</SelectItem>}
              {agents.map((a) => (
                <SelectItem key={a.agent} value={a.agent} disabled={!a.available || (allowed.length > 0 && !allowed.includes(a.agent))}>
                  <AgentLabel agent={a.agent} status={a} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        {project && PROFILE_AGENTS.map((agent) => <ProjectProfileRow key={agent} project={project} agent={agent} />)}

        {project && <ProjectGeneratedTextRow project={project} globalOn={prefs?.generatedText ?? true} />}

        {project && <ProjectAgentBrowserRow project={project} globalOn={prefs?.agentBrowser ?? false} />}

        <Row
          label={t('Model')}
          hint={
            editStatus && editStatus.models.length === 0
              ? t('The list appears after {agent} starts for the first time.', { agent: editStatus.name })
              : storedModel
                ? forAgent
                : t('Inherit: {value}', { value: effectiveModelName ?? t('Default model') })
          }
          warning={storedModel && editStatus && editStatus.models.length > 0 && !modelKnown ? t('{model} is no longer offered by {agent}; new sessions use the default model.', { model: storedModel, agent: editStatus.name }) : null}
        >
          <Select
            value={storedModel ?? INHERIT}
            disabled={!editAgent || !editStatus || editStatus.models.length === 0}
            onValueChange={(value) =>
              write((d) => {
                const models = { ...d.models }
                const efforts = { ...d.efforts }
                if (editAgent) {
                  if (value === INHERIT) delete models[editAgent]
                  else models[editAgent] = String(value)
                  // Un effort che il nuovo modello non accetta non si tiene.
                  const accepted = editStatus?.models.find((m) => m.id === value)?.efforts
                  const current = efforts[editAgent]
                  if (current && accepted && !accepted.includes(current)) delete efforts[editAgent]
                }
                return { ...d, models, efforts }
              })
            }
          >
            <SelectTrigger aria-label={t('Model')} className="w-[220px]">
              {editAgent && <AgentMark agent={editAgent} size={14} className="text-muted-foreground" />}
              <SelectValue>{(value: string) => (value === INHERIT ? t('Inherit') : (modelLabel(editStatus, value) ?? value))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>{t('Inherit')}</SelectItem>
              {storedModel && !modelKnown && <SelectItem value={storedModel}>{storedModel}</SelectItem>}
              {editStatus?.models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        {showEffort && editAgent && (
          <Row
            label={t('Effort')}
            hint={storedEffort ? forAgent : inheritedEffort ? t('Inherit: {value}', { value: effortName(levels, inheritedEffort) }) : t('Inherited')}
            warning={issues.efforts.includes(editAgent) ? t('This effort is not supported by the model; new sessions ignore it.') : null}
          >
            {storedEffort && (
              <button
                type="button"
                aria-label={t('Reset effort')}
                onClick={() =>
                  write((d) => {
                    const efforts = { ...d.efforts }
                    delete efforts[editAgent]
                    return { ...d, efforts }
                  })
                }
                className="h-7 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {t('Reset')}
              </button>
            )}
            {/* Con un valore salvato si vede il suo nome (anche se non vale più); senza, il livello con cui si parte. */}
            <span className="w-20 text-right text-sm text-muted-foreground">
              {storedEffort ? (EFFORTS.find((e) => e.id === storedEffort) ? t(EFFORTS.find((e) => e.id === storedEffort)!.label) : storedEffort) : effortName(levels, inheritedEffort)}
            </span>
            <EffortTrack
              standalone
              pinned={!storedEffort}
              muted={!storedEffort || !levels.includes(storedEffort)}
              levels={levels}
              value={storedEffort && levels.includes(storedEffort) ? storedEffort : storedEffort ? null : inheritedEffort}
              label={t('Effort')}
              onChange={(effort) => write((d) => ({ ...d, efforts: { ...d.efforts, [editAgent]: effort } }))}
            />
          </Row>
        )}

        <Row
          label={t('Permissions')}
          hint={own.permission ? levelHint(own.permission) : t('Inherit: {value}', { value: levelLabel(effective.permission) })}
          warning={own.permission && !levelsOk.includes(own.permission) ? t('Above the maximum this project allows (.ladder/settings.toml); new sessions use {level}.', { level: levelLabel(effective.permission) }) : null}
        >
          <Select value={own.permission ?? INHERIT} onValueChange={(value) => write((d) => ({ ...d, permission: value === INHERIT ? null : (value as PermissionLevel) }))}>
            <SelectTrigger aria-label={t('Permissions')} className="w-[220px]">
              <SelectValue>{(value: string) => (value === INHERIT ? t('Inherit') : levelLabel(value as PermissionLevel))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>{t('Inherit')}</SelectItem>
              {permissionLevels.map((p) => (
                <SelectItem key={p.id} value={p.id} disabled={!levelsOk.includes(p.id)}>
                  {levelLabel(p.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </div>

      {/* Riepilogo: provider e modello ovunque compaia una sessione. */}
      <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground" aria-live="polite">
        {project ? t('New chats in {project} start with', { project: project.name }) : t('New chats start with')}
        {effective.agent ? (
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <AgentMark agent={effective.agent} size={13} />
            <span className="font-semibold">{agentOf(effective.agent)?.name ?? effective.agent}</span>
            <span className="text-muted-foreground">· {(summaryModel && modelLabel(summaryStatus, summaryModel)) || t('Default model')}</span>
            {summaryEffort && <span className="text-muted-foreground">· {t(EFFORTS.find((e) => e.id === summaryEffort)?.label ?? '').toLowerCase()}</span>}
            <span className="text-muted-foreground">· {levelLabel(effective.permission)}</span>
          </span>
        ) : (
          <span>{t('No agent available')}</span>
        )}
      </p>

      {project && settings && <ProjectAgentSwitches project={project} settings={settings} />}
      {project && settings && <ProjectDelegates project={project} delegates={settings.agents.delegates ?? []} />}

      {/* Da 820 px su due colonne: profili e tasto di invio, poi titoli, testo scritto e browser. */}
      <div className="grid items-start gap-x-10 @[820px]:grid-cols-2">
        <div className="min-w-0">
          <PresetsSection />
          <SendKeySection />
        </div>
        <div className="min-w-0">
          <TitlesSection />
          <GeneratedTextSection />
          <AgentBrowserSection />
        </div>
      </div>
    </>
  )
}

function SendKeySection() {
  const [prefs, update] = usePrefs()
  const current: SendKey = prefs?.sendKey ?? 'enter'
  const options: SendKey[] = ['enter', 'mod-enter']
  return (
    <section className="mt-10 flex flex-col gap-2">
      <h3 className="text-lg font-semibold">{t('Send key')}</h3>
      <p className="max-w-[62ch] text-sm text-muted-foreground">{t('Applies to every box where you write a message: the composer, queued messages, prompts, line comments and the terminal launcher.')}</p>
      <div className="mt-2 flex flex-col divide-y divide-border rounded-lg border border-border" role="radiogroup" aria-label={t('Send key')}>
        {options.map((option) => {
          const combos = sendKeyCombos(option)
          const active = current === option
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => update({ sendKey: option })}
              className={cn('flex items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50', active ? 'bg-accent/60' : 'hover:bg-accent/40')}
            >
              <span aria-hidden className={cn('grid size-4 shrink-0 place-items-center rounded-full border', active ? 'border-primary' : 'border-input')}>
                {active && <span className="size-2 rounded-full bg-primary" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{option === 'enter' ? t('Enter sends') : t('Modifier and Enter sends')}</span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Kbd>{combos.send}</Kbd> {t('sends')} · <Kbd>{combos.newline}</Kbd> {t('new line')}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <BusySendSection />
    </section>
  )
}

function BusySendSection() {
  const [prefs, update] = usePrefs()
  const current = prefs?.busySend ?? 'steer'
  const sendKey = prefs?.sendKey ?? 'enter'
  const options: { id: 'steer' | 'queue'; label: string; hint: string }[] = [
    { id: 'steer', label: t('Sends into the turn'), hint: t('The agent reads it at its next step. Where it can’t, the message is queued.') },
    { id: 'queue', label: t('Queues for the end'), hint: t('The message waits and starts when the turn is over.') }
  ]
  return (
    <div className="mt-6 flex flex-col gap-2">
      <h4 className="text-sm font-semibold">{t('While the agent is working, the send key')}</h4>
      <p className="text-xs text-muted-foreground">{t('The other action: {key}, or the buttons on each queued message.', { key: altSendCombo(sendKey) })}</p>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border" role="radiogroup" aria-label={t('While the agent is working, the send key')}>
        {options.map((option) => {
          const active = current === option.id
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => update({ busySend: option.id })}
              className={cn('flex items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50', active ? 'bg-accent/60' : 'hover:bg-accent/40')}
            >
              <span aria-hidden className={cn('grid size-4 shrink-0 place-items-center rounded-full border', active ? 'border-primary' : 'border-input')}>
                {active && <span className="size-2 rounded-full bg-primary" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.hint}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Titoli generati: un modello piccolo del fornitore propone il titolo dopo la prima risposta. */
function TitlesSection() {
  const [prefs, update] = usePrefs()
  return (
    <section className="mt-10 flex flex-col gap-2">
      <h3 className="text-lg font-semibold">{t('Session titles')}</h3>
      <div className="mt-2 flex flex-col rounded-lg border border-border">
        <label className="flex items-center justify-between gap-6 px-4 py-3.5">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">{t('Generated titles')}</span>
            <span className="max-w-[62ch] text-sm text-muted-foreground">
              {t('A small model from your own provider suggests a title after the first reply. Titles you write yourself are never changed.')}
            </span>
          </span>
          <input
            type="checkbox"
            checked={prefs?.generatedTitles ?? true}
            disabled={!prefs}
            onChange={(e) => update({ generatedTitles: e.target.checked })}
            className="size-4 shrink-0 accent-primary [color-scheme:light] dark:[color-scheme:dark]"
          />
        </label>
      </div>
    </section>
  )
}

/** Testo scritto da un modello su richiesta: messaggio di commit, titolo e descrizione della PR, nome del branch. */
function GeneratedTextSection() {
  const [prefs, update] = usePrefs()
  return (
    <section className="mt-10 flex flex-col gap-2">
      <h3 className="text-lg font-semibold">{t('Written text')}</h3>
      <div className="mt-2 flex flex-col rounded-lg border border-border">
        <label className="flex items-center justify-between gap-6 px-4 py-3.5">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">{t('Written text')}</span>
            <span className="max-w-[62ch] text-sm text-muted-foreground">
              {t('A small model from your own provider writes the commit message and the PR title and description when you ask, and you can edit the result. It also names the branch automatically when a session is created. Session titles follow “Generated titles” instead. A single project can turn this off, in New sessions.')}
            </span>
          </span>
          <input
            type="checkbox"
            checked={prefs?.generatedText ?? true}
            disabled={!prefs}
            onChange={(e) => update({ generatedText: e.target.checked })}
            className="size-4 shrink-0 accent-primary [color-scheme:light] dark:[color-scheme:dark]"
          />
        </label>
      </div>
    </section>
  )
}

/** Browser per l'agente: strumenti browser_* in un browser separato, visibile in una tab. Spento per default. */
function AgentBrowserSection() {
  const [prefs, update] = usePrefs()
  const descriptionId = 'agent-browser-description'
  return (
    <section className="mt-10 flex flex-col gap-2">
      <h3 className="text-lg font-semibold">{t('Browser for the agent')}</h3>
      <div className="mt-2 flex flex-col rounded-lg border border-border">
        <label className="flex items-center justify-between gap-6 px-4 py-3.5">
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-medium">{t('Let the agent use a browser')}</span>
            <span id={descriptionId} className="flex max-w-[62ch] flex-col gap-1 text-sm text-muted-foreground">
              <span>{t('The agent can open local pages, read them and, with your approval according to the session’s permission level, click and type.')}</span>
              <span>{t('It uses a separate browser, without your cookies or logins. It only reaches localhost unless you allow another site, and you can stop it at any time from its tab or with Stop in the chat.')}</span>
              <span>{t('Turning it off applies right away. Turning it on applies the next time a session’s agent restarts. A single project can override this, in New sessions.')}</span>
            </span>
            <AgentBrowserRestartNote projectId={null} />
          </span>
          <input
            type="checkbox"
            aria-describedby={descriptionId}
            checked={prefs?.agentBrowser ?? false}
            disabled={!prefs}
            onChange={(e) => update({ agentBrowser: e.target.checked })}
            className="size-4 shrink-0 accent-primary [color-scheme:light] dark:[color-scheme:dark]"
          />
        </label>
      </div>
    </section>
  )
}
