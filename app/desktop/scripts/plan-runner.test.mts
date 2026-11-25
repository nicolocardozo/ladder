// Tests for the plan runner against an in-memory fake, plus the git merge on a real repository.
// Run with: node scripts/plan-runner.test.mts   (Node 24, type stripping: no path aliases in the tested files)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePlan, type PlanRules, type PlanState } from '../src/shared/plan.ts'
import { applySideChanges } from '../src/host/plan-git.ts'
import { PlanRunner, type PlanMeta, type RunnerPorts, type TaskSessionSpec } from '../src/host/plan-runner.ts'

let passed = 0
const step = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve(fn()).then(
    () => {
      passed++
      console.log(`  ok  ${name}`)
    },
    (error) => {
      console.log(`  FAIL ${name}`)
      throw error
    }
  )

const rules: PlanRules = { allowed: [], available: ['claude-code', 'codex'], permissionsMax: 'edit' }

// ── Fake ───────────────────────────────────────────────────────────────────

interface Fake {
  runner: PlanRunner
  ports: RunnerPorts
  sessions: Map<string, TaskSessionSpec>
  sends: { sessionId: string; text: string }[]
  interrupts: string[]
  notices: string[]
  attentions: string[]
  told: string[]
  applied: { workspace: string; side: string }[]
  sideCount: number
  refs: string[]
  restores: { sha: string; sessionId: string; exclude: string[] }[]
  removedSides: { path: string; branch: string; sessionIds: string[] }[]
  leftOut: string[] | null
  saveFails: boolean
  snapFails: boolean
  conflict: boolean
  env: Record<string, string>
  saved: Map<string, { state: PlanState; meta: PlanMeta }>
  git: boolean
}

function fake(env: Record<string, string> = {}): Fake {
  let n = 0
  const f = {
    sessions: new Map(),
    sends: [],
    interrupts: [],
    notices: [],
    attentions: [],
    told: [],
    applied: [],
    sideCount: 0,
    refs: [],
    restores: [],
    removedSides: [],
    leftOut: [],
    saveFails: false,
    snapFails: false,
    conflict: false,
    env,
    saved: new Map(),
    git: true
  } as unknown as Fake
  const fill = (text: string, vars?: Record<string, string | number>) => (vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text)
  f.ports = {
    now: () => 1_000 + ++n,
    uuid: () => `id-${++n}`,
    t: fill,
    env: (name) => f.env[name],
    rules: async () => rules,
    save: (state, meta) => f.saved.set(state.id, { state: structuredClone(state), meta: structuredClone(meta) }),
    emit: () => undefined,
    attention: (state, kind) => f.attentions.push(`${kind}:${state.status}`),
    notice: (_id, text) => f.notices.push(text),
    tellAgent: async (_id, text) => void f.told.push(text),
    createSession: async (spec) => {
      const id = `s-${spec.taskId}-${f.sessions.size + 1}`
      f.sessions.set(id, spec)
      return id
    },
    send: async (sessionId, text) => void f.sends.push({ sessionId, text }),
    interrupt: async (sessionId) => void f.interrupts.push(sessionId),
    lastAssistantText: () => 'I ran out of usage before finishing.',
    createWorkspace: async (_state, kind) => ({ kind, path: kind === 'worktree' ? '/wt/plan' : '/proj', branch: 'ladder/plan', base: 'base0' }),
    snapshot: async (cwd, ref) => (f.git && !(f.snapFails && ref.includes('side-now')) ? `sha:${cwd}:${ref.split('/').slice(-1)[0]}` : null),
    diffstat: async () => ({ added: 12, removed: 3, count: 2, files: ['src/auth.ts', 'src/auth.test.ts'] }),
    createSideWorktree: async () => ({ path: `/wt/side-${++f.sideCount}`, branch: `ladder/side-${f.sideCount}` }),
    applyChanges: async (workspace, side) => {
      f.applied.push({ workspace, side })
      return f.conflict ? { ok: false, error: 'conflicts in src/a.ts' } : { ok: true }
    },
    saveRef: async (_cwd, ref) => {
      if (f.saveFails) throw new Error('no space')
      f.refs.push(ref)
    },
    restoreOwn: async (_cwd, sha, sessionId, exclude) => void f.restores.push({ sha, sessionId, exclude }),
    removeSideWorktree: async (_projectId, path, branch, sessionIds) => void f.removedSides.push({ path, branch, sessionIds }),
    unsaved: async () => f.leftOut
  }
  f.runner = new PlanRunner(f.ports)
  return f
}

const task = (id: string, extra: object = {}) => ({ id, title: id, instruction: `Do ${id}`, kind: 'other', agent: 'claude-code', permission: 'plan', ...extra })

const done = (summary: string, extra: object = {}) => ({ status: 'done', summary, ...extra })

/** The task reports and ends its turn, as the agent does. */
async function finishTask(f: Fake, sessionId: string, result: object, end: { status: 'completed' | 'error' | 'interrupted'; error: string | null } = { status: 'completed', error: null }) {
  if (result) assert.equal(f.runner.reportResult(sessionId, result).ok, true)
  await f.runner.onTurnEnd(sessionId, end)
}

const runOf = (f: Fake, planId: string, taskId: string) => f.runner.get(planId)!.runs.find((r) => r.taskId === taskId)!

// ── Two agents, same plan ───────────────────────────────────────────────────

