// Agent, model and effort choice for forms that hand work to an agent (here "Implement with…"). Same fields as "Hand off to…".
import { useState, type ReactNode, type Ref } from 'react'
import type { AgentId, AgentStatus, Effort } from '@shared/protocol'
import { t } from '@shared/i18n'
import { AgentMark, modelLabel } from '@/components/agent-mark'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EFFORTS, supportsEffort } from '@/lib/agents'
import { agentStatusFor } from '@/lib/profiles'
import { useApp } from '@/store/app-store'

const NONE = '__none'

export function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-xs font-semibold text-muted-foreground">
          {label}
        </label>
      ) : (
        <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      )}
      {children}
    </div>
  )
}

export interface AgentChoice {
  agent: AgentId | null
  model: string | null
  effort: Effort | null
  chooseAgent: (next: AgentId) => void
  chooseModel: (next: string | null) => void
  setEffort: (next: Effort | null) => void
  status: AgentStatus | null
}

/** Choice state: changing agent resets model and effort to the default; changing model keeps the effort only if the model accepts it. */
export function useAgentChoice(targets: AgentStatus[], seed: AgentId | null): AgentChoice {
  const [picked, setPicked] = useState<AgentId | null>(seed)
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<Effort | null>(null)
  // An agent no longer allowed (project settings arrive later) gives way to the first valid one.
  const agent = picked && targets.some((a) => a.agent === picked) ? picked : (targets[0]?.agent ?? null)
  const status = useApp((s) => (agent ? (agentStatusFor(s, agent, null) ?? s.agents.find((a) => a.agent === agent) ?? null) : null))
  return {
    agent,
    model,
    effort,
    status,
    chooseAgent: (next) => {
      if (next === agent) return
      setPicked(next)
      setModel(null)
      setEffort(null)
    },
    chooseModel: (next) => {
      setModel(next)
      const accepted = status?.models.find((m) => m.id === next)?.efforts
      if (effort && accepted && !accepted.includes(effort)) setEffort(null)
    },
    setEffort
  }
}

export function AgentChoiceFields({ choice, targets, agentRef }: { choice: AgentChoice; targets: AgentStatus[]; agentRef?: Ref<HTMLButtonElement> }) {
  const { agent, model, effort, status } = choice
  const names = useApp((s) => s.agents)
  const modelEfforts = status?.models.find((m) => m.id === model)?.efforts
  const effortLevels = EFFORTS.filter((e) => (modelEfforts ? modelEfforts.includes(e.id) : true))
  return (
    <>
      <Field label={t('Agent')}>
        <Select value={agent ?? ''} disabled={targets.length === 0} onValueChange={(value) => choice.chooseAgent(String(value) as AgentId)}>
          <SelectTrigger ref={agentRef} aria-label={t('Agent')} className="w-full">
            {agent && <AgentMark agent={agent} size={14} />}
            <SelectValue>{(value: string) => names.find((a) => a.agent === value)?.name ?? value.replace(/^acp:/, '')}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            {targets.map((a) => (
              <SelectItem key={a.agent} value={a.agent}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t('Model')}>
        <Select value={model ?? NONE} disabled={!status || status.models.length === 0} onValueChange={(value) => choice.chooseModel(value === NONE ? null : String(value))}>
          <SelectTrigger aria-label={t('Model')} className="w-full">
            <SelectValue>{(value: string) => (value === NONE ? t('Default model') : (modelLabel(status, value) ?? value))}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value={NONE}>{t('Default model')}</SelectItem>
            {status?.models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {agent && supportsEffort(agent) && (
        <Field label={t('Effort')}>
          <Select value={effort ?? NONE} onValueChange={(value) => choice.setEffort(value === NONE ? null : (String(value) as Effort))}>
            <SelectTrigger aria-label={t('Effort')} className="w-full">
              <SelectValue>{(value: string) => (value === NONE ? t('Default effort') : t(EFFORTS.find((e) => e.id === value)?.label ?? value))}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value={NONE}>{t('Default effort')}</SelectItem>
              {effortLevels.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {t(e.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
    </>
  )
}
