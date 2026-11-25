// Hand-off message of a plan task: what the executor reads as the first message of its session.
// In English, like everything said to an agent. Pure function, no path aliases (the test runs it with node).
import type { Plan, PlanIssue, PlanState, PlanTask, PlanTaskKind, PlanTaskRun, TaskResult } from '../shared/plan'

/** Diffstat of a set of changes. */
export interface PromptStat {
  added: number
  removed: number
  count: number
  files: string[]
}

export type PromptMode =
  /** First start of the task. */
  | { kind: 'start' }
  /** Return from a review: the task redoes the work in its own session. */
  | { kind: 'loop'; round: number; max: number; reviewTitle: string; reviewSummary: string; issues: PlanIssue[]; /** New session: the full message is needed, not just the issues. */ fresh?: boolean }
  /** A task downstream of the return, redone in its earlier session. */
  | { kind: 'rerun'; round: number }
  /** Retry in the same session after a failure or an interruption. */
  | { kind: 'retry'; error: string | null; partial: PromptStat | null; lastText: string }
  /** New session with another executor. `keepWork`: starts from the work already done; otherwise the folder went back to the start. */
  | { kind: 'reassign'; error: string | null; partial: PromptStat | null; lastText: string; keepWork: boolean; previous: string; partialRef: string | null }