console.log('Same plan from Claude and from Codex')
await step('two equivalent plans produce identical objects', () => {
  // Claude: canonical order, explicit values.
  const claude = {
    goal: 'Add a 401 retry to the API client',
    constraints: ['Do not touch src/legacy/'],
    tasks: [
      { id: 'analysis', title: 'Analysis', instruction: 'Read the client and plan the change.', kind: 'plan', agent: 'claude-code', model: null, effort: null, permission: 'plan', after: [], doneWhen: null, onBlocking: null },
      { id: 'implement', title: 'Implement', instruction: 'Write the retry.', kind: 'implement', agent: 'codex', model: null, effort: 'high', permission: 'edit', after: ['analysis'], doneWhen: 'tests on 401 pass', onBlocking: null },
      { id: 'review-1', title: 'Review', instruction: 'Review the change.', kind: 'review', agent: 'claude-code', model: null, effort: null, permission: 'plan', after: ['implement'], doneWhen: null, onBlocking: { backTo: 'implement', max: 2 } }
    ],
    stopAfter: ['analysis']
  }
  // Codex: fields in another order, defaults omitted, whitespace, upper-case ids, duplicates, \r\n.
  const codex = {
    stopAfter: ['Analysis', 'analysis'],
    tasks: [
      { permission: 'plan', agent: 'claude-code', kind: 'plan', instruction: '  Read the client and plan the change.\r\n', title: ' Analysis ', id: 'Analysis' },
      { onBlocking: { backTo: 'implement' }, after: ['implement', 'implement'], agent: 'claude-code', kind: 'review', title: 'Review', instruction: 'Review the change.', id: 'Review 1' },
      { id: 'implement', title: 'Implement', instruction: 'Write the retry.', kind: 'implement', agent: 'codex', effort: 'high', after: ['ANALYSIS'], doneWhen: 'tests on 401 pass', model: null, permission: 'edit' }
    ].sort((a, b) => (a.id === 'implement' ? -1 : b.id === 'implement' ? 1 : 0)),
    goal: 'Add a 401 retry to the API client',
    constraints: ['Do not touch src/legacy/', 'Do not touch src/legacy/']
  }
  // The second one has the tasks in another order in the array: the task order belongs to the plan, so it is put back the same.
  codex.tasks = [codex.tasks.find((x) => x.id === 'Analysis')!, codex.tasks.find((x) => x.id === 'implement')!, codex.tasks.find((x) => x.id === 'Review 1')!]
  const a = validatePlan(claude, rules)
  const b = validatePlan(codex, rules)
  assert.ok(a.ok && b.ok, JSON.stringify(a.ok ? b : a))
  assert.deepStrictEqual(a.plan, b.plan)
  assert.equal(JSON.stringify(a.plan), JSON.stringify(b.plan), 'same serialization, same field order')
})

// ── Full flow ───────────────────────────────────────────────────────────────

console.log('Full flow: plan, stop point, failure, reassign, loop back, completed')
const f = fake({ LADDER_PLAN_FAIL: 'implement' })
let planId = ''
const proposal = await f.runner.propose('coord', 'p1', 'claude-code', {
  goal: 'Add a 401 retry to the API client',
  constraints: ['Do not touch src/legacy/'],
  tasks: [
    task('analysis', { title: 'Analysis', kind: 'plan' }),
    task('implement', { title: 'Implement', kind: 'implement', agent: 'codex', permission: 'edit', after: ['analysis'], doneWhen: 'tests on 401 pass' }),
    task('review-1', { title: 'Review', kind: 'review', after: ['implement'], onBlocking: { backTo: 'implement', max: 2 } })
  ],
  stopAfter: ['analysis']
})
assert.ok(proposal.ok)
planId = proposal.ok ? proposal.state.id : ''
const taskSend = (sessionId: string) => f.sends.filter((s) => s.sessionId === sessionId)

await step('the plan starts in review and the coordinator session waits for you', () => {
  const state = f.runner.get(planId)!
  assert.equal(state.status, 'review')
  assert.equal(state.revision, 1)
  assert.equal(state.author, 'claude-code')
  assert.ok(f.attentions.includes('waiting:review'))
})

await step('a second propose marks the first one in review as "superseded"', async () => {
  const other = await f.runner.propose('coord', 'p1', 'claude-code', { goal: 'x', tasks: [task('only')] })
  assert.ok(other.ok)
  assert.equal(f.runner.get(planId)!.status, 'superseded')
  // Start again from a new plan, identical to the first one.
  const again = await f.runner.propose('coord', 'p1', 'claude-code', {
    goal: 'Add a 401 retry to the API client',
    constraints: ['Do not touch src/legacy/'],
    tasks: [
      task('analysis', { title: 'Analysis', kind: 'plan' }),
      task('implement', { title: 'Implement', kind: 'implement', agent: 'codex', permission: 'edit', after: ['analysis'], doneWhen: 'tests on 401 pass' }),
      task('review-1', { title: 'Review', kind: 'review', after: ['implement'], onBlocking: { backTo: 'implement', max: 2 } })
    ],
    stopAfter: ['analysis']
  })
  assert.ok(again.ok)
  planId = again.ok ? again.state.id : ''
})

await step('propose with an unavailable agent is rejected with the list of errors', async () => {
  const bad = await f.runner.propose('coord', 'p1', 'claude-code', { goal: 'x', tasks: [task('a', { agent: 'acp:gemini' })] })
  assert.ok(!bad.ok)
  assert.match(bad.ok ? '' : bad.errors.join('\n'), /not available/)
})

await step('approve: plan folder and first task in its own session', async () => {
  await f.runner.approve(planId, 1, 'worktree')
  const state = f.runner.get(planId)!
  assert.equal(state.status, 'running')
  assert.equal(state.workspace?.path, '/wt/plan')
  const run = runOf(f, planId, 'analysis')
  assert.equal(run.status, 'running')
  assert.ok(run.sessionId)
  const spec = f.sessions.get(run.sessionId!)!
  assert.equal(spec.cwd, '/wt/plan')
  assert.deepEqual(spec.worktree, { path: '/wt/plan', branch: 'ladder/plan', base: 'base0' })
  assert.equal(spec.title, 'Analysis')
  assert.equal(spec.permission, 'plan')
  const prompt = taskSend(run.sessionId!)[0].text
  assert.match(prompt, /## Goal\nAdd a 401 retry/)
  assert.match(prompt, /Do not touch src\/legacy\//)
  assert.match(prompt, /- implement: Implement \(codex, edit access, after analysis\), status: pending/)
  assert.match(prompt, /steps, in order, and the acceptance criteria/)
  assert.match(prompt, /report_result/)
  assert.equal(runOf(f, planId, 'implement').status, 'pending')
  assert.ok(f.attentions.includes('resolved:running'))
})

const analysisSession = () => runOf(f, planId, 'analysis').sessionId!

await step('analysis completed: the stop point pauses the plan with [continue, stop]', async () => {
  await finishTask(f, analysisSession(), done('Plan: 1) wrap the client 2) retry on 401', { decisions: ['Retry once'] }))
  const state = f.runner.get(planId)!
  assert.equal(runOf(f, planId, 'analysis').status, 'completed')
  assert.equal(state.status, 'paused')
  assert.equal(state.pause?.reason, 'stop-point')
  assert.deepEqual(state.pause?.choices, ['continue', 'stop'])
  assert.equal(runOf(f, planId, 'implement').status, 'pending', 'nothing starts during the pause')
  assert.ok(f.attentions.includes('waiting:paused'))
})

await step('continue: implement (Codex) starts with the analysis result in the message', async () => {
  await f.runner.choose(planId, 'continue', undefined, undefined)
  const run = runOf(f, planId, 'implement')
  assert.equal(run.status, 'running')
  const spec = f.sessions.get(run.sessionId!)!
  assert.equal(spec.agent, 'codex')
  assert.equal(spec.permission, 'edit')
  const prompt = taskSend(run.sessionId!)[0].text
  assert.match(prompt, /Results of the tasks before yours/)
  assert.match(prompt, /Plan: 1\) wrap the client 2\) retry on 401/)
  assert.match(prompt, /Retry once/)
  assert.match(prompt, /Done when: tests on 401 pass/)
  assert.match(prompt, /Changes since the plan base: 2 files changed \(\+12 −3\)/)
})

