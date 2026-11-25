// Approved plan: tasks with state, results, pause with the choices, final summary and saving as a template.
import { ArrowUpRight, Check, ChevronRight, CirclePause } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { PlanChoice, PlanState, PlanTask } from '@shared/plan'
import { t, plural } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { defaultTemplateName, runDuration, runOf, summarizePlan, taskStatusLabel, usePlanRules } from '@/lib/plans'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { useNow, useToggle } from './chat-context'
import { formatDuration } from './format'
import { Markdown } from './markdown'
import { ExecutorMenu, ExecutorText, PermissionText, PhaseList, planButton, StatusMark, StatusText, TaskResultView, type Executor } from './plan-bits'
import { PlanDiff } from './plan-diff'

const sectionTitle = 'text-xs font-semibold text-muted-foreground'

// ── Tasks ─────────────────────────────────────────────────────────────────

function RunTaskRow({ state, task, number, now }: { state: PlanState; task: PlanTask; number: number; now: number }) {
  const run = runOf(state, task.id)
  const [open, toggle] = useToggle(`plan:${state.id}:${task.id}`)
  const bodyId = useId()
  const status = run?.status ?? 'pending'
  const waiting = Boolean(run?.waiting)
  const duration = run ? runDuration(run, now) : null
  const executor = run ?? task
  const afterTitles = task.after.map((id) => state.plan.tasks.find((x) => x.id === id)?.title ?? id)
  const sessionId = run?.sessionId ?? null
  const files = run?.files
  return (
    <div data-task-id={task.id} className={cn('grid min-w-0 gap-1 rounded-lg px-2.5 py-2', open && 'bg-foreground/5')}>
      <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-[1_1_11rem] items-start gap-2">
        <span className="mt-[3px]">
          <StatusMark status={status} waiting={waiting} />
        </span>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={t('{n}. {title}: {status}', { n: number, title: task.title, status: taskStatusLabel(status, waiting) })}
          className="flex min-w-0 flex-1 items-start gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight aria-hidden className={cn('mt-[3px] size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')} strokeWidth={2.2} />
          <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium break-words text-foreground">{task.title}</span>
        </button>
        </div>
        {/* The title takes precedence: the data on the right wraps below it when space runs out. */}
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 pl-6 text-xs text-muted-foreground">
          {files && files.count > 0 && (
            <span className="font-mono tabular-nums" title={plural(files.count, '{n} file changed', '{n} files changed')}>
              <span className="text-diff-added">+{files.added}</span> <span className="text-diff-removed">−{files.removed}</span>
            </span>
          )}
          {duration !== null && status !== 'pending' && status !== 'queued' && <span className="font-mono tabular-nums">{formatDuration(duration)}</span>}
          {sessionId && (
            <button
              type="button"
              onClick={() => useApp.getState().openSessionAt(sessionId, null)}
              aria-label={t('Open the session of “{title}”', { title: task.title })}
              className={cn(waiting ? planButton.secondary : planButton.ghost, 'h-6 px-2 text-xs')}
            >
              {t('Open session')}
              <ArrowUpRight aria-hidden className="size-3" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-6 text-xs text-muted-foreground">
        <StatusText run={run ?? { status: 'pending', waiting: false, queuedBehind: null }} />
        <span aria-hidden>·</span>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <AgentMark agent={executor.agent} size={12} className="shrink-0" />
          <ExecutorText agent={executor.agent} model={executor.model} effort={executor.effort} className="max-w-[18rem]" />
        </span>
        {run && run.iteration > 1 && <span>· {t('Round {n}', { n: run.iteration })}</span>}
        {run && run.attempt > 1 && <span>· {t('Attempt {n}', { n: run.attempt })}</span>}
        <span aria-hidden>·</span>
        <PermissionText level={task.permission} />
        {afterTitles.length > 0 && <span className="min-w-0 truncate">· {t('After {tasks}', { tasks: afterTitles.join(', ') })}</span>}
        {state.plan.stopAfter.includes(task.id) && (
          <span className="inline-flex items-center gap-1" title={t('Ladder pauses here until you press Continue')}>
            · <CirclePause aria-hidden className="size-3" strokeWidth={1.9} />
            {t('Pauses after')}
          </span>
        )}
      </div>
      {run?.error && status !== 'completed' && <p className={cn('pl-6 text-sm leading-[1.5] break-words', status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{run.error}</p>}
      {open && (
        <div id={bodyId} className="grid min-w-0 gap-3 pt-1 pl-6">
          {task.doneWhen && (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{t('Done when')}</span> · {task.doneWhen}
            </p>
          )}
          {run?.result ? <TaskResultView result={run.result} /> : <p className="text-sm text-muted-foreground">{status === 'running' ? t('No result yet: the task is still running.') : t('No result reported.')}</p>}
          <div className="grid min-w-0 gap-1">
            <h4 className={sectionTitle}>{t('Instruction')}</h4>
            <div className="max-h-56 overflow-auto">
              <Markdown text={task.instruction} compact />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Tasks in stages: parallel ones sit together in the same group. */
export function RunTasks({ state }: { state: PlanState }) {
  const live = state.runs.some((run) => run.status === 'running')
  const now = useNow(1000, live)
  return <PhaseList tasks={state.plan.tasks} render={(task, number) => <RunTaskRow key={task.id} state={state} task={task} number={number} now={now} />} />
}

// ── Pause ───────────────────────────────────────────────────────────────────

function pauseTitle(reason: NonNullable<PlanState['pause']>['reason']): string {
  switch (reason) {
    case 'stop-point':
      return t('Paused for your review')
    case 'failed':
      return t('A task failed')
    case 'blocked':
      return t('A task needs a decision')
    case 'interrupted':
      return t('A task was interrupted')
    case 'loops-exhausted':
      return t('The review still finds blocking issues')
    case 'restart':
      return t('Ladder was closed in the middle of the plan')
    case 'confirm-update':
      return t('The agent asks to change the plan')
  }
}

function choiceLabel(choice: PlanChoice): string {
  switch (choice) {
    case 'continue':
      return t('Continue')
    case 'retry':
      return t('Retry')
    case 'reassign':
      return t('Reassign…')
    case 'skip':
      return t('Skip task')
    case 'stop':
      return t('Stop plan')
  }
}

export function PauseBanner({ state }: { state: PlanState }) {
  const pause = state.pause
  const planChoose = useApp((s) => s.planChoose)
  const planConfirmUpdate = useApp((s) => s.planConfirmUpdate)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reassigning, setReassigning] = useState(false)
  const [stopping, setStopping] = useState(false)
  if (!pause) return null
  const task = state.plan.tasks.find((x) => x.id === pause.taskId)
  const confirming = pause.reason === 'confirm-update' && state.pendingUpdate

  const choose = async (choice: PlanChoice) => {
    if (choice === 'reassign') return setReassigning(true)
    // Stopping the plan asks for confirmation, like the button in the card header.
    if (choice === 'stop') return setStopping((v) => !v)
    setBusy(choice)
    setError(null)
    const result = await planChoose(state.id, choice, pause.taskId ?? undefined)
    if (!result.ok) setError(result.error)
    setBusy(null)
  }
  const confirm = async (accept: boolean) => {
    setBusy(accept ? 'accept' : 'reject')
    setError(null)
    const result = await planConfirmUpdate(state.id, accept)
    if (!result.ok) setError(result.error)
    setBusy(null)
  }

  return (
    <div role="group" aria-label={t('Plan paused')} className="grid min-w-0 gap-3 rounded-lg bg-attention/10 px-3 py-3 ring-1 ring-attention/45 ring-inset">
      <div className="flex min-w-0 items-start gap-2.5">
        <CirclePause aria-hidden className="mt-[2px] size-4 shrink-0 text-attention" strokeWidth={2} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="text-sm font-semibold text-attention">{pauseTitle(pause.reason)}</p>
          <p role="status" className="text-sm leading-[1.5] break-words text-foreground">
            {pause.message}
          </p>
          {task && (
            <p className="text-xs text-muted-foreground">
              {t('Task')}: <span className="font-medium text-foreground">{task.title}</span>
            </p>
          )}
        </div>
      </div>
      {confirming ? (
        <>
          {state.updateReason && (
            <p className="text-sm leading-[1.5]">
              <span className="font-medium">{t('Reason given by the agent')}</span> · {state.updateReason}
            </p>
          )}
          <div className="grid min-w-0 gap-1.5">
            <h4 className={sectionTitle}>{t('What would change')}</h4>
            <PlanDiff from={state.plan} to={state.pendingUpdate!} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void confirm(true)} disabled={busy !== null} className={planButton.primary}>
              {t('Accept changes')}
            </button>
            <button type="button" onClick={() => void confirm(false)} disabled={busy !== null} className={planButton.secondary}>
              {t('Reject changes')}
            </button>
            <button type="button" onClick={() => void choose('stop')} disabled={busy !== null} className={planButton.destructive}>
              {t('Stop plan')}
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {pause.choices.map((choice, i) => (
            <button
              key={choice}
              type="button"
              onClick={() => void choose(choice)}
              disabled={busy !== null}
              aria-haspopup={choice === 'reassign' ? 'dialog' : undefined}
              className={choice === 'stop' ? planButton.destructive : i === 0 ? planButton.primary : planButton.secondary}
            >
              {choiceLabel(choice)}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm break-words text-destructive">
          {error}
        </p>
      )}
      {stopping && <StopPlanConfirm state={state} onClose={() => setStopping(false)} />}
      {reassigning && <ReassignDialog state={state} taskId={pause.taskId} onClose={() => setReassigning(false)} />}
    </div>
  )
}

/** Reassign: new agent, model and effort, and whether to start from the partial work or from the task's starting point. */
function ReassignDialog({ state, taskId, onClose }: { state: PlanState; taskId: string | null; onClose: () => void }) {
  const planChoose = useApp((s) => s.planChoose)
  const rules = usePlanRules(state.projectId)
  const task = state.plan.tasks.find((x) => x.id === taskId)
  const run = taskId ? runOf(state, taskId) : null
  const current: Executor = { agent: run?.agent ?? task?.agent ?? 'claude-code', model: run?.model ?? task?.model ?? null, effort: run?.effort ?? task?.effort ?? null }
  const agents = useApp((s) => s.agents)
  // Starts from another available and allowed agent (the one that just failed on a usage limit would fail again); if there is none, from the current one.
  const alternative = agents.find((a) => a.agent !== current.agent && a.available && (!rules?.allowed.length || rules.allowed.includes(a.agent)))
  const [chosen, setChosen] = useState<Executor | null>(null)
  const value: Executor = chosen ?? (alternative ? { agent: alternative.agent, model: null, effort: null } : current)
  const setValue = (next: Executor) => setChosen(next)
  const unchanged = value.agent === current.agent && value.model === current.model && value.effort === current.effort
  const [keepWork, setKeepWork] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const options = [
    { keep: true, label: t('Continue from the partial work'), hint: t('The new agent starts from the files as they are now.') },
    { keep: false, label: t('Restart from the start of the task'), hint: t('The partial work is saved as a patch, not lost.') }
  ]
  const submit = async () => {
    setBusy(true)
    setError(null)
    const result = await planChoose(state.id, 'reassign', taskId ?? undefined, { ...value, keepWork })
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.error)
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-3 sm:max-w-[460px]">
        <DialogTitle className="text-base">{task ? t('Reassign “{title}”', { title: task.title }) : t('Reassign the task')}</DialogTitle>
        <DialogDescription className="text-sm">{t('Choose who takes over. Nothing is deleted: Ladder saves the current state first.')}</DialogDescription>
        <div className="grid gap-1">
          <span className={sectionTitle}>{t('New executor')}</span>
          <div>
            <ExecutorMenu label={t('New executor')} value={value} allowed={rules?.allowed ?? []} onChange={setValue} />
          </div>
        </div>
        <div role="radiogroup" aria-label={t('Where to restart from')} className="grid gap-1.5">
          {options.map((option, i) => {
            const checked = option.keep === keepWork
            return (
              <button
                key={String(option.keep)}
                ref={(el) => {
                  refs.current[i] = el
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                onClick={() => setKeepWork(option.keep)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                  e.preventDefault()
                  setKeepWork(!option.keep)
                  refs.current[1 - i]?.focus()
                }}
                className={cn('flex min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50', checked ? 'border-ring bg-accent' : 'border-input hover:bg-accent/50')}
              >
                <span aria-hidden className={cn('mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-full border', checked ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground')}>
                  {checked && <Check className="size-2.5" strokeWidth={3.5} />}
                </span>
                <span className="grid min-w-0">
                  <span className="text-sm font-medium">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </button>
            )
          })}
        </div>
        {error && (
          <p role="alert" className="text-sm break-words text-destructive">
            {error}
          </p>
        )}
        {unchanged && <p className="text-xs text-muted-foreground">{t('Change the agent, model or effort to reassign.')}</p>}
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={planButton.ghost}>
            {t('Cancel')}
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy || unchanged} className={planButton.primary}>
            {busy ? t('Reassigning…') : t('Reassign')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Stopping the plan ────────────────────────────────────────────────────────

/** "Stop plan" with confirmation in the card: focus goes to "Keep running", Esc closes it. */
export function StopPlanConfirm({ state, onClose }: { state: PlanState; onClose: () => void }) {
  const planStop = useApp((s) => s.planStop)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => keep.current?.focus(), [])
  return (
    <div className="grid min-w-0 gap-2 rounded-lg bg-muted/60 p-2.5" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
      <p className="text-sm leading-[1.5]">{t('Stop the plan? Running tasks are interrupted and nothing else starts. Their sessions stay open.')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const result = await planStop(state.id)
            setBusy(false)
            if (result.ok) onClose()
            else setError(result.error)
          }}
          className={planButton.destructive}
        >
          {t('Stop plan')}
        </button>
        <button ref={keep} type="button" onClick={onClose} className={planButton.secondary}>
          {t('Keep running')}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm break-words text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

// ── Completed plan ──────────────────────────────────────────────────────────

/** One row: tasks, agents, models, files and checks. */
export function CompletedSummary({ state }: { state: PlanState }) {
  const summary = summarizePlan(state, state.endedAt ?? state.updatedAt)
  const parts: ReactNode[] = [
    plural(summary.tasks, '{n} task', '{n} tasks'),
    plural(summary.agents.length, '{n} agent', '{n} agents'),
    plural(summary.models, '{n} model', '{n} models')
  ]
  if (summary.files.count > 0)
    parts.push(
      <span key="files">
        {plural(summary.files.count, '{n} file', '{n} files')}{' '}
        <span className="font-mono text-xs tabular-nums">
          <span className="text-diff-added">+{summary.files.added}</span> <span className="text-diff-removed">−{summary.files.removed}</span>
        </span>
      </span>
    )
  if (summary.checks.total > 0)
    parts.push(
      summary.checks.failed > 0
        ? t('{passed} checks passed, {failed} failed', { passed: summary.checks.passed, failed: summary.checks.failed })
        : plural(summary.checks.passed, '{n} check passed', '{n} checks passed')
    )
  if (summary.durationMs !== null) parts.push(formatDuration(summary.durationMs))
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm leading-[1.5] text-muted-foreground">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>·</span>}
          {part}
        </span>
      ))}
    </p>
  )
}

/** Saves the plan as a template: just a name. */
export function SaveTemplateDialog({ state, onClose }: { state: PlanState; onClose: () => void }) {
  const save = useApp((s) => s.savePlanTemplate)
  const [name, setName] = useState(() => defaultTemplateName(state.plan.goal))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    const result = await save(state.id, name.trim())
    setBusy(false)
    if (result.ok) {
      onClose()
      useApp.getState().notifyInfo(t('Template “{name}” saved. Use it from ⌘K, “Use plan template…”.', { name: result.data.name }))
    } else setError(result.error)
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-3 sm:max-w-[420px]">
        <DialogTitle className="text-base">{t('Save as template')}</DialogTitle>
        <DialogDescription className="text-sm">{t('Keeps the tasks, executors, permissions and stop points. The goal is asked again each time you use it.')}</DialogDescription>
        <label className="grid gap-1">
          <span className={sectionTitle}>{t('Template name')}</span>
          <input
            autoFocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm break-words text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={planButton.ghost}>
            {t('Cancel')}
          </button>
          <button type="button" onClick={() => void submit()} disabled={!name.trim() || busy} className={planButton.primary}>
            {busy ? t('Saving…') : t('Save')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

