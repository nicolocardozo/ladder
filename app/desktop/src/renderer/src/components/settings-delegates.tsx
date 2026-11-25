// Settings → New sessions, with a project selected: the preferred delegates of [[agents.delegates]], read-only.
import { t } from '@shared/i18n'
import type { AgentDelegate, Project } from '@shared/protocol'
import { AgentMark, modelLabel, useAgentLine } from '@/components/agent-mark'
import { effortLabel } from '@/components/subagent-bits'
import { levelLabel } from '@/lib/agents'
import { useApp } from '@/store/app-store'

const EXAMPLE = `[[agents.delegates]]
name = "reviewer"
agent = "codex"
model = "gpt-6-luna"
effort = "high"
permission = "plan"
note = "Reviews and second opinions"`

function DelegateRow({ delegate }: { delegate: AgentDelegate }) {
  const { name: agentName } = useAgentLine(delegate.agent, null)
  const status = useApp((s) => s.agents.find((a) => a.agent === delegate.agent) ?? null)
  const facts = [modelLabel(status, delegate.model) ?? t('Default model'), effortLabel(delegate.effort), levelLabel(delegate.permission)].filter(Boolean).join(' · ')
  return (
    <li className="flex min-w-0 flex-col gap-0.5 px-4 py-2.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <span className="font-medium">{delegate.name}</span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <AgentMark agent={delegate.agent} size={13} />
          {agentName}
        </span>
        <span className="text-xs text-muted-foreground">{facts}</span>
      </span>
      {delegate.note ? <span className="text-xs break-words text-muted-foreground">{delegate.note}</span> : null}
    </li>
  )
}

export function ProjectDelegates({ project, delegates }: { project: Project; delegates: AgentDelegate[] }) {
  return (
    <section className="mt-6" aria-labelledby="project-delegates-title">
      <h3 id="project-delegates-title" className="text-sm font-semibold">
        {t('Preferred delegates of {project}', { project: project.name })}
      </h3>
      <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
        {t('Agents the coordinator can hand a task to. The agent decides when and to whom; Ladder only lists them. They are read from the project’s files, so edit the file to change them.')}
      </p>
      {delegates.length > 0 ? (
        <ul className="mt-3 flex list-none flex-col divide-y divide-border rounded-lg border border-border p-0" aria-label={t('Preferred delegates')}>
          {delegates.map((d) => (
            <DelegateRow key={d.name} delegate={d} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">{t('No delegates set for this project.')}</p>
      )}
      <p className="mt-3 max-w-[62ch] text-xs text-muted-foreground">
        {t('Edit {shared} (shared with the team) or {personal} (personal, kept out of git) in the project folder, and add one block per delegate:', {
          shared: '.ladder/settings.toml',
          personal: '.ladder/settings.local.toml'
        })}
      </p>
      <p className="mt-1 font-mono text-xs break-all text-muted-foreground" title={project.path}>
        {project.path}/.ladder/settings.toml
      </p>
      <pre className="mt-2 overflow-x-auto rounded-lg border border-border bg-[var(--chat-code-bg)] px-3 py-2 font-mono text-xs leading-[1.55] text-foreground/85">{EXAMPLE}</pre>
    </section>
  )
}