const implementSession1 = () => runOf(f, planId, 'implement').sessionId!

await step('simulated failure (LADDER_PLAN_FAIL): task failed, plan paused with the right choices', async () => {
  const session = implementSession1()
  // The turn ends fine and reports, but the test hook turns it into a failed turn.
  await finishTask(f, session, done('Wrote the retry'))
  const run = runOf(f, planId, 'implement')
  const state = f.runner.get(planId)!
  assert.equal(run.status, 'failed')
  assert.equal(run.error, 'Simulated failure (LADDER_PLAN_FAIL)')
  assert.deepEqual(run.files, { added: 12, removed: 3, count: 2 })
  assert.equal(state.status, 'paused')
  assert.equal(state.pause?.reason, 'failed')
  assert.equal(state.pause?.taskId, 'implement')
  assert.deepEqual(state.pause?.choices, ['retry', 'reassign', 'skip', 'stop'])
  assert.equal(runOf(f, planId, 'review-1').status, 'pending')
})

await step('reassign to Claude keeping the work: new session, prompt with the partial work', async () => {
  const old = implementSession1()
  await f.runner.choose(planId, 'reassign', undefined, { agent: 'claude-code', model: null, effort: null, keepWork: true })
  const run = runOf(f, planId, 'implement')
  assert.equal(run.status, 'running')
  assert.equal(run.agent, 'claude-code')
  assert.equal(run.attempt, 2)
  assert.notEqual(run.sessionId, old)
  assert.equal(f.sessions.get(run.sessionId!)!.agent, 'claude-code')
  const prompt = taskSend(run.sessionId!)[0].text
  assert.match(prompt, /previous executor \(codex\) did not finish this task: Simulated failure/)
  assert.match(prompt, /you continue from them: 2 files changed/)
  assert.match(prompt, /I ran out of usage/)
  assert.equal(f.restores.length, 0, 'keepWork: the folder is left untouched')
  assert.equal(f.runner.isTaskSession(old), true, 'the old session is still a task session')
  assert.equal(f.runner.taskOf(old), null)
})

await step('review with a blocking issue: loops back to implement in the same session', async () => {
  const session = runOf(f, planId, 'implement').sessionId!
  await finishTask(f, session, done('Retry written, tests pass', { checks: [{ cmd: 'pnpm test', exit: 0, summary: 'green' }] }))
  const review = runOf(f, planId, 'review-1')
  assert.equal(review.status, 'running', 'the review starts as soon as the implementation is completed')
  const reviewSession = review.sessionId!
  const reviewPrompt = taskSend(reviewSession)[0].text
  assert.match(reviewPrompt, /read-only/)
  assert.match(reviewPrompt, /pnpm test/)
  const sessionsBefore = f.sessions.size
  await finishTask(f, reviewSession, done('One blocking problem', { issues: [{ severity: 'blocking', file: 'src/auth.ts', line: 42, text: 'Retry loop has no limit' }, { severity: 'minor', text: 'Rename a variable' }] }))
  const implement = runOf(f, planId, 'implement')
  assert.equal(implement.status, 'running')
  assert.equal(implement.iteration, 2)
  assert.equal(implement.sessionId, session, 'same session, same thread')
  assert.equal(f.sessions.size, sessionsBefore, 'no new session')
  const message = taskSend(session).at(-1)!.text
  assert.match(message, /round 1 of at most 2/)
  assert.match(message, /\[blocking\] src\/auth.ts:42 Retry loop has no limit/)
  assert.equal(runOf(f, planId, 'review-1').status, 'pending')
  assert.equal(runOf(f, planId, 'review-1').iteration, 2)
  assert.equal(f.runner.get(planId)!.status, 'running')
})

await step('review approved on the second round: plan completed', async () => {
  const session = runOf(f, planId, 'implement').sessionId!
  await finishTask(f, session, done('Added a retry limit'))
  const review = runOf(f, planId, 'review-1')
  assert.equal(review.status, 'running')
  assert.equal(review.iteration, 2)
  await finishTask(f, review.sessionId!, done('Looks good', { verdict: 'approved' }))
  const state = f.runner.get(planId)!
  assert.equal(runOf(f, planId, 'review-1').status, 'completed')
  assert.equal(state.status, 'completed')
  assert.ok(state.endedAt)
  assert.ok(f.attentions.includes('completed:completed'))
  assert.ok(f.notices.some((n) => n.startsWith('Plan completed: Add a 401 retry')))
})

// ── Other rules ────────────────────────────────────────────────────────────

console.log('Other runner rules')
const proposeAndApprove = async (g: Fake, input: object, kind: 'main' | 'worktree' = 'worktree') => {
  const p = await g.runner.propose('coord', 'p1', 'claude-code', input)
  assert.ok(p.ok, JSON.stringify(p))
  const id = p.ok ? p.state.id : ''
  await g.runner.approve(id, 1, kind)
  return id
}

await step('no result: a single automatic correction, then the task fails', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a')] })
  const session = g.runner.get(id)!.runs[0].sessionId!
  await g.runner.onTurnEnd(session, { status: 'completed', error: null })
  assert.equal(g.runner.get(id)!.runs[0].status, 'running')
  assert.match(g.sends.at(-1)!.text, /ended without a result/)
  const sent = g.sends.length
  await g.runner.onTurnEnd(session, { status: 'completed', error: null })
  assert.equal(g.sends.length, sent, 'no second correction')
  const state = g.runner.get(id)!
  assert.equal(state.runs[0].status, 'failed')
  assert.match(state.runs[0].error!, /without reporting a result/)
  assert.equal(state.status, 'paused')
})

await step('writing in the session of a failed task puts it back in progress and clears the pause', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a')] })
  const session = g.runner.get(id)!.runs[0].sessionId!
  await g.runner.onTurnEnd(session, { status: 'error', error: 'Usage limit reached' })
  assert.equal(g.runner.get(id)!.runs[0].error, 'Usage limit reached')
  assert.equal(g.runner.get(id)!.status, 'paused')
  await g.runner.userWrote(session)
  assert.equal(g.runner.get(id)!.runs[0].status, 'running')
  assert.equal(g.runner.get(id)!.status, 'running')
  assert.equal(g.runner.get(id)!.pause, null)
  await finishTask(g, session, done('ok'))
  assert.equal(g.runner.get(id)!.status, 'completed')
})

