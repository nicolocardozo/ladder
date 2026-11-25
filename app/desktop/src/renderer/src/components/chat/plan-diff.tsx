// Differences between two plans: the change the agent asks for on an already approved plan, or the one made while you were reviewing it.
import { Minus, Pencil, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Plan, PlanTask } from '@shared/plan'
import { t } from '@shared/i18n'
import { levelLabel } from '@/lib/agents'
import { diffPlans, taskKindLabel, type PlanChange, type TaskField } from '@/lib/plans'
import { cn } from '@/lib/utils'
import { ExecutorText } from './plan-bits'

/** Every row carries a word (Added, Removed, Changed) and an icon: the direction does not depend on color. */
function Row({ tone, children }: { tone: 'added' | 'removed' | 'changed'; children: ReactNode }) {
  const Icon = tone === 'added' ? Plus : tone === 'removed' ? Minus : Pencil
  const label = tone === 'added' ? t('Added') : tone === 'removed' ? t('Removed') : t('Changed')
  return (
    <li className="flex min-w-0 items-baseline gap-2 text-sm leading-[1.5]">
      <span className={cn('inline-flex w-[72px] shrink-0 items-center gap-1 text-xs font-semibold', 'text-foreground')}>
        <Icon aria-hidden className="size-3" strokeWidth={2.4} />
        {label}
      </span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </li>
  )
}

const Arrow = () => <span aria-hidden className="mx-1 text-muted-foreground">→</span>

function afterText(plan: Plan, task: PlanTask): string {
  const titles = task.after.map((id) => plan.tasks.find((x) => x.id === id)?.title ?? id)
  return titles.length ? titles.join(', ') : t('starts first')
}

function loopText(plan: Plan, task: PlanTask): string {
  if (!task.onBlocking) return t('no loop back')
  const back = plan.tasks.find((x) => x.id === task.onBlocking!.backTo)?.title ?? task.onBlocking.backTo
  return t('back to {task}, up to {n}', { task: back, n: task.onBlocking.max })
}

function fieldChange(field: TaskField, before: PlanTask, after: PlanTask, from: Plan, to: Plan): ReactNode {
  switch (field) {
    case 'executor':
      return (
        <span className="inline-flex min-w-0 max-w-full flex-wrap items-center">
          <span className="text-muted-foreground">{t('Executor')}: </span>
          <ExecutorText agent={before.agent} model={before.model} effort={before.effort} className="mx-1 max-w-[16rem]" />
          <Arrow />
          <ExecutorText agent={after.agent} model={after.model} effort={after.effort} className="max-w-[16rem] font-medium" />
        </span>
      )
    case 'permission':
      return (
        <span>
          <span className="text-muted-foreground">{t('Permissions')}: </span>
          {levelLabel(before.permission)}
          <Arrow />
          <span className="font-medium">{levelLabel(after.permission)}</span>
        </span>
      )
    case 'after':
      return (
        <span>
          <span className="text-muted-foreground">{t('Runs after')}: </span>
          {afterText(from, before)}
          <Arrow />
          <span className="font-medium">{afterText(to, after)}</span>
        </span>
      )
    case 'loop':
      return (
        <span>
          <span className="text-muted-foreground">{t('On blocking issues')}: </span>
          {loopText(from, before)}
          <Arrow />
          <span className="font-medium">{loopText(to, after)}</span>
        </span>
      )
    case 'title':
      return (
        <span>
          <span className="text-muted-foreground">{t('Title')}: </span>
          {before.title}
          <Arrow />
          <span className="font-medium">{after.title}</span>
        </span>
      )
    case 'doneWhen':
      return (
        <span>
          <span className="text-muted-foreground">{t('Done when')}: </span>
          {before.doneWhen ?? t('not set')}
          <Arrow />
          <span className="font-medium">{after.doneWhen ?? t('not set')}</span>
        </span>
      )
    case 'kind':
      return (
        <span>
          <span className="text-muted-foreground">{t('Type')}: </span>
          {taskKindLabel(before.kind)}
          <Arrow />
          <span className="font-medium">{taskKindLabel(after.kind)}</span>
        </span>
      )
    default:
      return <span className="text-muted-foreground">{t('The instruction was rewritten')}</span>
  }
}

function ChangeRow({ change, from, to }: { change: PlanChange; from: Plan; to: Plan }) {
  switch (change.kind) {
    case 'goal':
      return (
        <Row tone="changed">
          <span className="text-muted-foreground">{t('Goal')}: </span>
          {change.from}
          <Arrow />
          <span className="font-medium">{change.to}</span>
        </Row>
      )
    case 'constraint-added':
      return (
        <Row tone="added">
          <span className="text-muted-foreground">{t('Constraint')}: </span>
          {change.text}
        </Row>
      )
    case 'constraint-removed':
      return (
        <Row tone="removed">
          <span className="text-muted-foreground">{t('Constraint')}: </span>
          {change.text}
        </Row>
      )
    case 'task-added':
      return (
        <Row tone="added">
          <span className="font-medium">{change.task.title}</span> <span className="text-muted-foreground">· {taskKindLabel(change.task.kind)} · </span>
          <ExecutorText agent={change.task.agent} model={change.task.model} effort={change.task.effort} className="inline-block max-w-[16rem] align-bottom" />
        </Row>
      )
    case 'task-removed':
      return (
        <Row tone="removed">
          <span className="font-medium">{change.task.title}</span> <span className="text-muted-foreground">· {taskKindLabel(change.task.kind)}</span>
        </Row>
      )
    case 'task-changed':
      return (
        <li className="grid min-w-0 gap-1">
          <p className="pl-[80px] text-sm font-medium">{change.after.title}</p>
          <ul className="grid min-w-0 gap-1">
            {change.fields.map((field) => (
              <Row key={field} tone="changed">
                {fieldChange(field, change.before, change.after, from, to)}
              </Row>
            ))}
          </ul>
        </li>
      )
    case 'stop-added':
      return (
        <Row tone="added">
          {t('Pause for your review after “{task}”', { task: change.task.title })}
        </Row>
      )
    case 'stop-removed':
      return (
        <Row tone="removed">
          {t('Pause for your review after “{task}”', { task: change.task.title })}
        </Row>
      )
  }
}

/** List of differences between `from` (as it was) and `to` (as it is or would become). */
export function PlanDiff({ from, to, className }: { from: Plan; to: Plan; className?: string }) {
  const changes = diffPlans(from, to)
  if (changes.length === 0) return <p className={cn('text-sm text-muted-foreground', className)}>{t('No visible differences.')}</p>
  return (
    <ul className={cn('grid min-w-0 gap-1.5', className)}>
      {changes.map((change, i) => (
        <ChangeRow key={i} change={change} from={from} to={to} />
      ))}
    </ul>
  )
}
