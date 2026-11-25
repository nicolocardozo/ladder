// Executable plans for the web preview: a plan from prompt to review, in every state.
import type { Plan, PlanState, PlanTask, PlanTaskRun, PlanTemplate, TaskResult } from '@shared/plan'
import type { SessionSummary } from '@shared/protocol'
import { ConversationBuilder, type Fixture } from './fixtures'

export const PLAN_PROJECT = 'preview'

export type PlanScenario = 'review' | 'running' | 'paused' | 'stop-point' | 'confirm-update' | 'completed' | 'stopped'

export const PLAN_SCENARIOS: { id: PlanScenario; label: string }[] = [
  { id: 'review', label: 'Plan: in review' },
  { id: 'running', label: 'Plan: running (parallel, waiting for you)' },
  { id: 'paused', label: 'Plan: paused by a usage limit' },
  { id: 'stop-point', label: 'Plan: stop point' },
  { id: 'confirm-update', label: 'Plan: update to confirm' },
  { id: 'completed', label: 'Plan: done' },
  { id: 'stopped', label: 'Plan: stopped' }
]

export interface PlanFixture extends Fixture {
  plans: PlanState[]
  /** Task and coordinator sessions, for "Open session" and the banner. */
  sessions: SessionSummary[]
  coordinatorId: string
  planId: string
}

const MIN = 60_000

const task = (fields: Partial<PlanTask> & Pick<PlanTask, 'id' | 'title'>): PlanTask => ({
  instruction: '',
  kind: 'other',
  agent: 'claude-code',
  model: null,
  effort: null,
  permission: 'edit',
  after: [],
  doneWhen: null,
  onBlocking: null,
  ...fields
})

const result = (fields: Partial<TaskResult> & Pick<TaskResult, 'summary'>): TaskResult => ({
  status: 'done',
  decisions: [],
  deviations: [],
  checks: [],
  issues: [],
  questions: [],
  sideEffects: [],
  verdict: null,
  ...fields
})

const run = (taskId: string, plan: Plan, fields: Partial<PlanTaskRun> = {}): PlanTaskRun => {
  const spec = plan.tasks.find((x) => x.id === taskId)!
  return {
    taskId,
    status: 'pending',
    sessionId: null,
    agent: spec.agent,
    model: spec.model,
    effort: spec.effort,
    iteration: 1,
    attempt: 1,
    cwd: null,
    worktree: null,
    startedAt: null,
    endedAt: null,
    result: null,
    error: null,
    queuedBehind: null,
    waiting: false,
    files: null,
    ...fields
  }
}

/** Plan by Claude Code, implementation by Codex, review by Claude Code with a different model, stop after the plan. */
function samplePlan(): Plan {
  return {
    goal: 'Session cookies in httpOnly: the client no longer reads the token',
    constraints: [
      { text: 'Public API of useSession unchanged', by: 'agent' },
      { text: 'Use pnpm', by: 'agent' },
      { text: 'Do not touch src/legacy/', by: 'user' }
    ],
    tasks: [
      task({
        id: 'plan-1',
        title: 'Analysis and plan',
        kind: 'plan',
        instruction: 'Read `src/lib/http.ts`, `useSession` and every use of `localStorage`. Write the plan with the steps and the acceptance criteria.',
        model: 'claude-opus-5-5',
        effort: 'high',
        permission: 'plan',
        doneWhen: 'Plan with steps and acceptance criteria'
      }),
      task({
        id: 'implement-1',
        title: 'Implementation',
        kind: 'implement',
        instruction: 'Follow the plan from the previous task.\n\n1. `authFetch` with `credentials: "include"`\n2. A single refresh promise shared across concurrent requests\n3. `useSession` reads `/auth/me`\n4. Logout clears the cache\n5. Update the tests',
        agent: 'codex',
        model: 'gpt-5.5',
        effort: 'medium',
        permission: 'edit',
        after: ['plan-1'],
        doneWhen: 'Concurrency tests on 401 passing'
      }),
      task({
        id: 'review-1',
        title: 'Review',
        kind: 'review',
        instruction: 'Review the changes read-only. Flag as blocking only the problems that break the requested behavior.',
        model: 'claude-sonnet-5',
        effort: 'medium',
        permission: 'plan',
        after: ['implement-1'],
        onBlocking: { backTo: 'implement-1', max: 2 }
      })
    ],
    stopAfter: ['plan-1']
  }
}