await step('interruption: task interrupted, same choices; skip: counts as done for the following tasks', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a'), task('b', { after: ['a'] })] })
  await g.runner.onTurnEnd(g.runner.get(id)!.runs[0].sessionId!, { status: 'interrupted', error: null })
  assert.equal(g.runner.get(id)!.pause?.reason, 'interrupted')
  await g.runner.choose(id, 'skip', undefined, undefined)
  const state = g.runner.get(id)!
  assert.equal(state.runs[0].status, 'skipped')
  assert.equal(state.runs[1].status, 'running')
  assert.match(g.sends.at(-1)!.text, /Skipped by the user: this task did NOT run/)
})

await step('retry in the same session with a message summarizing what happened', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a', { kind: 'implement', permission: 'edit' })] })
  const session = g.runner.get(id)!.runs[0].sessionId!
  await g.runner.onTurnEnd(session, { status: 'error', error: 'Usage limit reached' })
  await g.runner.choose(id, 'retry', undefined, undefined)
  const run = g.runner.get(id)!.runs[0]
  assert.equal(run.sessionId, session)
  assert.equal(run.attempt, 2)
  assert.equal(run.status, 'running')
  assert.match(g.sends.at(-1)!.text, /previous attempt at this task did not finish: Usage limit reached/)
})

await step('reassign without keeping the work: partial work saved in a ref and folder restored to the start', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a', { kind: 'implement', permission: 'edit' })] })
  const session = g.runner.get(id)!.runs[0].sessionId!
  await g.runner.onTurnEnd(session, { status: 'error', error: 'boom' })
  await g.runner.choose(id, 'reassign', undefined, { agent: 'codex', model: null, effort: null, keepWork: false })
  assert.equal(g.refs.length, 1)
  assert.match(g.refs[0], new RegExp(`^refs/ladder/plan/${id}/a-partial$`))
  assert.equal(g.restores.length, 1)
  assert.match(g.restores[0].sha, /-1-start$/)
  assert.equal(g.restores[0].sessionId, session, 'the changes of the old session are undone')
  assert.match(g.sends.at(-1)!.text, /restored to how it was when the task started/)
})

await step('reassign to a disallowed agent: error and nothing changes', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a')] })
  await g.runner.onTurnEnd(g.runner.get(id)!.runs[0].sessionId!, { status: 'error', error: 'boom' })
  await assert.rejects(g.runner.choose(id, 'reassign', undefined, { agent: 'acp:gemini', model: null, effort: null, keepWork: true }), /not available/)
  assert.equal(g.runner.get(id)!.runs[0].status, 'failed')
})

await step('loop-backs exhausted: the review stops with [continue, stop]; continue accepts it', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, {
    goal: 'g',
    tasks: [task('w', { kind: 'implement', permission: 'edit' }), task('r', { kind: 'review', after: ['w'], onBlocking: { backTo: 'w', max: 1 } })]
  })
  const blocking = { issues: [{ severity: 'blocking', text: 'bad' }] }
  await finishTask(g, runOf(g, id, 'w').sessionId!, done('v1'))
  await finishTask(g, runOf(g, id, 'r').sessionId!, done('no', blocking))
  assert.equal(runOf(g, id, 'w').iteration, 2)
  await finishTask(g, runOf(g, id, 'w').sessionId!, done('v2'))
  await finishTask(g, runOf(g, id, 'r').sessionId!, done('still no', blocking))
  const state = g.runner.get(id)!
  assert.equal(state.pause?.reason, 'loops-exhausted')
  assert.deepEqual(state.pause?.choices, ['continue', 'stop'])
  await g.runner.choose(id, 'continue', undefined, undefined)
  assert.equal(g.runner.get(id)!.status, 'completed')
})

await step('concurrency: a single writer in the plan folder; the second in a separate worktree, readers queued', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, {
    goal: 'g',
    tasks: [
      task('w1', { kind: 'implement', permission: 'edit' }),
      task('w2', { kind: 'implement', permission: 'edit' }),
      task('r1', { kind: 'review', permission: 'plan' })
    ]
  })
  const w1 = runOf(g, id, 'w1')
  const w2 = runOf(g, id, 'w2')
  const r1 = runOf(g, id, 'r1')
  assert.equal(w1.cwd, '/wt/plan')
  assert.equal(w1.worktree, null)
  assert.equal(w2.status, 'running')
  assert.equal(w2.worktree, '/wt/side-1')
  assert.equal(g.sessions.get(w2.sessionId!)!.cwd, '/wt/side-1')
  assert.equal(g.sessions.get(w2.sessionId!)!.worktree?.branch, 'ladder/side-1', 'the session carries the branch of the separate worktree')
  assert.equal(r1.status, 'queued')
  assert.equal(r1.queuedBehind, 'w1')
  // The second writer finishes: its changes go back into the plan folder.
  await finishTask(g, w2.sessionId!, done('w2 done'))
  assert.deepEqual(g.applied, [{ workspace: '/wt/plan', side: '/wt/side-1' }])
  assert.deepEqual(g.removedSides, [{ path: '/wt/side-1', branch: 'ladder/side-1', sessionIds: [w2.sessionId!] }], 'the separate worktree is removed after the merge, together with its session')
  assert.equal(runOf(g, id, 'w2').status, 'completed')
  // The first one finishes: the queued reader starts.
  await finishTask(g, w1.sessionId!, done('w1 done'))
  assert.equal(runOf(g, id, 'r1').status, 'running')
  assert.equal(runOf(g, id, 'r1').queuedBehind, null)
})

await step('conflict applying the changes of a separate worktree: task failed, plan paused', async () => {
  const g = fake()
  g.conflict = true
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('w1', { kind: 'implement', permission: 'edit' }), task('w2', { kind: 'implement', permission: 'edit' })] })
  await finishTask(g, runOf(g, id, 'w2').sessionId!, done('w2 done'))
  const run = runOf(g, id, 'w2')
  assert.equal(run.status, 'failed')
  assert.match(run.error!, /conflict with the plan folder and were not applied: conflicts in src\/a.ts/)
  assert.equal(g.runner.get(id)!.status, 'paused')
})

