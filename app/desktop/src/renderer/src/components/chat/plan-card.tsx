// Executable plan card, placed in the coordinator chat where the agent called propose_plan.
// The content comes from the store (`plans`), not from the chat item. One shape per state:
//   review: editable, with "Approve and run"; running and paused: live overview with the tasks and the choices;
//   completed: summary and "Save as template"; stopped and superseded: a muted, expandable row.
import { Check, ChevronRight, CircleX, ListChecks, OctagonMinus } from 'lucide-react'
import { memo, useState, type ReactNode } from 'react'
import type { PlanState, PlanStatus } from '@shared/plan'
import { t } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { cn } from '@/lib/utils'
import { usePlan } from '@/lib/plans'
import { useNow, useToggle } from './chat-context'
import { RunningRing } from '@/components/status'
import { formatSince } from './format'
import { planButton, useExecutorParts } from './plan-bits'
import { PlanReview } from './plan-review'
import { CompletedSummary, PauseBanner, RunTasks, SaveTemplateDialog, StopPlanConfirm } from './plan-run'
import type { PlanItem } from './turns'

/** Title and state mark: shape and label, color only accompanies them. */
function statusHead(status: PlanStatus): { label: string; icon: ReactNode; tone: 'attention' | 'success' | 'muted' | 'plain' } {
  switch (status) {
    case 'review':
      return { label: t('Plan to review'), icon: <ListChecks aria-hidden className="size-4" strokeWidth={1.9} />, tone: 'attention' }
    case 'running':
      return { label: t('Plan running'), icon: <RunningRing />, tone: 'plain' }
    case 'paused':
      return { label: t('Plan paused'), icon: <ListChecks aria-hidden className="size-4" strokeWidth={1.9} />, tone: 'attention' }
    case 'completed':
      return { label: t('Plan completed'), icon: <Check aria-hidden className="size-4" strokeWidth={2.4} />, tone: 'success' }
    case 'stopped':
      return { label: t('Plan stopped'), icon: <OctagonMinus aria-hidden className="size-4" strokeWidth={1.9} />, tone: 'muted' }
    case 'superseded':
      return { label: t('Plan replaced by a newer one'), icon: <CircleX aria-hidden className="size-4" strokeWidth={1.9} />, tone: 'muted' }
  }
}

function Author({ state }: { state: PlanState }) {
  const parts = useExecutorParts(state.author, null, null)
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
      <AgentMark agent={state.author} size={12} className="shrink-0" />
      <span className="truncate">{t('Proposed by {agent}', { agent: parts.name })}</span>
    </span>
  )
}

function progressText(state: PlanState): string {
  const done = state.runs.filter((r) => r.status === 'completed' || r.status === 'skipped').length
  const running = state.runs.filter((r) => r.status === 'running').length
  const base = t('{done} of {total} done', { done, total: state.plan.tasks.length })
  return running > 0 ? `${base} · ${t('{n} running', { n: running })}` : base
}

/** Body of the approved plan: pause, tasks, and the summary for a completed plan. */
function RunBody({ state }: { state: PlanState }) {
  return (
    <div className="grid min-w-0 gap-3">
      {state.status === 'paused' && <PauseBanner state={state} />}
      <RunTasks state={state} />
    </div>
  )
}

