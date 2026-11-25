// Pieces shared by the plan card: state mark, executor, permissions, result of a task.
import { Ban, Check, ChevronDown, CircleAlert, CircleDashed, CircleStop, CircleX, Clock, Hand, Info, ListChecks, ShieldCheck, SkipForward, Split, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import type { PlanTask, PlanTaskRun, PlanTaskStatus, TaskResult } from '@shared/plan'
import type { AgentId, Effort, PermissionLevel } from '@shared/protocol'
import { t } from '@shared/i18n'
import { AgentMark, modelLabel } from '@/components/agent-mark'
import { EffortSlider } from '@/components/composer/effort-slider'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { allowedLevels, EFFORTS, levelHint, levelLabel, permissionLevels, supportsEffort } from '@/lib/agents'
import { phasesOf, taskStatusLabel } from '@/lib/plans'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { RunningRing } from '@/components/status'
import { FileChip } from './bits'
import { Markdown } from './markdown'

/** 28 px chip like the composer ones: no border at rest, 12 px text, 14 px icon. */
export const planChip =
  'no-drag inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md bg-secondary px-2 text-xs whitespace-nowrap text-foreground outline-none ' +
  'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent disabled:pointer-events-none disabled:opacity-60 aria-pressed:bg-accent'

/** 28 px button in the card: primary (iris), secondary (surface with the controls hairline) or ghost. Only one primary per view. */
const planButtonBase =
  'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap outline-none transition-[background-color,opacity] ' +
  'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-card disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50'
export const planButton = {
  primary: `${planButtonBase} border border-primary bg-primary text-primary-foreground hover:opacity-90`,
  secondary: `${planButtonBase} border border-input/70 bg-card text-foreground hover:bg-accent`,
  ghost: `${planButtonBase} px-2 text-muted-foreground hover:bg-accent hover:text-foreground`,
  destructive: `${planButtonBase} border border-destructive/45 bg-card text-destructive hover:bg-destructive/10`
}

// ── Task state ─────────────────────────────────────────────────────

/** State symbol in a 16 px slot. Every state has its own shape; the label is always next to it, so the mark is decorative. */
export function StatusMark({ status, waiting = false }: { status: PlanTaskStatus; waiting?: boolean }) {
  const icon = (() => {
    if (status === 'running') return waiting ? <CircleAlert className="size-3.5 text-attention" strokeWidth={2.2} /> : <RunningRing />
    switch (status) {
      case 'completed':
        return <Check className="size-3.5 text-success" strokeWidth={2.4} />
      case 'failed':
        return <CircleX className="size-3.5 text-destructive" strokeWidth={2.2} />
      case 'blocked':
        return <Hand className="size-3.5 text-attention" strokeWidth={2} />
      case 'interrupted':
        return <CircleStop className="size-3.5 text-muted-foreground" strokeWidth={1.9} />
      case 'skipped':
        return <SkipForward className="size-3.5 text-muted-foreground" strokeWidth={1.9} />
      case 'queued':
        return <Clock className="size-3.5 text-muted-foreground" strokeWidth={1.9} />
      default:
        return <CircleDashed className="size-3.5 text-muted-foreground" strokeWidth={1.9} />
    }
  })()
  return (
    <span aria-hidden className="grid size-4 shrink-0 place-items-center">
      {icon}
    </span>
  )
}

/** State label in the right color: amber for what waits for you, rose for errors, muted for the rest. */
export function StatusText({ run }: { run: Pick<PlanTaskRun, 'status' | 'waiting' | 'queuedBehind'> }) {
  const waiting = run.status === 'running' && run.waiting
  const text = taskStatusLabel(run.status, run.waiting)
  return (
    <span className={cn('font-medium', (waiting || run.status === 'blocked') && 'text-attention', run.status === 'failed' && 'text-destructive', run.status === 'completed' && 'text-success')}>
      {text}
      {run.status === 'queued' && run.queuedBehind ? <span className="font-normal text-muted-foreground"> · {t('behind {task}', { task: run.queuedBehind })}</span> : null}
    </span>
  )
}

// ── Executor ───────────────────────────────────────────────────────────────

/** Effort name in the current language. */
export const effortText = (effort: Effort): string => t(EFFORTS.find((e) => e.id === effort)?.label ?? effort)

/** Agent, model and effort as text: "Claude Code · Opus 5.5 · High". Without a chosen model, the agent's default applies. */
export function useExecutorParts(agent: AgentId, model: string | null, effort: Effort | null): { name: string; model: string | null; effort: string | null } {
  const status = useApp((s) => s.agents.find((a) => a.agent === agent) ?? null)
  const name = status?.name ?? (agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent.replace(/^acp:/, ''))
  const modelId = model ?? status?.models.find((m) => m.isDefault)?.id ?? null
  return { name, model: modelLabel(status, modelId), effort: effort ? effortText(effort) : null }
}

export function ExecutorText({ agent, model, effort, className }: { agent: AgentId; model: string | null; effort: Effort | null; className?: string }) {
  const parts = useExecutorParts(agent, model, effort)
  return <span className={cn('min-w-0 truncate', className)}>{[parts.name, parts.model, parts.effort].filter(Boolean).join(' · ')}</span>
}

export interface Executor {
  agent: AgentId
  model: string | null
  effort: Effort | null
}

/**
 * Agent, model and effort picked in a single menu: same data and same effort slider as the composer.
 * Changing the agent resets model and effort (they no longer apply). `allowed`: agents allowed by the project (empty = all available ones).
 */
export function ExecutorMenu({
  value,
  onChange,
  allowed = [],
  label,
  disabled
}: {
  value: Executor
  onChange: (next: Executor) => void
  allowed?: AgentId[]
  label: string
  disabled?: boolean
}) {
  const agents = useApp((s) => s.agents)
  const status = agents.find((a) => a.agent === value.agent) ?? null
  const parts = useExecutorParts(value.agent, value.model, value.effort)
  const options = agents.filter((a) => a.agent === value.agent || (a.available && (allowed.length === 0 || allowed.includes(a.agent))))
  const models = status?.models ?? []
  const modelInfo = models.find((m) => m.id === (value.model ?? models.find((x) => x.isDefault)?.id))
  const levels = supportsEffort(value.agent) ? (modelInfo?.efforts ?? []) : []
  const summary = [parts.name, parts.model, parts.effort].filter(Boolean).join(' · ')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={planChip} disabled={disabled} aria-label={`${label}: ${summary}`} title={summary}>
        <AgentMark agent={value.agent} size={12} className="shrink-0" />
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('Agent')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value.agent} onValueChange={(next) => onChange({ agent: next as AgentId, model: null, effort: null })}>
            {options.map((a) => (
              <DropdownMenuRadioItem key={a.agent} value={a.agent} disabled={!a.available && a.agent !== value.agent}>
                <AgentMark agent={a.agent} size={14} className="text-muted-foreground" />
                <span className="min-w-0 truncate">{a.name}</span>
                {!a.available && <span className="text-xs text-muted-foreground">{t('Not available')}</span>}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('Model')}</DropdownMenuLabel>
          {models.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('The list appears after {agent} starts for the first time.', { agent: parts.name })}</p>}
          <DropdownMenuRadioGroup value={value.model ?? ''} onValueChange={(next) => onChange({ ...value, model: next || null, effort: next && value.effort && !(models.find((m) => m.id === next)?.efforts ?? []).includes(value.effort) ? null : value.effort })}>
            {models.length > 0 && (
              <DropdownMenuRadioItem value="">
                <span className="min-w-0 truncate">{t('Default model')}</span>
              </DropdownMenuRadioItem>
            )}
            {models.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id}>
                <span className="min-w-0 truncate">{m.label}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {levels.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <EffortSlider levels={levels} value={value.effort ?? modelInfo?.defaultEffort ?? null} chosen={value.effort !== null} defaultLevel={modelInfo?.defaultEffort ?? null} agentName={parts.name} onChange={(effort) => onChange({ ...value, effort })} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Permission level as a chip with a menu. Levels above the project maximum stay visible but disabled. */
export function PermissionMenu({ value, onChange, max, label, disabled }: { value: PermissionLevel; onChange: (next: PermissionLevel) => void; max?: PermissionLevel | null; label: string; disabled?: boolean }) {
  const levels = allowedLevels(max)
  const text = levelLabel(value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={planChip} disabled={disabled} aria-label={t('{label}: {level}', { label, level: text })} title={levelHint(value)}>
        <ShieldCheck aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
        <span className="min-w-0 truncate">{text}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('Permissions')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as PermissionLevel)}>
            {permissionLevels.map((p) => (
              <DropdownMenuRadioItem key={p.id} value={p.id} disabled={!levels.includes(p.id)} className="items-start py-1.5">
                <span className="flex flex-col">
                  <span className="font-medium">{levelLabel(p.id)}</span>
                  <span className="text-xs text-muted-foreground">{levels.includes(p.id) ? levelHint(p.id) : t('Not allowed by .ladder/settings.toml')}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Read-only permission, for the running card. */
export function PermissionText({ level }: { level: PermissionLevel }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1" title={levelHint(level)}>
      <ShieldCheck aria-hidden className="size-3 shrink-0" strokeWidth={1.8} />
      {levelLabel(level)}
    </span>
  )
}

// ── Stages ────────────────────────────────────────────────────────────────────

/**
 * Tasks in execution order: each stage waits for the previous one. A stage with several tasks runs in parallel and sits in a group
 * with a muted background and its own label (shape, not only color, says they run side by side).
 * `render` receives the task and its number (from 1, in the order shown).
 */
export function PhaseList({ tasks, render }: { tasks: PlanTask[]; render: (task: PlanTask, number: number) => ReactNode }) {
  const phases = phasesOf(tasks)
  let number = 0
  return (
    <div className="grid min-w-0 gap-1">
      {phases.map((phase) =>
        phase.length > 1 ? (
          <div key={phase.map((x) => x.id).join('|')} role="group" aria-label={t('{n} tasks in parallel', { n: phase.length })} className="grid min-w-0 gap-0.5 rounded-xl bg-muted/30 p-1">
            <p className="flex items-center gap-1.5 px-2.5 pt-1 text-xs font-semibold text-muted-foreground">
              <Split aria-hidden className="size-3" strokeWidth={2} />
              {t('In parallel')}
            </p>
            {phase.map((task) => render(task, ++number))}
          </div>
        ) : (
          <div key={phase[0].id} className="min-w-0">
            {render(phase[0], ++number)}
          </div>
        )
      )}
    </div>
  )
}

// ── Task result ─────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1">
      <h4 className="text-xs font-semibold text-muted-foreground">{title}</h4>
      {children}
    </div>
  )
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="grid min-w-0 gap-0.5 text-sm leading-[1.5] text-foreground">
      {items.map((item, i) => (
        <li key={i} className="flex min-w-0 gap-2">
          <span aria-hidden className="mt-[0.6em] size-1 shrink-0 rounded-full bg-muted-foreground" />
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
    </ul>
  )
}

/** Result of report_result: markdown summary, then decisions, checks, issues, questions and side effects already produced. */
export function TaskResultView({ result }: { result: TaskResult }) {
  return (
    <div className="grid min-w-0 gap-3">
      {result.verdict && (
        <p className={cn('flex items-center gap-1.5 text-sm font-medium', result.verdict === 'approved' ? 'text-success' : 'text-destructive')}>
          {result.verdict === 'approved' ? <Check aria-hidden className="size-3.5" strokeWidth={2.4} /> : <TriangleAlert aria-hidden className="size-3.5" strokeWidth={2.2} />}
          {result.verdict === 'approved' ? t('Approved') : t('Changes requested')}
        </p>
      )}
      <Markdown text={result.summary} compact />
      {result.decisions.length > 0 && (
        <Section title={t('Decisions')}>
          <Bullets items={result.decisions} />
        </Section>
      )}
      {result.deviations.length > 0 && (
        <Section title={t('Deviations from the plan')}>
          <Bullets items={result.deviations} />
        </Section>
      )}
      {result.checks.length > 0 && (
        <Section title={t('Checks')}>
          <ul className="grid min-w-0 gap-1">
            {result.checks.map((check, i) => (
              <li key={i} className="grid min-w-0 gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  {check.exit === 0 ? <Check role="img" aria-label={t('Passed')} className="size-3.5 shrink-0 text-success" strokeWidth={2.4} /> : check.exit === null ? <Info role="img" aria-label={t('No exit code')} className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.9} /> : <CircleX role="img" aria-label={t('Failed')} className="size-3.5 shrink-0 text-destructive" strokeWidth={2.2} />}
                  <code className="min-w-0 truncate font-mono text-xs text-foreground" title={check.cmd}>
                    {check.cmd}
                  </code>
                  {check.exit !== null && <span className="shrink-0 font-mono text-xs text-muted-foreground">{t('exit {code}', { code: check.exit })}</span>}
                </div>
                {check.summary && <p className="pl-[22px] text-xs text-muted-foreground">{check.summary}</p>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {result.issues.length > 0 && (
        <Section title={t('Issues')}>
          <ul className="grid min-w-0 gap-1.5">
            {result.issues.map((issue, i) => (
              <li key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm leading-[1.5]">
                <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs font-semibold', issue.severity === 'blocking' ? 'text-destructive' : 'text-muted-foreground')}>
                  {issue.severity === 'blocking' ? <Ban aria-hidden className="size-3" strokeWidth={2.2} /> : <Info aria-hidden className="size-3" strokeWidth={2} />}
                  {issue.severity === 'blocking' ? t('Blocking') : t('Minor')}
                </span>
                {issue.file && <FileChip path={issue.file} line={issue.line ?? undefined} />}
                <span className="min-w-0 break-words">{issue.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {result.questions.length > 0 && (
        <Section title={t('Open questions')}>
          <Bullets items={result.questions} />
        </Section>
      )}
      {result.sideEffects.length > 0 && (
        <Section title={t('Already run, not to be repeated')}>
          <ul className="grid min-w-0 gap-0.5">
            {result.sideEffects.map((effect, i) => (
              <li key={i}>
                <code className="font-mono text-xs break-all text-foreground">{effect}</code>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

// ── Task mark in the sidebar and the banner ────────────────────────────

/** Mark of a session running a plan task: icon and label, never color alone. */
export function PlanTaskMark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)} title={t('This session runs a task of a plan')}>
      <ListChecks aria-hidden className="size-3 shrink-0" strokeWidth={1.9} />
      <span>{t('Plan task')}</span>
    </span>
  )
}