await step('agent edit to a running plan: only tasks not yet started; executor or new tasks ask for confirmation', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a'), task('b', { after: ['a'], agent: 'claude-code' })] })
  const plan = structuredClone(g.runner.get(id)!.plan)
  // Changing a task that already started: error for the agent.
  const bad = structuredClone(plan)
  bad.tasks[0].title = 'changed'
  const refused = await g.runner.revise('coord', id, bad, 'because')
  assert.equal(refused.ok, false)
  assert.match(refused.text, /Task "a" is running/)
  // Changing only the instructions of a pending task: applied right away.
  const soft = structuredClone(plan)
  soft.tasks[1].instruction = 'Do b differently'
  assert.equal((await g.runner.revise('coord', id, soft, 'better')).ok, true)
  assert.equal(g.runner.get(id)!.revision, 2)
  assert.equal(g.runner.get(id)!.plan.tasks[1].instruction, 'Do b differently')
  assert.equal(g.runner.get(id)!.pendingUpdate, null)
  // Changing the executor: needs confirmation and the plan pauses.
  const hard = structuredClone(g.runner.get(id)!.plan)
  hard.tasks[1].agent = 'codex'
  const answer = await g.runner.revise('coord', id, hard, 'codex is better here')
  assert.equal(answer.ok, true)
  assert.match(answer.text, /needs the user to confirm/)
  const state = g.runner.get(id)!
  assert.equal(state.status, 'paused')
  assert.equal(state.pause?.reason, 'confirm-update')
  assert.equal(state.plan.tasks[1].agent, 'claude-code', 'the plan stays as it was until you confirm')
  await g.runner.confirmUpdate(id, true)
  assert.equal(g.runner.get(id)!.plan.tasks[1].agent, 'codex')
  assert.equal(g.runner.get(id)!.status, 'running')
  assert.match(g.told.at(-1)!, /accepted your plan change/)
})

await step('plan.stop interrupts running turns; reject with a message forwards it to the coordinator', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a'), task('b')] })
  const sessions = g.runner.get(id)!.runs.map((r) => r.sessionId!)
  await g.runner.stop(id)
  assert.equal(g.runner.get(id)!.status, 'stopped')
  assert.deepEqual(g.interrupts.sort(), sessions.sort())
  // An interrupted turn that arrives after the stop changes nothing.
  await g.runner.onTurnEnd(sessions[0], { status: 'interrupted', error: null })
  assert.equal(g.runner.get(id)!.status, 'stopped')
  const review = await g.runner.propose('coord', 'p1', 'claude-code', { goal: 'g2', tasks: [task('a')] })
  assert.ok(review.ok)
  await g.runner.reject(review.ok ? review.state.id : '', 'redo it without the review')
  assert.equal(g.told.at(-1), 'redo it without the review')
})

await step('Ladder restart: running tasks are marked interrupted, "restart" pause, none resumes by itself', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a', { kind: 'implement', permission: 'edit' }), task('b', { after: ['a'] })] })
  const saved = g.saved.get(id)!
  const h = fake()
  h.runner.load([structuredClone(saved)])
  await h.runner.recover()
  const state = h.runner.get(id)!
  assert.equal(state.runs[0].status, 'interrupted')
  assert.equal(state.status, 'paused')
  assert.equal(state.pause?.reason, 'restart')
  assert.equal(h.sessions.size, 0, 'no new session')
  assert.equal(h.sends.length, 0)
})

await step('report_result: rejected if the result is invalid or the task is not running', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a')] })
  const session = g.runner.get(id)!.runs[0].sessionId!
  const invalid = g.runner.reportResult(session, { status: 'nope' })
  assert.equal(invalid.ok, false)
  assert.match(invalid.text, /status: must be/)
  assert.equal(g.runner.reportResult('nobody', done('x')).ok, false)
  await finishTask(g, session, done('ok'))
  assert.equal(g.runner.reportResult(session, done('late')).ok, false)
})

// ── Edge cases ──────────────────────────────────────────────────────────────

console.log('Edge cases')

await step('loop back on a task born in a separate worktree: new session in the chosen folder, with the issues in the message', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, {
    goal: 'g',
    tasks: [
      task('w1', { kind: 'implement', permission: 'edit' }),
      task('w2', { kind: 'implement', permission: 'edit' }),
      task('r', { kind: 'review', after: ['w2'], onBlocking: { backTo: 'w2', max: 2 } })
    ]
  })
  const oldSession = runOf(g, id, 'w2').sessionId!
  assert.equal(runOf(g, id, 'w2').cwd, '/wt/side-1')
  await finishTask(g, oldSession, done('w2 done'))
  await finishTask(g, runOf(g, id, 'w1').sessionId!, done('w1 done'))
  await finishTask(g, runOf(g, id, 'r').sessionId!, done('bad', { issues: [{ severity: 'blocking', text: 'Missing null check' }] }))
  const run = runOf(g, id, 'w2')
  assert.equal(run.status, 'running')
  assert.equal(run.cwd, '/wt/plan', 'the plan folder is free now')
  assert.notEqual(run.sessionId, oldSession)
  assert.equal(g.sessions.get(run.sessionId!)!.cwd, '/wt/plan')
  assert.equal(g.runner.isTaskSession(oldSession), true)
  assert.equal(g.runner.taskOf(oldSession), null)
  assert.deepEqual(g.runner.taskRef(oldSession), { planId: id, taskId: 'w2' })
  const message = g.sends.filter((x) => x.sessionId === run.sessionId).at(-1)!.text
  assert.match(message, /Fix these issues first/)
  assert.match(message, /Missing null check/)
  assert.match(message, /## Goal/)
})

await step('loop back with a downstream parallel branch still running: it is stopped and redone only after its turn ends', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, {
    goal: 'g',
    tasks: [
      task('w', { kind: 'implement', permission: 'edit' }),
      task('r', { kind: 'review', after: ['w'], onBlocking: { backTo: 'w', max: 2 } }),
      task('d', { after: ['w'] })
    ]
  })
  await finishTask(g, runOf(g, id, 'w').sessionId!, done('v1'))
  const dSession = runOf(g, id, 'd').sessionId!
  assert.equal(runOf(g, id, 'd').status, 'running')
  await finishTask(g, runOf(g, id, 'r').sessionId!, done('no', { issues: [{ severity: 'blocking', text: 'bad' }] }))
  assert.deepEqual(g.interrupts, [dSession])
  assert.equal(runOf(g, id, 'w').status, 'completed', 'nothing is redone until d has ended its turn')
  assert.equal(runOf(g, id, 'w').iteration, 1)
  assert.equal(g.runner.get(id)!.status, 'running', 'a branch stopped on purpose is not a pause')
  await g.runner.onTurnEnd(dSession, { status: 'interrupted', error: null })
  assert.equal(runOf(g, id, 'w').status, 'running')
  assert.equal(runOf(g, id, 'w').iteration, 2)
  assert.equal(runOf(g, id, 'd').status, 'pending')
  assert.equal(runOf(g, id, 'd').iteration, 2)
  // A pending task removed from the plan retires its session: it does not become a coordinator.
  const rSession = runOf(g, id, 'r').sessionId!
  const plan = structuredClone(g.runner.get(id)!.plan)
  plan.tasks = plan.tasks.filter((x) => x.id !== 'r')
  const answer = await g.runner.revise('coord', id, plan, 'drop the review')
  assert.equal(answer.ok, true, answer.text)
  assert.equal(g.runner.isTaskSession(rSession), true)
})

