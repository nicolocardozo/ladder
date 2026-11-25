// Settings → New sessions, with a project selected: the two personal [agents] switches, written to .ladder/settings.local.toml.
import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import type { AgentId, AgentStatus, Project, ProjectSettings } from '@shared/protocol'
import { AgentMark } from '@/components/agent-mark'
import { SettingRow } from '@/components/settings-parts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'

const OFF = '__off'

type Key = 'autoSwitch' | 'crossReview'

function AgentSwitchRow({ label, hint, value, options, error, onChange }: { label: string; hint: string; value: AgentId | null; options: AgentStatus[]; error: string | null; onChange: (next: AgentId | null) => void }) {
  const names = useApp((s) => s.agents)
  const nameOf = (id: string) => names.find((a) => a.agent === id)?.name ?? id.replace(/^acp:/, '')
  return (
    <SettingRow label={label} hint={hint} warning={error}>
      <Select value={value ?? OFF} onValueChange={(next) => onChange(next === OFF ? null : (String(next) as AgentId))}>
        <SelectTrigger aria-label={label} className="w-[200px]">
          {value && <AgentMark agent={value} size={14} />}
          <SelectValue>{(next: string) => (next === OFF ? t('Off') : nameOf(next))}</SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={OFF}>{t('Off')}</SelectItem>
          {options.map((a) => (
            <SelectItem key={a.agent} value={a.agent}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  )
}

export function ProjectAgentSwitches({ project, settings }: { project: Project; settings: ProjectSettings }) {
  const agents = useApp((s) => s.agents)
  // Last host response to a save: valid until the project is read again.
  const [saved, setSaved] = useState<ProjectSettings | null>(null)
  useEffect(() => setSaved(null), [settings])
  const current = (saved ?? settings).agents
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({})

  const allowed = current.allowed ?? []
  // Selectable agents: available and allowed by the project; the one already chosen stays in the list even if it no longer qualifies.
  const optionsFor = (key: Key) => agents.filter((a) => (a.available && (allowed.length === 0 || allowed.includes(a.agent))) || a.agent === current[key])

  const choose = (key: Key, next: AgentId | null) => {
    setErrors((e) => ({ ...e, [key]: undefined }))
    request<ProjectSettings>({ type: 'project.agents.set', projectId: project.id, patch: { [key]: next } })
      .then(setSaved)
      .catch((e: Error) => setErrors((all) => ({ ...all, [key]: e.message })))
  }

  return (
    <section className="mt-6" aria-labelledby="project-agent-switches-title">
      <h3 id="project-agent-switches-title" className="text-sm font-semibold">
        {t('Agent switching and review in {project}', { project: project.name })}
      </h3>
      <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
        {t('These two are personal: they are saved in {file}, kept out of git, and off by default.', { file: '.ladder/settings.local.toml' })}
      </p>
      <div className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
        <AgentSwitchRow
          label={t('Switch automatically when the plan limit is reached')}
          hint={t('Ladder hands the work to this agent by itself. Off means it only proposes it.')}
          value={current.autoSwitch}
          options={optionsFor('autoSwitch')}
          error={errors.autoSwitch ?? null}
          onChange={(next) => choose('autoSwitch', next)}
        />
        <AgentSwitchRow
          label={t('Cross-review after turns with changes')}
          hint={t('This agent reads the diff, read-only, and its verdict shows in the chat. A serious one goes back to the agent on its own.')}
          value={current.crossReview}
          options={optionsFor('crossReview')}
          error={errors.crossReview ?? null}
          onChange={(next) => choose('crossReview', next)}
        />
      </div>
    </section>
  )
}