const PLAN_RESULT = result({
  summary: 'I read 11 files and searched for uses of `localStorage`. The backend already exposes `POST /auth/refresh` (it answers 204 and sets the cookie).\n\n**Plan**\n1. `authFetch` with `credentials: "include"`\n2. A single shared refresh promise\n3. `useSession` reads `/auth/me`\n4. Logout clears the React Query cache\n5. Concurrency test on 401\n\n**Acceptance criteria**: no `localStorage` outside `src/legacy`, clean `tsc`.',
  decisions: ['Refresh lives in `authFetch`, not in the hook', 'One shared refresh promise', '`useSession` reads `/auth/me`', 'Logout clears the React Query cache'],
  checks: [{ cmd: 'rg localStorage src', exit: 0, summary: 'Only in src/legacy' }],
  questions: ['Should a 403 after the refresh be treated as a logout?']
})

const IMPLEMENT_RESULT = result({
  summary: 'All five steps are done. `authFetch` keeps a single refresh promise; `useSession` reads `/auth/me`. The concurrency test on 401 passes.',
  decisions: ['`authFetch` retries only once after the refresh'],
  deviations: ['Added `msw` as a dev dependency for the tests'],
  checks: [
    { cmd: 'pnpm vitest run src/lib', exit: 0, summary: '16 passed out of 16' },
    { cmd: 'pnpm tsc --noEmit', exit: 0, summary: 'No errors' }
  ],
  sideEffects: ['pnpm add -D msw@2']
})

const REVIEW_BLOCKING = result({
  status: 'done',
  summary: 'The logic is right, but one case leaves requests hanging.',
  issues: [
    { severity: 'blocking', file: 'src/lib/http.ts', line: 41, text: 'After a failed refresh the promise is not reset and later requests hang.' },
    { severity: 'minor', file: 'src/hooks/useSession.test.ts', line: null, text: 'The test for logout during a refresh is missing.' }
  ],
  verdict: 'changes-requested'
})

const REVIEW_APPROVED = result({
  summary: 'No blocking problems. A failed refresh now resets the promise.',
  checks: [{ cmd: 'pnpm vitest run src/lib', exit: 0, summary: '17 passed out of 17' }],
  verdict: 'approved'
})

function planState(id: string, coordinatorId: string, plan: Plan, fields: Partial<PlanState> & Pick<PlanState, 'status' | 'runs'>): PlanState {
  const now = Date.now()
  return {
    id,
    sessionId: coordinatorId,
    projectId: PLAN_PROJECT,
    revision: 1,
    plan,
    author: 'claude-code',
    updateReason: null,
    pendingUpdate: null,
    pause: null,
    workspace: null,
    createdAt: now - 40 * MIN,
    updatedAt: now - MIN,
    approvedAt: null,
    endedAt: null,
    ...fields
  }
}

/** Minimal Ladder session: used by "Open session" and the task banner. */
export function planSession(id: string, title: string, fields: Partial<SessionSummary>): SessionSummary {
  const at = Date.now() - 5 * MIN
  return {
    id,
    projectId: PLAN_PROJECT,
    title,
    titleSource: 'generated',
    agent: 'claude-code',
    model: null,
    effort: null,
    permission: 'edit',
    createdAt: at,
    updatedAt: at,
    run: 'running',
    waitingLabel: null,
    activity: null,
    unread: false,
    lastReadSeq: 0,
    archived: false,
    queue: [],
    context: null,
    mode: 'chat',
    cwd: '/tmp/acme-app',
    worktree: null,
    command: null,
    terminalId: null,
    estimated: false,
    waitingSince: null,
    request: null,
    openRequests: 0,
    activityAt: at,
    canSteer: true,
    branch: null,
    pr: null,
    source: null,
    ...fields
  }
}

export const taskSession = (planId: string, spec: PlanTask, fields: Partial<SessionSummary> = {}) =>
  planSession(`task-${planId}-${spec.id}`, spec.title, { agent: spec.agent, model: spec.model, plan: { planId, role: 'task', taskId: spec.id }, ...fields })

const sid = (planId: string, taskId: string) => `task-${planId}-${taskId}`