export const PlanCard = memo(function PlanCard({ item }: { item: PlanItem }) {
  const state = usePlan(item.planId)
  const closed = state?.status === 'stopped' || state?.status === 'superseded'
  const [open, toggleOpen] = useToggle(`plan-open:${item.planId}`)
  const [tasksOpen, toggleTasks] = useToggle(`plan-tasks:${item.planId}`)
  const [stopping, setStopping] = useState(false)
  const [saving, setSaving] = useState(false)
  const now = useNow(30_000, Boolean(state))

  if (!state) {
    return (
      <div data-item-id={item.id} className="flex min-w-0 items-center gap-2 text-sm leading-[1.5] text-muted-foreground">
        <ListChecks aria-hidden className="size-3.5 shrink-0" strokeWidth={1.9} />
        {t('This plan is no longer available.')}
      </div>
    )
  }

  const head = statusHead(state.status)
  const needsYou = state.status === 'review' || state.status === 'paused'
  const live = state.status === 'running' || state.status === 'paused'
  const bodyId = `plan-body-${item.planId}`

  // Stopped or superseded: a muted row. It opens to reread the tasks and the results.
  if (closed) {
    return (
      <div data-item-id={item.id} className="chat-wide grid min-w-0 gap-2">
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex h-[22px] min-w-0 items-center gap-[7px] rounded-[5px] text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight aria-hidden className={cn('size-3 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')} strokeWidth={2.2} />
          <span className="shrink-0 font-medium">{head.label}</span>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">{state.plan.goal}</span>
        </button>
        {open && (
          <div id={bodyId} className="grid min-w-0 gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
            <p className="text-sm leading-[1.5]">{state.plan.goal}</p>
            <RunBody state={state} />
          </div>
        )}
      </div>
    )
  }

  return (
    <section
      data-item-id={item.id}
      aria-label={t('Plan: {goal}', { goal: state.plan.goal })}
      className={cn(
        'chat-wide grid min-w-0 gap-3 rounded-xl border px-4 py-3.5',
        needsYou ? 'border-attention/45 bg-[color-mix(in_oklab,var(--card),var(--attention)_4%)]' : 'border-border bg-card'
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className={cn('flex min-w-0 items-center gap-2 text-sm font-semibold', head.tone === 'attention' && 'text-attention', head.tone === 'success' && 'text-success', head.tone === 'muted' && 'text-muted-foreground')}>
          <span className="grid size-4 shrink-0 place-items-center">{head.icon}</span>
          <span className="truncate">{head.label}</span>
        </span>
        {live && <span className="text-xs text-muted-foreground tabular-nums">{progressText(state)}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {live && !(state.status === 'paused' && state.pause?.choices.includes('stop')) && (
            <button type="button" onClick={() => setStopping((v) => !v)} aria-expanded={stopping} className={cn(planButton.secondary, 'h-7')}>
              {t('Stop plan')}
            </button>
          )}
          {state.status === 'completed' && (
            <button type="button" onClick={() => setSaving(true)} aria-haspopup="dialog" className={planButton.secondary}>
              {t('Save as template')}
            </button>
          )}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">{formatSince(state.status === 'review' ? state.updatedAt : (state.approvedAt ?? state.createdAt), now)}</span>
        </span>
      </div>

      {state.status !== 'review' && (
        <div className="grid min-w-0 gap-1">
          <p className="text-sm leading-[1.5] break-words">{state.plan.goal}</p>
          <Author state={state} />
        </div>
      )}
      {state.status === 'review' && <Author state={state} />}

      {stopping && live && <StopPlanConfirm state={state} onClose={() => setStopping(false)} />}

      {state.status === 'review' ? (
        <PlanReview state={state} />
      ) : state.status === 'completed' ? (
        <>
          <CompletedSummary state={state} />
          <button
            type="button"
            onClick={toggleTasks}
            aria-expanded={tasksOpen}
            aria-controls={bodyId}
            className="flex h-6 w-fit items-center gap-[7px] rounded-[5px] text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronRight aria-hidden className={cn('size-3 shrink-0 transition-transform motion-reduce:transition-none', tasksOpen && 'rotate-90')} strokeWidth={2.2} />
            {tasksOpen ? t('Hide tasks') : t('Show tasks')}
          </button>
          {tasksOpen && (
            <div id={bodyId}>
              <RunBody state={state} />
            </div>
          )}
        </>
      ) : (
        <RunBody state={state} />
      )}
      {saving && <SaveTemplateDialog state={state} onClose={() => setSaving(false)} />}
    </section>
  )
})