await step('archiving the session of a running task: the task fails and the plan pauses to ask', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a')] })
  await g.runner.sessionGone(g.runner.get(id)!.runs[0].sessionId!)
  const state = g.runner.get(id)!
  assert.equal(state.runs[0].status, 'failed')
  assert.equal(state.runs[0].error, 'The task session was archived.')
  assert.equal(state.pause?.reason, 'failed')
})

await step('a new plan does not replace one whose approval is in progress', async () => {
  const g = fake()
  const p = await g.runner.propose('coord', 'p1', 'claude-code', { goal: 'g', tasks: [task('a')] })
  assert.ok(p.ok)
  const id = p.ok ? p.state.id : ''
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const create = g.ports.createWorkspace
  g.ports.createWorkspace = async (state, kind) => (await gate, create(state, kind))
  const approving = g.runner.approve(id, 1, 'worktree')
  const proposing = g.runner.propose('coord', 'p1', 'claude-code', { goal: 'g2', tasks: [task('b')] })
  await new Promise((resolve) => setTimeout(resolve, 20))
  release()
  await approving
  await proposing
  assert.equal(g.runner.get(id)!.status, 'running', 'the approved plan did not become "superseded"')
})

await step('reassign without keeping the work: files brought by other tasks are not undone', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, {
    goal: 'g',
    tasks: [task('w1', { kind: 'implement', permission: 'edit' }), task('w2', { kind: 'implement', permission: 'edit' })]
  })
  const w1 = runOf(g, id, 'w1').sessionId!
  await finishTask(g, runOf(g, id, 'w2').sessionId!, done('w2 done'))
  await g.runner.onTurnEnd(w1, { status: 'error', error: 'boom' })
  await g.runner.choose(id, 'reassign', undefined, { agent: 'codex', model: null, effort: null, keepWork: false })
  assert.equal(g.restores.length, 1)
  assert.equal(g.restores[0].sessionId, w1)
  assert.deepEqual(g.restores[0].exclude, ['src/auth.ts', 'src/auth.test.ts'], 'the files brought by w2 stay')
  assert.equal(g.refs.length, 1, 'the partial work stays saved')
})

await step('revise_plan in review after your edit: rejected with the current plan; your constraints stay', async () => {
  const g = fake()
  const p = await g.runner.propose('coord', 'p1', 'claude-code', { goal: 'g', constraints: ['agent rule'], tasks: [task('a')] })
  assert.ok(p.ok)
  const id = p.ok ? p.state.id : ''
  const edited = structuredClone(g.runner.get(id)!.plan)
  edited.constraints.push({ text: 'my rule', by: 'user' })
  await g.runner.edit(id, 1, edited)
  const stale = await g.runner.revise('coord', id, { goal: 'g', constraints: ['agent rule'], tasks: [task('a'), task('b')] }, 'more')
  assert.equal(stale.ok, false)
  assert.match(stale.text, /edited the plan since your last version/)
  assert.match(stale.text, /my rule/)
  const fresh = await g.runner.revise('coord', id, { goal: 'g', constraints: ['agent rule'], tasks: [task('a'), task('b')] }, 'more')
  assert.equal(fresh.ok, true, 'after receiving the current plan the agent can revise')
  assert.equal(g.runner.get(id)!.plan.tasks.length, 2)
  assert.equal(g.runner.get(id)!.plan.constraints.some((c) => c.text === 'my rule' && c.by === 'user'), true, 'constraints written by you are not lost')
})

await step('rejection with a message that does not reach the coordinator: the plan is stopped anyway, without error', async () => {
  const g = fake()
  const p = await g.runner.propose('coord', 'p1', 'claude-code', { goal: 'g', tasks: [task('a')] })
  assert.ok(p.ok)
  g.ports.tellAgent = async () => {
    throw new Error('session archived')
  }
  const state = await g.runner.reject(p.ok ? p.state.id : '', 'redo')
  assert.equal(state.status, 'stopped')
})

// ── More edge cases ─────────────────────────────────────────────────────────

console.log('More edge cases')

await step('executor or permission change confirmed after a loop back: the old session is retired and a new one is created', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, {
    goal: 'g',
    tasks: [task('x'), task('w', { kind: 'implement', permission: 'edit' }), task('r', { kind: 'review', after: ['w'], onBlocking: { backTo: 'w', max: 3 } })]
  })
  await finishTask(g, runOf(g, id, 'w').sessionId!, done('v1'))
  const oldSession = runOf(g, id, 'w').sessionId!
  await g.runner.onTurnEnd(runOf(g, id, 'x').sessionId!, { status: 'error', error: 'boom' })
  await finishTask(g, runOf(g, id, 'r').sessionId!, done('no', { issues: [{ severity: 'blocking', text: 'bad' }] }))
  assert.equal(runOf(g, id, 'w').status, 'pending', 'held: the plan is paused for x')
  const plan = structuredClone(g.runner.get(id)!.plan)
  const wTask = plan.tasks.find((x) => x.id === 'w')!
  wTask.permission = 'plan'
  wTask.agent = 'codex'
  const answer = await g.runner.revise('coord', id, plan, 'read-only now')
  assert.equal(answer.ok, true, answer.text)
  await g.runner.confirmUpdate(id, true)
  assert.equal(runOf(g, id, 'w').sessionId, null)
  assert.equal(g.runner.taskOf(oldSession), null)
  await g.runner.choose(id, 'skip', 'x', undefined)
  const run = runOf(g, id, 'w')
  assert.equal(run.status, 'running')
  assert.notEqual(run.sessionId, oldSession)
  const spec = g.sessions.get(run.sessionId!)!
  assert.equal(spec.permission, 'plan')
  assert.equal(spec.agent, 'codex')
  const prompt = g.sends.filter((m) => m.sessionId === run.sessionId).at(-1)!.text
  assert.match(prompt, /## Goal/, 'full message, not the loop-back message of the old session')
  assert.ok(!prompt.includes('—'), 'no em dashes in messages the user sees')
})