/** Coordinator chat: the prompt, the proposal and the card. With `earlier`, a previous plan that was already replaced. */
function coordinator(planIds: string[], opts: { earlier?: string } = {}): Fixture {
  const b = new ConversationBuilder(Date.now() - 50 * MIN, 'p')
  b.turn()
  b.user('Replace the token stored in localStorage with httpOnly cookies managed by the backend. The client must no longer read the token. Organize the work: you write the plan, Codex implements, Sonnet reviews. Stop after the plan.', 0)
  if (opts.earlier) {
    b.tool('plan', 'propose_plan', 'Proposes a plan', null, { ms: 400 })
    b.plan(opts.earlier)
    b.assistant('I proposed a first plan with two tasks.', false, 2_000)
    b.end({ durationMs: 40_000 })
    b.turn()
    b.user('Add a review at the end, with a different model.', 4 * MIN)
  }
  b.assistant('I read the files that touch the token and asked for confirmation on the refresh. I am preparing the plan with three tasks.', false, 6_000)
  b.tool('read', 'Read', 'Reads src/lib/http.ts', 'src/lib/http.ts', { ms: 120 })
  b.tool('plan', 'propose_plan', 'Proposes a plan', null, { ms: 500 })
  for (const planId of planIds) b.plan(planId)
  b.assistant('The plan is in the card above: tasks, executors and permissions can be edited there. It starts after you approve it.', false, 2_500)
  b.end({ durationMs: 52_000, counts: { commands: 0, edits: 0, reads: 1, searches: 0 } })
  b.shiftToNow(30_000)
  return { items: b.items, run: 'idle', activity: null, firstUnreadSeq: null }
}

