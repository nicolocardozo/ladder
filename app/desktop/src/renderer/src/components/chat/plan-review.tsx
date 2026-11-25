// Plan in review: edited in the card and approved. Changes live in a store draft (the chat is virtualized:
// unmounting the row does not lose them) and are sent to the host only with "Approve and run", with the revision you saw.
import { Check, ChevronDown, ChevronRight, CirclePause, GitFork, Info, ListOrdered, Trash2, User, X } from 'lucide-react'
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { upstreamOf, validatePlan, type Plan, type PlanState, type PlanTask } from '@shared/plan'
import { PLAN_LIMITS } from '@shared/plan'
import { t } from '@shared/i18n'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { checkPlan, patchTask, possibleAfter, removeTask, samePlan, taskKindLabel, toggleAfter, toggleStop, usePlanRules } from '@/lib/plans'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { ExecutorMenu, PermissionMenu, PhaseList, planButton, planChip } from './plan-bits'
import { PlanDiff } from './plan-diff'

const field =
  'w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm leading-[1.5] text-foreground outline-none placeholder:text-faint ' +
  'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive'
const sectionTitle = 'text-xs font-semibold text-muted-foreground'

/** "After" chip: which tasks it depends on. Only those that do not create a cycle. */
function AfterMenu({ plan, task, onChange }: { plan: Plan; task: PlanTask; onChange: (next: Plan) => void }) {
  const options = possibleAfter(plan, task.id)
  const titles = task.after.map((id) => plan.tasks.find((x) => x.id === id)?.title ?? id)
  const text = titles.length ? t('After {tasks}', { tasks: titles.join(', ') }) : t('Starts first')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={planChip} disabled={options.length === 0} aria-label={`${t('Runs after')}: ${titles.length ? titles.join(', ') : t('nothing, it starts first')}`} title={text}>
        <ListOrdered aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
        <span className="min-w-0 truncate">{text}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('Runs after')}</DropdownMenuLabel>
          {options.map((other) => (
            <DropdownMenuCheckboxItem key={other.id} checked={task.after.includes(other.id)} onCheckedChange={() => onChange(toggleAfter(plan, task.id, other.id))} closeOnClick={false}>
              <span className="min-w-0 truncate">{other.title}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A draft task: compact row with its chips, and below it, when open, the instruction and the done criterion. */
function TaskEditor({
  plan,
  task,
  number,
  errors,
  allowed,
  max,
  onChange
}: {
  plan: Plan
  task: PlanTask
  number: number
  errors: string[]
  allowed: Parameters<typeof ExecutorMenu>[0]['allowed']
  max: Parameters<typeof PermissionMenu>[0]['max']
  onChange: (next: Plan) => void
}) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  // Every field with an error points to its error text.
  const errorId = (message: string) => (errors.includes(message) ? `${bodyId}-e${errors.indexOf(message)}` : undefined)
  const titleErr = errorId(t('This task needs a title.'))
  const instructionErr = errorId(t('This task needs an instruction for the agent.'))
  const stop = plan.stopAfter.includes(task.id)
  const backTitle = task.onBlocking ? (plan.tasks.find((x) => x.id === task.onBlocking!.backTo)?.title ?? task.onBlocking.backTo) : null
  const loopOptions = plan.tasks.filter((x) => upstreamOf(plan.tasks, task.id).has(x.id))
  const set = (patch: Partial<PlanTask>) => onChange(patchTask(plan, task.id, patch))
  return (
    <div data-task-id={task.id} className={cn('grid min-w-0 gap-2 rounded-lg px-2.5 py-2', open && 'bg-foreground/5')}>
      <div className="flex min-w-0 items-start gap-2">
        <span aria-hidden className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-secondary text-xs font-medium text-muted-foreground tabular-nums">
          {number}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="group flex min-w-0 flex-1 items-start gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight aria-hidden className={cn('mt-[3px] size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')} strokeWidth={2.2} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{task.title || t('Untitled task')}</span>
            <span className="block text-xs text-muted-foreground">
              {taskKindLabel(task.kind)}
              {task.doneWhen ? <> · {t('Done when: {criterion}', { criterion: task.doneWhen })}</> : null}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => onChange(removeTask(plan, task.id))}
          disabled={plan.tasks.length <= 1}
          aria-label={t('Remove task “{title}”', { title: task.title })}
          title={t('Remove task')}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
        >
          <Trash2 aria-hidden className="size-3.5" strokeWidth={1.8} />
        </button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-7">
        <ExecutorMenu label={t('Executor of “{title}”', { title: task.title })} value={{ agent: task.agent, model: task.model, effort: task.effort }} allowed={allowed} onChange={(next) => set(next)} />
        <PermissionMenu label={t('Permissions of “{title}”', { title: task.title })} value={task.permission} max={max} onChange={(permission) => set({ permission })} />
        <AfterMenu plan={plan} task={task} onChange={onChange} />
        <button type="button" aria-pressed={stop} onClick={() => onChange(toggleStop(plan, task.id))} className={planChip} title={t('Ladder pauses here until you press Continue')}>
          <CirclePause aria-hidden className={cn('size-3.5 shrink-0', stop ? 'text-foreground' : 'text-muted-foreground')} strokeWidth={stop ? 2.4 : 1.8} />
          {stop ? t('Pauses after this task') : t('Pause after')}
        </button>
      </div>
      {task.kind === 'review' && (
        <p className="flex min-w-0 items-start gap-1.5 pl-7 text-xs text-muted-foreground">
          <Info aria-hidden className="mt-px size-3 shrink-0" strokeWidth={1.9} />
          {task.onBlocking ? t('With blocking issues it goes back to “{task}”, up to {n} rounds, then asks you.', { task: backTitle ?? '', n: task.onBlocking.max }) : t('Blocking issues stop the plan and ask you.')}
        </p>
      )}
      {errors.length > 0 && (
        <ul role="alert" className="grid gap-0.5 pl-7 text-xs text-destructive">
          {errors.map((message, i) => (
            <li key={i} id={`${bodyId}-e${i}`}>{message}</li>
          ))}
        </ul>
      )}
      {open && (
        <div id={bodyId} className="grid min-w-0 gap-2.5 pl-7">
          <label className="grid gap-1">
            <span className={sectionTitle}>{t('Title')}</span>
            <input value={task.title} aria-invalid={Boolean(titleErr)} aria-describedby={titleErr} maxLength={PLAN_LIMITS.title} onChange={(e) => set({ title: e.target.value })} className={cn(field, 'h-8 py-0')} />
          </label>
          <label className="grid gap-1">
            <span className={sectionTitle}>{t('Instruction for the agent')}</span>
            <textarea value={task.instruction} aria-invalid={Boolean(instructionErr)} aria-describedby={instructionErr} maxLength={PLAN_LIMITS.instruction} rows={4} onChange={(e) => set({ instruction: e.target.value })} className={cn(field, 'max-h-72 resize-y [field-sizing:content]')} />
          </label>
          <label className="grid gap-1">
            <span className={sectionTitle}>{t('Done when')}</span>
            <input value={task.doneWhen ?? ''} maxLength={PLAN_LIMITS.doneWhen} placeholder={t('Optional, like “concurrency tests on 401 pass”')} onChange={(e) => set({ doneWhen: e.target.value || null })} className={cn(field, 'h-8 py-0')} />
          </label>
          {task.kind === 'review' && (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className={sectionTitle}>{t('On blocking issues')}</span>
              <DropdownMenu>
                <DropdownMenuTrigger className={planChip} aria-label={t('Go back to')}>
                  <span className="min-w-0 truncate">{backTitle ? t('Go back to “{task}”', { task: backTitle }) : t('Stop and ask me')}</span>
                  <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" strokeWidth={2} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                  <DropdownMenuRadioGroup value={task.onBlocking?.backTo ?? ''} onValueChange={(backTo) => set({ onBlocking: backTo ? { backTo, max: task.onBlocking?.max ?? 2 } : null })}>
                    <DropdownMenuRadioItem value="">{t('Stop and ask me')}</DropdownMenuRadioItem>
                    {loopOptions.map((x) => (
                      <DropdownMenuRadioItem key={x.id} value={x.id}>
                        <span className="min-w-0 truncate">{t('Go back to “{task}”', { task: x.title })}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {task.onBlocking && (
                <DropdownMenu>
                  <DropdownMenuTrigger className={planChip} aria-label={t('Maximum rounds')}>
                    {t('Up to {n} rounds', { n: task.onBlocking.max })}
                    <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" strokeWidth={2} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-40">
                    <DropdownMenuRadioGroup value={String(task.onBlocking.max)} onValueChange={(max) => set({ onBlocking: { backTo: task.onBlocking!.backTo, max: Number(max) } })}>
                      {Array.from({ length: PLAN_LIMITS.maxLoops }, (_, i) => i + 1).map((n) => (
                        <DropdownMenuRadioItem key={n} value={String(n)}>
                          {t('{n} rounds', { n })}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Constraints: yours carry the "You" label with an icon; remove them with the ×, add them from the field at the bottom. */
function Constraints({ plan, onChange }: { plan: Plan; onChange: (next: Plan) => void }) {
  const [text, setText] = useState('')
  const full = plan.constraints.length >= PLAN_LIMITS.constraints
  const add = () => {
    const value = text.trim()
    if (!value || full) return
    onChange({ ...plan, constraints: [...plan.constraints, { text: value, by: 'user' }] })
    setText('')
  }
  return (
    <div className="grid min-w-0 gap-1.5">
      <h4 className={sectionTitle}>{plan.constraints.length ? t('Constraints · {n}', { n: plan.constraints.length }) : t('Constraints')}</h4>
      {plan.constraints.length > 0 && (
        <ul className="grid min-w-0 gap-0.5">
          {plan.constraints.map((constraint, i) => (
            <li key={`${i}:${constraint.text}`} className="flex min-w-0 items-start gap-2 rounded-md py-0.5 pr-0.5 pl-1 text-sm leading-[1.5]">
              <span aria-hidden className="mt-[0.62em] size-1 shrink-0 rounded-full bg-muted-foreground" />
              <span className="min-w-0 flex-1 break-words">{constraint.text}</span>
              {constraint.by === 'user' && (
                <span title={t('You added this constraint')} className="mt-px inline-flex h-5 shrink-0 items-center gap-1 rounded-sm bg-foreground/10 px-1.5 text-xs text-foreground">
                  <User aria-hidden className="size-3" strokeWidth={2} />
                  {t('You')}
                </span>
              )}
              <button
                type="button"
                aria-label={t('Remove constraint “{text}”', { text: constraint.text })}
                onClick={() => onChange({ ...plan, constraints: plan.constraints.filter((_, j) => j !== i) })}
                className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X aria-hidden className="size-3.5" strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <input
          value={text}
          maxLength={PLAN_LIMITS.constraint}
          disabled={full}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              add()
            }
          }}
          aria-label={t('New constraint')}
          placeholder={full ? t('Too many constraints') : t('Add a constraint, like “do not touch src/legacy/”')}
          className={cn(field, 'h-8 flex-1 py-0')}
        />
        <button type="button" onClick={add} disabled={!text.trim() || full} className={planButton.secondary}>
          {t('Add')}
        </button>
      </div>
    </div>
  )
}

/** Where tasks write: a new worktree (default in git projects) or the main checkout. */
function WorkspaceChoice({ value, onChange, isGit }: { value: 'main' | 'worktree'; onChange: (next: 'main' | 'worktree') => void; isGit: boolean }) {
  const options: { id: 'main' | 'worktree'; label: string; hint: string }[] = [
    { id: 'worktree', label: t('New worktree'), hint: t('An isolated copy on its own branch: your checkout stays untouched.') },
    { id: 'main', label: t('Main checkout'), hint: t('Edits your files directly: a dev server you already run sees the changes.') }
  ]
  const shown = isGit ? options : options.filter((o) => o.id === 'main')
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = shown[(index + step + shown.length) % shown.length]
    onChange(next.id)
    refs.current[(index + step + shown.length) % shown.length]?.focus()
  }
  const current = shown.find((o) => o.id === value) ?? shown[0]
  return (
    <div className="grid min-w-0 gap-1">
      <div role="radiogroup" aria-label={t('Where the tasks write')} className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className={cn(sectionTitle, 'mr-1')}>{t('Workspace')}</span>
        {shown.map((option, i) => {
          const checked = option.id === current.id
          return (
            <button
              key={option.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(option.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(planChip, checked && 'bg-accent font-medium')}
            >
              {checked ? <Check aria-hidden className="size-3.5 shrink-0" strokeWidth={2.4} /> : option.id === 'worktree' ? <GitFork aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} /> : <span aria-hidden className="size-3.5 shrink-0" />}
              {option.label}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">{current.hint}</p>
    </div>
  )
}

export function PlanReview({ state }: { state: PlanState }) {
  const draft = useApp((s) => s.planDrafts[state.id])
  const setDraft = useApp((s) => s.setPlanDraft)
  const planEdit = useApp((s) => s.planEdit)
  const planApprove = useApp((s) => s.planApprove)
  const planReject = useApp((s) => s.planReject)
  const isGit = useApp((s) => s.projects.find((p) => p.id === state.projectId)?.isGit ?? true)
  const rules = usePlanRules(state.projectId)
  const [workspace, setWorkspace] = useState<'main' | 'worktree'>(isGit ? 'worktree' : 'main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [message, setMessage] = useState('')
  const [showAgentChanges, setShowAgentChanges] = useState(false)
  const rejectArea = useRef<HTMLTextAreaElement>(null)
  const errorsId = useId()

  const plan = draft?.plan ?? state.plan
  // The agent revised the plan while you were editing it: your draft stays, and you choose which version to keep.
  // While saving, the revision goes up because of your own edit: that is not a conflict.
  const conflict = Boolean(draft && draft.base !== state.revision) && !busy
  const validation = useMemo(() => validatePlan(plan, rules ?? undefined), [plan, rules])
  const problems = useMemo(() => checkPlan(plan, rules), [plan, rules])
  const { byTask, general } = problems
  // The raw validatePlan details (in English, meant for the agent) are shown only for what the translated checks do not explain.
  const rawErrors = validation.ok || problems.count > 0 ? [] : validation.errors
  const goalIndex = general.indexOf(t('The goal is empty.'))
  const goalErr = goalIndex >= 0 ? goalIndex : undefined
  const hasErrors = problems.count > 0 || rawErrors.length > 0

  const edit = (next: Plan) => {
    setError(null)
    if (samePlan(next, state.plan) && !conflict) setDraft(state.id, null)
    else setDraft(state.id, { base: draft?.base ?? state.revision, basePlan: draft?.basePlan ?? state.plan, plan: next })
  }

  const canApprove = validation.ok && !hasErrors && !busy && !conflict
  const approve = async () => {
    if (!validation.ok || hasErrors || busy || conflict) return
    setBusy(true)
    setError(null)
    let revision = state.revision
    if (draft) {
      const saved = await planEdit(state.id, draft.base, validation.plan)
      if (!saved.ok) {
        setError(saved.error)
        setBusy(false)
        return
      }
      revision = saved.data.revision
      // The host has your version: the draft is no longer needed, and if approval fails the card shows that one anyway.
      setDraft(state.id, null)
    }
    const result = await planApprove(state.id, revision, workspace)
    if (!result.ok) setError(result.error)
    else setDraft(state.id, null)
    setBusy(false)
  }

  const reject = async () => {
    setBusy(true)
    setError(null)
    const result = await planReject(state.id, message)
    if (!result.ok) setError(result.error)
    else setDraft(state.id, null)
    setBusy(false)
  }

  return (
    <div
      className="grid min-w-0 gap-4"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canApprove) {
          e.preventDefault()
          void approve()
        }
      }}
    >
      {state.updateReason && (
        <p className="flex min-w-0 items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm leading-[1.5] text-foreground">
          <Info aria-hidden className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.9} />
          <span className="min-w-0 break-words">
            <span className="font-medium">{t('The agent revised the plan')}</span> · {state.updateReason}
          </span>
        </p>
      )}
      {conflict && draft && (
        <div role="alert" className="grid min-w-0 gap-2 rounded-lg bg-attention/10 px-3 py-2.5 text-sm">
          <p className="leading-[1.5]">
            <span className="font-semibold text-attention">{t('The plan changed while you were editing')}</span> · {t('The agent sent a new version. Your edits are kept: pick which version to continue from.')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setDraft(state.id, { ...draft, base: state.revision, basePlan: state.plan })} className={planButton.secondary}>
              {t('Keep my version')}
            </button>
            <button type="button" onClick={() => setDraft(state.id, null)} className={planButton.secondary}>
              {t('Use the agent’s version')}
            </button>
            <button type="button" onClick={() => setShowAgentChanges((v) => !v)} aria-expanded={showAgentChanges} className={planButton.ghost}>
              {showAgentChanges ? t('Hide what changed') : t('Show what changed')}
            </button>
          </div>
          {showAgentChanges && <PlanDiff from={draft.basePlan} to={state.plan} />}
        </div>
      )}

      <label className="grid gap-1">
        <span className={sectionTitle}>{t('Goal')}</span>
        <textarea value={plan.goal} aria-invalid={goalErr !== undefined} aria-describedby={goalErr !== undefined ? `${errorsId}-g${goalErr}` : undefined} rows={1} maxLength={PLAN_LIMITS.goal} onChange={(e) => edit({ ...plan, goal: e.target.value })} className={cn(field, 'resize-none [field-sizing:content]')} />
      </label>

      <Constraints plan={plan} onChange={edit} />

      <div className="grid min-w-0 gap-1.5">
        <h4 className={sectionTitle}>{t('Tasks · {n}', { n: plan.tasks.length })}</h4>
        <PhaseList
          tasks={plan.tasks}
          render={(task, number) => (
            <TaskEditor key={task.id} plan={plan} task={task} number={number} errors={byTask.get(task.id) ?? []} allowed={rules?.allowed ?? []} max={rules?.permissionsMax ?? null} onChange={edit} />
          )}
        />
      </div>

      {(general.length > 0 || rawErrors.length > 0) && (
        <div role="alert" className="grid gap-0.5 text-sm text-destructive">
          {general.length > 0 && (
            <ul className="grid gap-0.5">
              {general.map((message, i) => (
                <li key={i} id={`${errorsId}-g${i}`}>{message}</li>
              ))}
            </ul>
          )}
          {rawErrors.length > 0 && (
            <>
              <p className="font-medium">{t('The plan has problems the agent needs to fix')}</p>
              <ul className="grid gap-0.5 text-xs">
                {rawErrors.map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <WorkspaceChoice value={workspace} onChange={setWorkspace} isGit={isGit} />

      {rejecting ? (
        <div className="grid min-w-0 gap-2 rounded-lg bg-muted/50 p-2.5" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setRejecting(false))}>
          <label className="grid gap-1">
            <span className={sectionTitle}>{t('Message to the agent (optional)')}</span>
            <textarea ref={rejectArea} autoFocus value={message} rows={2} onChange={(e) => setMessage(e.target.value)} placeholder={t('For example: do it without the review')} className={cn(field, 'resize-none [field-sizing:content]')} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void reject()} disabled={busy} className={planButton.destructive}>
              {t('Reject plan')}
            </button>
            <button type="button" onClick={() => setRejecting(false)} className={planButton.ghost}>
              {t('Cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void approve()} disabled={!canApprove} aria-describedby={hasErrors ? errorsId : undefined} className={planButton.primary}>
            {busy ? t('Starting…') : t('Approve and run')}
            {!busy && <Kbd className="text-primary-foreground [&_kbd]:bg-transparent [&_kbd]:ring-1 [&_kbd]:ring-primary-foreground/70 [&_kbd]:ring-inset">⌘↵</Kbd>}
          </button>
          <button type="button" onClick={() => setRejecting(true)} disabled={busy} className={planButton.secondary}>
            {t('Reject…')}
          </button>
          {draft && !conflict && (
            <button type="button" onClick={() => setDraft(state.id, null)} disabled={busy} className={planButton.ghost}>
              {t('Discard my edits')}
            </button>
          )}
          {hasErrors && <span id={errorsId} className="text-xs text-muted-foreground">{t('Fix the issues above to approve.')}</span>}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm break-words text-destructive">
          {error.split('\n').map((line, i) => (
            <span key={i} className="block">
              {line}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}