export interface PromptInput {
  state: PlanState
  task: PlanTask
  run: PlanTaskRun
  mode: PromptMode
  /** Where the work is now: the folder and the commit the plan started from. */
  code: { cwd: string; branch: string | null; base: string | null; stat: PromptStat | null; separate: boolean }
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const KIND_GUIDANCE: Record<PlanTaskKind, string> = {
  plan: 'This is a planning task. Read the code and write a plan; do not change any file. The summary you report must contain the steps, in order, and the acceptance criteria for each of them: later tasks work from it.',
  implement: 'This is an implementation task. Make the change, keep it focused on the instruction, and run the relevant checks (tests, typecheck, lint) before you report. List the checks you ran in the result.',
  review:
    'This is a review task. It is read-only: do not change any file. Review the changes against the goal, the constraints and the instruction. Report every problem as an issue with severity ("blocking" when the work must be fixed before going on, "minor" otherwise), the file and the line when you know them, and what is wrong. Set verdict to "approved" only when there is no blocking issue, otherwise "changes-requested".',
  other: 'Do what the instruction says. Change files only if the instruction needs it.'
}

const statLine = (stat: PromptStat | null): string => {
  if (!stat || stat.count === 0) return 'no file changes'
  const shown = stat.files.slice(0, 15).join(', ')
  return `${stat.count} file${stat.count === 1 ? '' : 's'} changed (+${stat.added} −${stat.removed}): ${shown}${stat.files.length > 15 ? `, and ${stat.files.length - 15} more` : ''}`
}

const issueLines = (issues: PlanIssue[]): string[] =>
  issues.map((i) => `- [${i.severity}]${i.file ? ` ${i.file}${i.line ? `:${i.line}` : ''}` : ''} ${i.text}`)

const resultBlock = (task: PlanTask, run: PlanTaskRun): string[] => {
  if (run.status === 'skipped') return [`### ${task.id}: ${task.title}`, 'Skipped by the user: this task did NOT run. Do not assume its work exists.', '']
  const result: TaskResult | null = run.result
  if (!result) return [`### ${task.id}: ${task.title}`, 'Completed without a written result.', '']
  const out = [`### ${task.id}: ${task.title} (by ${run.agent})`, clip(result.summary, 6000)]
  if (result.decisions.length) out.push('Decisions to respect:', ...result.decisions.map((d) => `- ${d}`))
  if (result.deviations.length) out.push('Deviations from its instruction:', ...result.deviations.map((d) => `- ${d}`))
  if (result.checks.length) out.push('Checks it ran:', ...result.checks.map((c) => `- \`${c.cmd}\` → exit ${c.exit ?? '?'}${c.summary ? `: ${c.summary}` : ''}`))
  if (result.issues.length) out.push('Issues it reported:', ...issueLines(result.issues))
  if (result.questions.length) out.push('Open questions:', ...result.questions.map((q) => `- ${q}`))
  if (result.sideEffects.length) out.push('Already run, with effects outside the folder (do not repeat):', ...result.sideEffects.map((s) => `- ${s}`))
  out.push('')
  return out
}

/** Plan overview: id, title, executor and state of each task. */
export function planOverview(plan: Plan, runs: PlanTaskRun[]): string[] {
  return plan.tasks.map((task) => {
    const run = runs.find((r) => r.taskId === task.id)
    return `- ${task.id}: ${task.title} (${run?.agent ?? task.agent}, ${task.permission === 'plan' ? 'read-only' : `${task.permission} access`}${task.after.length ? `, after ${task.after.join(', ')}` : ''}), status: ${run?.status ?? 'pending'}`
  })
}

const FOOTER =
  'When you are done, call the `report_result` tool of the `ladder` MCP server exactly once, with the outcome of this task, then end your turn. Do not call it before the work is finished and do not do more work after calling it.'

/** The full message for the executor. */
export function composePrompt(input: PromptInput): string {
  const { state, task, mode, code } = input
  const { plan } = state
  const out: string[] = []
  const done = (id: string) => state.runs.find((r) => r.taskId === id)

  if (mode.kind === 'loop' && !mode.fresh) {
    out.push(
      `You are still working on task "${task.title}" (${task.id}) of an executable plan in Ladder. The review "${mode.reviewTitle}" came back with blocking issues. This is round ${mode.round} of at most ${mode.max}.`,
      '',
      'Review summary:',
      clip(mode.reviewSummary, 4000),
      '',
      'Issues to fix (fix the blocking ones; fix the minor ones if they are cheap):',
      ...issueLines(mode.issues),
      '',
      `Code state: ${statLine(code.stat)}.`,
      '',
      'Fix the issues in the same folder, run the checks again, and then call report_result again with the new outcome.',
      '',
      FOOTER
    )
    return out.join('\n')
  }
  if (mode.kind === 'rerun') {
    out.push(`Round ${mode.round}: the work this task depends on changed after a review. Read the new results below and do this task again from the current state of the folder.`, '')
  }

  out.push('You are working on one task of an executable plan in Ladder. Other agents work on the other tasks, each in its own session; you only do this one.', '')
  out.push('## Goal', plan.goal, '')
  if (plan.constraints.length) {
    out.push('## Constraints', ...plan.constraints.map((c) => `- ${c.text}${c.by === 'user' ? ' (set by the user: it overrides anything else)' : ''}`), '')
  }
  out.push('## The plan', ...planOverview(plan, state.runs), '')
  out.push('## Your task', `id: ${task.id}`, `kind: ${task.kind}`, `title: ${task.title}`, '', task.instruction)
  if (task.doneWhen) out.push('', `Done when: ${task.doneWhen}`)
  out.push('', KIND_GUIDANCE[task.kind], '')
  if (mode.kind === 'loop') {
    out.push(
      '## Review feedback',
      `This is round ${mode.round} of at most ${mode.max}: the review "${mode.reviewTitle}" found blocking issues in an earlier version of this work. The folder holds that version. Fix these issues first:`,
      clip(mode.reviewSummary, 4000),
      ...issueLines(mode.issues),
      ''
    )
  }
  // Read-only Claude runs in plan mode: without this line it tends to end with ExitPlanMode instead of report_result.
  if (task.permission === 'plan') out.push('You are in read-only (plan) mode for this task. Do not call ExitPlanMode and do not ask to leave plan mode: deliver your output through report_result.', '')

  // Results of the upstream tasks already closed, in plan order.
  const upstream = new Set<string>()
  const walk = (id: string) => {
    for (const dep of plan.tasks.find((x) => x.id === id)?.after ?? []) if (!upstream.has(dep)) (upstream.add(dep), walk(dep))
  }
  walk(task.id)
  const finished = plan.tasks.filter((x) => upstream.has(x.id) && (done(x.id)?.status === 'completed' || done(x.id)?.status === 'skipped'))
  if (finished.length) {
    out.push('## Results of the tasks before yours')
    for (const before of finished) out.push(...resultBlock(before, done(before.id)!))
  }

  out.push('## Code state', `Folder: ${code.cwd}${code.separate ? ' (a separate worktree of this task: your changes are merged into the plan folder when you finish)' : ''}`)
  if (code.branch) out.push(`Branch: ${code.branch}`)
  if (code.base) out.push(`Plan base commit: ${code.base}`)
  out.push(`Changes since the plan base: ${statLine(code.stat)}`, '')

  if (mode.kind === 'retry') {
    out.push(
      '## What happened',
      `A previous attempt at this task did not finish${mode.error ? `: ${mode.error}` : '.'}`,
      `What it left in the folder: ${statLine(mode.partial)}.`,
      ...(mode.lastText ? ['Its last message:', clip(mode.lastText, 1500)] : []),
      'Look at the current state of the folder, continue from there, and do not redo what is already right.',
      ''
    )
  } else if (mode.kind === 'reassign') {
    out.push(
      '## What happened',
      `The previous executor (${mode.previous}) did not finish this task${mode.error ? `: ${mode.error}` : '.'}`,
      ...(mode.keepWork
        ? [`It left these changes in the folder, and you continue from them: ${statLine(mode.partial)}.`, 'Check them before you rely on them.']
        : [`The folder was restored to how it was when the task started. Its partial work was saved${mode.partialRef ? ` in the git ref ${mode.partialRef}` : ''} and is not in the folder: start from the current state.`]),
      ...(mode.lastText ? ['Its last message:', clip(mode.lastText, 1500)] : []),
      ''
    )
  }
  out.push(FOOTER)
  return out.join('\n')
}

/** Message asking for the result from a task that ended its turn without calling report_result. */
export function correctionPrompt(task: PlanTask): string {
  return `Your turn ended without a result for task "${task.title}" (${task.id}). If the task is finished, call the \`report_result\` tool of the \`ladder\` MCP server now, once, with the outcome (status "done", "blocked" or "failed"). If it is not finished, finish it first. Then end your turn.`
}