await step('restart in the middle of a deferred loop back: the review issues are not lost', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, {
    goal: 'g',
    tasks: [task('w', { kind: 'implement', permission: 'edit' }), task('r', { kind: 'review', after: ['w'], onBlocking: { backTo: 'w', max: 2 } }), task('d', { after: ['w'] })]
  })
  await finishTask(g, runOf(g, id, 'w').sessionId!, done('v1'))
  await finishTask(g, runOf(g, id, 'r').sessionId!, done('no', { issues: [{ severity: 'blocking', text: 'Unbounded retry' }] }))
  assert.equal(runOf(g, id, 'w').iteration, 1, 'loop back still deferred')
  const h = fake()
  h.runner.load([structuredClone(g.saved.get(id)!)])
  await h.runner.recover()
  const w = h.runner.get(id)!.runs.find((r) => r.taskId === 'w')!
  assert.equal(w.iteration, 2)
  assert.equal(w.status, 'running')
  const message = h.sends.filter((m) => m.sessionId === w.sessionId).at(-1)!.text
  assert.match(message, /Unbounded retry/)
  assert.equal(h.runner.get(id)!.runs.find((r) => r.taskId === 'd')!.status, 'pending')
})

await step('separate worktree: skipping, stopping or redoing in another folder removes it and saves the unapplied work', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('w1', { kind: 'implement', permission: 'edit' }), task('w2', { kind: 'implement', permission: 'edit' })] })
  const w2 = runOf(g, id, 'w2')
  await g.runner.onTurnEnd(w2.sessionId!, { status: 'error', error: 'boom' })
  await g.runner.choose(id, 'skip', 'w2', undefined)
  assert.deepEqual(g.removedSides, [{ path: '/wt/side-1', branch: 'ladder/side-1', sessionIds: [w2.sessionId!] }])
  assert.ok(g.refs.some((ref) => ref.endsWith('/w2-side-partial')), 'the unapplied work is kept in a ref')
  assert.ok(g.notices.some((n) => /unapplied work of “w2” was saved in the git ref/.test(n)))
  // Stop with another separate worktree still running.
  const h = fake()
  const id2 = await proposeAndApprove(h, { goal: 'g', tasks: [task('w1', { kind: 'implement', permission: 'edit' }), task('w2', { kind: 'implement', permission: 'edit' })] })
  await h.runner.stop(id2)
  assert.equal(h.removedSides.length, 1)
  assert.equal(h.removedSides[0].path, '/wt/side-1')
})

await step('the plan folder and separate worktrees count as "in use" until the plan ends', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('w1', { kind: 'implement', permission: 'edit' }), task('w2', { kind: 'implement', permission: 'edit' })] })
  assert.equal(g.runner.usesFolder('/wt/plan'), true)
  assert.equal(g.runner.usesFolder('/wt/side-1'), true)
  assert.equal(g.runner.usesFolder('/elsewhere'), false)
  await g.runner.stop(id)
  assert.equal(g.runner.usesFolder('/wt/plan'), false)
})

await step('session archived midway: "Retry" creates a new session with the full message', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a')] })
  const old = g.runner.get(id)!.runs[0].sessionId!
  await g.runner.sessionGone(old)
  assert.equal(g.runner.get(id)!.runs[0].sessionId, null)
  assert.equal(g.runner.isTaskSession(old), true)
  await g.runner.choose(id, 'retry', undefined, undefined)
  const run = g.runner.get(id)!.runs[0]
  assert.equal(run.status, 'running')
  assert.notEqual(run.sessionId, old)
  assert.match(g.sends.filter((m) => m.sessionId === run.sessionId).at(-1)!.text, /## Goal/)
})

await step('loop back on a task that never had a session: full message with the issues', async () => {
  const g = fake()
  const create = g.ports.createSession
  let first = true
  g.ports.createSession = async (spec) => {
    if (first && spec.taskId === 'w') {
      first = false
      throw new Error('cannot start')
    }
    return create(spec)
  }
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('w', { kind: 'implement', permission: 'edit' }), task('r', { kind: 'review', after: ['w'], onBlocking: { backTo: 'w', max: 2 } })] })
  assert.equal(runOf(g, id, 'w').status, 'failed')
  assert.equal(runOf(g, id, 'w').sessionId, null)
  await g.runner.choose(id, 'skip', undefined, undefined)
  await finishTask(g, runOf(g, id, 'r').sessionId!, done('no', { issues: [{ severity: 'blocking', text: 'Needs the change' }] }))
  const run = runOf(g, id, 'w')
  assert.equal(run.status, 'running')
  const prompt = g.sends.filter((m) => m.sessionId === run.sessionId).at(-1)!.text
  assert.match(prompt, /## Your task/)
  assert.match(prompt, /Needs the change/)
})

await step('plan.choose honors the offered choices: no retry on a review with loop-backs exhausted', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('w', { kind: 'implement', permission: 'edit' }), task('r', { kind: 'review', after: ['w'], onBlocking: { backTo: 'w', max: 1 } })] })
  const blocking = { issues: [{ severity: 'blocking', text: 'bad' }] }
  await finishTask(g, runOf(g, id, 'w').sessionId!, done('v1'))
  await finishTask(g, runOf(g, id, 'r').sessionId!, done('no', blocking))
  await finishTask(g, runOf(g, id, 'w').sessionId!, done('v2'))
  await finishTask(g, runOf(g, id, 'r').sessionId!, done('no again', blocking))
  assert.equal(g.runner.get(id)!.pause?.reason, 'loops-exhausted')
  await assert.rejects(g.runner.choose(id, 'retry', 'r', undefined), /not available/)
  await assert.rejects(g.runner.choose(id, 'skip', 'r', undefined), /not available/)
  assert.equal(runOf(g, id, 'r').status, 'blocked')
})

await step('the plan controls a session only while the task is running', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a')] })
  const session = g.runner.get(id)!.runs[0].sessionId!
  assert.equal(g.runner.controls(session), true)
  await finishTask(g, session, done('ok'))
  assert.equal(g.runner.controls(session), false, 'task finished: the session notifies like a normal one')
})

// ── Worktree cleanup ────────────────────────────────────────────────────────

console.log('Worktree cleanup')

