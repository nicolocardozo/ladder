// Banner at the top of the chat of a session running a plan task: says which task and which plan,
// and leads back to the card in the coordinator chat.
import { ArrowUpLeft, ListChecks } from 'lucide-react'
import type { SessionSummary } from '@shared/protocol'
import { t } from '@shared/i18n'
import { StatusMark, StatusText, planButton } from '@/components/chat/plan-bits'
import { runOf, usePlan } from '@/lib/plans'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

export function PlanTaskBanner({ session, compact }: { session: SessionSummary; compact?: boolean }) {
  const link = session.plan
  const plan = usePlan(link?.planId)
  // The plan card in the coordinator chat, if that chat is already loaded: it is reached by scrolling to it.
  const cardId = useApp((s) => (plan ? (s.items[plan.sessionId]?.find((i) => i.kind === 'plan' && i.planId === plan.id)?.id ?? null) : null))
  if (!link || link.role !== 'task') return null
  const task = plan?.plan.tasks.find((x) => x.id === link.taskId)
  const run = plan && link.taskId ? runOf(plan, link.taskId) : null
  const back = () => {
    if (plan) useApp.getState().openSessionAt(plan.sessionId, cardId)
  }
  return (
    <div className="chat-col chat-gutter pb-1" data-compact={compact ? '' : undefined}>
      <div className="chat-measure chat-bleed">
        <div className="chat-reset">
          <div role="group" aria-label={t('Task of a plan')} className="flex min-h-8 min-w-0 items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground">
            <ListChecks aria-hidden className="size-3.5 shrink-0" strokeWidth={1.9} />
            <span className="min-w-0 flex-1 truncate">
              {task && plan ? (
                <>
                  {t('Task')} <span className="font-medium text-foreground">{task.title}</span> · {t('plan')} <span className="text-foreground/80">{plan.plan.goal}</span>
                </>
              ) : (
                t('This session runs a task of a plan')
              )}
            </span>
            {run && (
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <StatusMark status={run.status} waiting={run.waiting} />
                <StatusText run={run} />
              </span>
            )}
            {plan && (
              <button type="button" onClick={back} className={cn(planButton.ghost, 'h-6 px-2 text-xs')}>
                <ArrowUpLeft aria-hidden className="size-3" strokeWidth={2} />
                {t('Back to the plan')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