export function planFixture(scenario: PlanScenario): PlanFixture {
  const now = Date.now()
  const coordinatorId = `plan-coord-${scenario}`
  const planId = `plan-${scenario}`
  const sessions: SessionSummary[] = []
  const plans: PlanState[] = []
  const withCoordinator = (summary: Partial<SessionSummary>) =>
    sessions.push(planSession(coordinatorId, 'Session cookies in httpOnly', { run: 'idle', plan: { planId, role: 'coordinator', taskId: null }, ...summary }))

  if (scenario === 'review') {
    const plan = samplePlan()
    const older: Plan = { ...plan, tasks: plan.tasks.slice(0, 2), stopAfter: [] }
    plans.push(planState('plan-older', coordinatorId, older, { status: 'superseded', runs: older.tasks.map((x) => run(x.id, older)), createdAt: now - 48 * MIN, updatedAt: now - 20 * MIN }))
    plans.push(planState(planId, coordinatorId, plan, { status: 'review', runs: plan.tasks.map((x) => run(x.id, plan)), updateReason: 'I added the final review with Sonnet, as you asked.', revision: 2 }))
    withCoordinator({ run: 'idle', planWaiting: true, waitingLabel: 'Plan review', waitingSince: now - MIN })
    return { ...coordinator([planId], { earlier: 'plan-older' }), plans, sessions, coordinatorId, planId }
  }

  if (scenario === 'running') {
    const plan: Plan = {
      goal: 'Migrate the forms to the design system',
      constraints: [{ text: 'No keyboard accessibility regressions', by: 'agent' }],
      tasks: [
        task({ id: 'analysis', title: 'Forms analysis', kind: 'plan', agent: 'codex', model: 'gpt-5.5', effort: 'high', permission: 'plan', instruction: 'List the forms and fields to migrate.' }),
        task({ id: 'wrapper', title: 'Field wrapper', kind: 'implement', model: 'claude-opus-5-5', effort: 'high', permission: 'edit', after: ['analysis'], doneWhen: 'Field tests passing', instruction: 'Create the `Field` wrapper and migrate the fields.' }),
        task({ id: 'ui-components', title: 'Form components', kind: 'implement', model: 'claude-sonnet-5', effort: 'medium', permission: 'edit', after: ['analysis'], instruction: 'Migrate the `Select`, `Checkbox` and `DatePicker` components.' }),
        task({ id: 'changelog', title: 'Release notes', kind: 'other', agent: 'codex', model: 'gpt-5.5-mini', permission: 'edit', after: ['analysis'], instruction: 'Update `CHANGELOG.md`.' }),
        task({ id: 'review', title: 'Final review', kind: 'review', model: 'claude-sonnet-5', permission: 'plan', after: ['wrapper', 'ui-components', 'changelog'], onBlocking: { backTo: 'wrapper', max: 2 }, instruction: 'Review everything read-only.' })
      ],
      stopAfter: []
    }
    const runs = [
      run('analysis', plan, {
        status: 'completed',
        sessionId: sid(planId, 'analysis'),
        startedAt: now - 22 * MIN,
        endedAt: now - 15 * MIN,
        files: null,
        result: result({ summary: 'Found 9 forms and 41 fields. A single `Field` wrapper first, then the components, is the way to go.', decisions: ['A single `Field` wrapper for label, error and help'], checks: [{ cmd: 'rg "<form" src', exit: 0, summary: '9 results' }] })
      }),
      run('wrapper', plan, { status: 'running', waiting: true, sessionId: sid(planId, 'wrapper'), iteration: 2, attempt: 1, startedAt: now - 9 * MIN, files: { count: 6, added: 142, removed: 38 }, cwd: '/tmp/acme-app' }),
      run('ui-components', plan, { status: 'running', sessionId: sid(planId, 'ui-components'), startedAt: now - 8 * MIN, worktree: '/tmp/acme-app-wt', files: { count: 3, added: 61, removed: 20 } }),
      run('changelog', plan, { status: 'queued', queuedBehind: 'Field wrapper' }),
      // The first-round review sent the wrapper back: its result stays, the second round waits.
      run('review', plan, { iteration: 2, result: REVIEW_BLOCKING, sessionId: sid(planId, 'review'), startedAt: now - 14 * MIN, endedAt: now - 11 * MIN })
    ]
    plans.push(planState(planId, coordinatorId, plan, { status: 'running', runs, approvedAt: now - 22 * MIN, workspace: { kind: 'worktree', path: '/tmp/acme-app-wt', branch: 'ladder/form-design-system', base: 'a1c9e2f' } }))
    sessions.push(taskSession(planId, plan.tasks[0], { run: 'idle', agent: 'codex' }))
    sessions.push(taskSession(planId, plan.tasks[1], { run: 'waiting', waitingLabel: 'Approval requested' }))
    sessions.push(taskSession(planId, plan.tasks[2]))
    withCoordinator({ run: 'idle', activity: null })
    return { ...coordinator([planId]), plans, sessions, coordinatorId, planId }
  }

  const plan = samplePlan()
  const planRun = (fields: Partial<PlanTaskRun> = {}) => run('plan-1', plan, { status: 'completed', sessionId: sid(planId, 'plan-1'), startedAt: now - 38 * MIN, endedAt: now - 31 * MIN, result: PLAN_RESULT, ...fields })
  const base = { approvedAt: now - 30 * MIN, workspace: { kind: 'worktree' as const, path: '/tmp/acme-app-wt', branch: 'ladder/session-cookie', base: 'a1c9e2f' } }
  sessions.push(...plan.tasks.map((spec) => taskSession(planId, spec, { run: 'idle' })))

  if (scenario === 'paused') {
    plans.push(
      planState(planId, coordinatorId, plan, {
        ...base,
        status: 'paused',
        runs: [
          planRun(),
          run('implement-1', plan, { status: 'failed', sessionId: sid(planId, 'implement-1'), startedAt: now - 29 * MIN, endedAt: now - 24 * MIN, error: 'Codex usage limit reached: it resets at 16:40.', files: { count: 4, added: 96, removed: 12 } }),
          run('review-1', plan)
        ],
        pause: {
          reason: 'failed',
          taskId: 'implement-1',
          message: 'Implementation stopped: Codex usage limit (resets at 16:40). Partial work: 4 files changed, tests not completed. Already run: pnpm add -D msw@2.',
          choices: ['retry', 'reassign', 'skip', 'stop'],
          at: now - 24 * MIN
        }
      })
    )
    withCoordinator({ run: 'idle', planWaiting: true, waitingLabel: 'Plan paused', waitingSince: now - 24 * MIN })
  } else if (scenario === 'stop-point') {
    plans.push(
      planState(planId, coordinatorId, plan, {
        ...base,
        status: 'paused',
        runs: [planRun(), run('implement-1', plan), run('review-1', plan)],
        pause: { reason: 'stop-point', taskId: 'plan-1', message: 'The plan is ready. Review it before any code is written.', choices: ['continue', 'stop'], at: now - 2 * MIN }
      })
    )
    withCoordinator({ run: 'idle', planWaiting: true, waitingLabel: 'Plan paused', waitingSince: now - 2 * MIN })
  } else if (scenario === 'confirm-update') {
    const next: Plan = {
      ...plan,
      constraints: [...plan.constraints, { text: 'The refresh must never log the cookie', by: 'agent' }],
      tasks: [
        plan.tasks[0],
        { ...plan.tasks[1], permission: 'full' },
        { ...plan.tasks[2], agent: 'codex', model: 'gpt-5.5', effort: 'high', after: ['implement-1', 'docs-1'] },
        task({ id: 'docs-1', title: 'Documentation', kind: 'other', model: 'claude-sonnet-5', permission: 'edit', after: ['implement-1'], instruction: 'Update `docs/auth.md`.' })
      ],
      stopAfter: ['plan-1', 'implement-1']
    }
    plans.push(
      planState(planId, coordinatorId, plan, {
        ...base,
        status: 'paused',
        runs: [planRun(), run('implement-1', plan, { status: 'running', sessionId: sid(planId, 'implement-1'), startedAt: now - 10 * MIN, files: { count: 2, added: 40, removed: 6 } }), run('review-1', plan)],
        updateReason: 'The Sonnet review has already seen the plan: a reviewer with a different model finds more. Wider permissions are also needed to install the test packages.',
        pendingUpdate: next,
        pause: { reason: 'confirm-update', taskId: 'review-1', message: 'Claude Code asks to change the review executor, give the implementation full access and add a task.', choices: ['stop'], at: now - MIN }
      })
    )
    withCoordinator({ run: 'idle', planWaiting: true, waitingLabel: 'Plan paused', waitingSince: now - MIN })
  } else if (scenario === 'completed') {
    plans.push(
      planState(planId, coordinatorId, plan, {
        ...base,
        status: 'completed',
        endedAt: now - 3 * MIN,
        runs: [
          planRun(),
          run('implement-1', plan, { status: 'completed', iteration: 2, attempt: 2, sessionId: sid(planId, 'implement-1'), startedAt: now - 29 * MIN, endedAt: now - 10 * MIN, result: IMPLEMENT_RESULT, files: { count: 7, added: 241, removed: 96 } }),
          run('review-1', plan, { status: 'completed', iteration: 2, sessionId: sid(planId, 'review-1'), startedAt: now - 9 * MIN, endedAt: now - 3 * MIN, result: REVIEW_APPROVED })
        ]
      })
    )
    withCoordinator({ run: 'idle', unread: true })
  } else {
    plans.push(
      planState(planId, coordinatorId, plan, {
        ...base,
        status: 'stopped',
        endedAt: now - 6 * MIN,
        runs: [
          planRun(),
          run('implement-1', plan, { status: 'interrupted', sessionId: sid(planId, 'implement-1'), startedAt: now - 29 * MIN, endedAt: now - 6 * MIN, error: 'Stopped by you.', files: { count: 2, added: 30, removed: 4 } }),
          run('review-1', plan)
        ]
      })
    )
    withCoordinator({ run: 'idle' })
  }
  return { ...coordinator([planId]), plans, sessions, coordinatorId, planId }
}

/** Saved templates (`plan.templates`). */
export function planTemplatesFixture(): PlanTemplate[] {
  const base = samplePlan()
  const generic: Plan = { ...base, goal: '', constraints: [], stopAfter: ['plan-1'] }
  const double: Plan = {
    goal: '',
    constraints: [],
    tasks: [
      task({ id: 'implement', title: 'Implementation', kind: 'implement', model: 'claude-opus-5-5', permission: 'edit', instruction: 'Implement the request.' }),
      task({ id: 'review-claude', title: 'Review with Claude', kind: 'review', model: 'claude-sonnet-5', permission: 'plan', after: ['implement'], instruction: 'Review read-only.' }),
      task({ id: 'review-codex', title: 'Review with Codex', kind: 'review', agent: 'codex', model: 'gpt-5.5', permission: 'plan', after: ['implement'], instruction: 'Review read-only.' })
    ],
    stopAfter: []
  }
  const at = Date.now()
  return [
    { id: 'tpl-plan-implement-review', name: 'Plan, implementation, review', plan: generic, createdAt: at - 9 * 86_400_000 },
    { id: 'tpl-double', name: 'Double review', plan: double, createdAt: at - 2 * 86_400_000 }
  ]
}