await step('discarded separate worktree: removed only if the work is fully saved', async () => {
  const two = { goal: 'g', tasks: [task('w1', { kind: 'implement', permission: 'edit' }), task('w2', { kind: 'implement', permission: 'edit' })] }
  const skipSide = async (g: Fake) => {
    const id = await proposeAndApprove(g, two)
    await g.runner.onTurnEnd(runOf(g, id, 'w2').sessionId!, { status: 'error', error: 'boom' })
    await g.runner.choose(id, 'skip', 'w2', undefined)
  }
  // Snapshot failed: no ref, the folder stays and the coordinator is told.
  const a = fake()
  a.snapFails = true
  await skipSide(a)
  assert.equal(a.removedSides.length, 0)
  assert.ok(a.notices.some((n) => /could not be fully saved, so its worktree stays on disk in \/wt\/side-1/.test(n)))
  // Untracked files left out of the snapshot (too large): ref saved, but the folder stays.
  const b = fake()
  b.leftOut = ['big.bin']
  await skipSide(b)
  assert.ok(b.refs.some((r) => r.endsWith('/w2-side-partial')))
  assert.equal(b.removedSides.length, 0)
  // Cannot check the files left out, or ref not saved: the folder stays.
  const c = fake()
  c.leftOut = null
  await skipSide(c)
  assert.equal(c.removedSides.length, 0)
  const d = fake()
  d.saveFails = true
  await skipSide(d)
  assert.equal(d.removedSides.length, 0)
  // Everything saved: it is removed.
  const e = fake()
  await skipSide(e)
  assert.equal(e.removedSides.length, 1)
})

await step('archived session of a task that is not running: retired, and "Retry" creates a new session', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('a'), task('b', { after: ['a'] })] })
  const old = g.runner.get(id)!.runs[0].sessionId!
  await g.runner.onTurnEnd(old, { status: 'error', error: 'Usage limit reached' })
  assert.equal(runOf(g, id, 'a').status, 'failed')
  await g.runner.sessionGone(old)
  const run = runOf(g, id, 'a')
  assert.equal(run.sessionId, null)
  assert.equal(run.status, 'failed', 'it was not running: stays as it was')
  assert.equal(run.error, 'Usage limit reached')
  await g.runner.choose(id, 'retry', undefined, undefined)
  assert.notEqual(runOf(g, id, 'a').sessionId, old)
  // Also a completed task: the archived session is not reused in a loop back.
  await finishTask(g, runOf(g, id, 'a').sessionId!, done('ok'))
  const done_ = runOf(g, id, 'a').sessionId!
  await g.runner.sessionGone(done_)
  assert.equal(runOf(g, id, 'a').sessionId, null)
  assert.equal(runOf(g, id, 'a').status, 'completed')
})

await step('after the merge the worktree entries are already gone when it is archived, and retired sessions in that folder are archived with it', async () => {
  const g = fake()
  const id = await proposeAndApprove(g, { goal: 'g', tasks: [task('w1', { kind: 'implement', permission: 'edit' }), task('w2', { kind: 'implement', permission: 'edit' })] })
  const first = runOf(g, id, 'w2').sessionId!
  await g.runner.onTurnEnd(first, { status: 'error', error: 'boom' })
  await g.runner.choose(id, 'reassign', 'w2', { agent: 'codex', model: null, effort: null, keepWork: true })
  const second = runOf(g, id, 'w2').sessionId!
  assert.notEqual(first, second)
  let usedAtRemoval: boolean | null = null
  g.ports.removeSideWorktree = async (_p, path, branch, sessionIds) => {
    usedAtRemoval = g.runner.usesFolder(path)
    g.removedSides.push({ path, branch, sessionIds })
  }
  await finishTask(g, second, done('w2 done'))
  assert.equal(usedAtRemoval, false, 'the worktree is no longer in use when the removal starts')
  assert.deepEqual(g.removedSides[0].sessionIds.sort(), [first, second].sort())
})

// ── Real git: merging the changes of a separate worktree ────────────────────

console.log('Real git · applySideChanges')
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
const tmp = mkdtempSync(join(tmpdir(), 'ladder-plan-test-'))
try {
  const ws = join(tmp, 'ws')
  const side = join(tmp, 'side')
  execFileSync('git', ['init', '-q', '-b', 'main', ws])
  const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join('\n') + '\n'
  writeFileSync(join(ws, 'a.txt'), lines(1, 20))
  writeFileSync(join(ws, 'b.txt'), 'b\n')
  git(ws, 'add', '-A')
  git(ws, 'commit', '-q', '-m', 'base')
  const base = git(ws, 'rev-parse', 'HEAD')
  git(ws, 'worktree', 'add', '-q', '-b', 'side', side, base)
  // The task in the separate worktree: a line at the top of a.txt, a new file and a blank line with spaces at the end of b.txt.
  writeFileSync(join(side, 'a.txt'), 'side top\n' + lines(1, 20))
  writeFileSync(join(side, 'new.txt'), 'new\n')
  writeFileSync(join(side, 'b.txt'), 'b\n\n  \n')
  git(side, 'add', '-A')
  git(side, 'commit', '-q', '-m', 'side')
  const end = git(side, 'rev-parse', 'HEAD')

  await step('non-conflicting changes: merged with the uncommitted ones in the folder, without touching the index', async () => {
    // In the plan folder another task changed the end of a.txt (uncommitted).
    writeFileSync(join(ws, 'a.txt'), lines(1, 20) + 'workspace bottom\n')
    const current = git(ws, 'stash', 'create')
    assert.match(current, /^[0-9a-f]{40}/)
    const result = await applySideChanges(ws, current, base, end)
    assert.deepEqual(result, { ok: true })
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'side top\n' + lines(1, 20) + 'workspace bottom\n')
    assert.equal(readFileSync(join(ws, 'new.txt'), 'utf8'), 'new\n')
    assert.equal(readFileSync(join(ws, 'b.txt'), 'utf8'), 'b\n\n  \n')
    assert.equal(git(ws, 'diff', '--cached', '--name-only'), '', 'nothing ended up in the index')
  })

  await step('same lines changed differently: conflict, folder untouched', async () => {
    git(ws, 'checkout', '-q', '--', '.')
    rmSync(join(ws, 'new.txt'))
    // The separate worktree changes "line 10" one way, the plan folder another.
    writeFileSync(join(side, 'a.txt'), lines(1, 9) + 'side ten\n' + lines(11, 20))
    git(side, 'commit', '-q', '-am', 'side 2')
    const end2 = git(side, 'rev-parse', 'HEAD')
    writeFileSync(join(ws, 'a.txt'), lines(1, 9) + 'workspace ten\n' + lines(11, 20))
    const before = readFileSync(join(ws, 'a.txt'), 'utf8')
    const current = git(ws, 'stash', 'create')
    const result = await applySideChanges(ws, current, base, end2)
    assert.equal(result.ok, false)
    assert.deepEqual(result.ok ? [] : result.conflicts, ['a.txt'])
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), before, 'the folder stays as it was')
  })
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${passed} tests passed`)
