// Plan runner: decides which tasks start, where, and what happens when they finish, fail or loop back.
// This is the core, with no Electron, SQLite or git: everything that touches the outside world goes through `RunnerPorts` (plans.ts
// implements them with the host; scripts/plan-runner.test.mts with an in-memory fake). That is why it uses no path aliases (`@shared/`)
// and user-facing strings go through `ports.t`, the host's `t()`.
//
// Rules that hold everything together:
// - Every operation on a plan goes through `exclusive`: one at a time, in arrival order.
// - The pause (`PlanState.pause`) is never assigned by hand: it is derived from the state (`derivePause`). A failed, blocked or
//   interrupted task, a stop point not yet confirmed or an agent edit to confirm stops the plan; while there is a pause no new
//   task starts, the running ones finish.
// - A writer has the plan folder to itself; a second writer running in parallel works in a separate worktree and its
//   changes return to the plan folder at the end.
import { downstreamOf, taskWrites, validatePlan, validateResult } from '../shared/plan.ts'
import type { Plan, PlanChoice, PlanPause, PlanRules, PlanState, PlanTask, PlanTaskRun, TaskResult } from '../shared/plan'
import type { AgentId, Effort, PermissionLevel } from '../shared/protocol'
import { composePrompt, correctionPrompt, type PromptMode, type PromptStat } from './plan-prompt.ts'

export type Tr = (text: string, vars?: Record<string, string | number>) => string

/** Data to create the session of a task (Host.createTaskSession). */
export interface TaskSessionSpec {
  projectId: string
  planId: string
  taskId: string
  title: string
  agent: AgentId
  model: string | null
  effort: Effort | null
  permission: PermissionLevel
  cwd: string
  /** The worktree containing the folder, if the folder is not the main checkout. */
  worktree: { path: string; branch: string; base: string } | null
}

/** How a task's turn ends, as seen by the host. */
export interface TurnEnd {
  status: 'completed' | 'error' | 'interrupted'
  error: string | null
}

/** Data the runner needs that does not live in `PlanState`; saved together with it. */
export interface PlanMeta {
  /** Checkpoint at the start of the task (current round), per task. */
  starts: Record<string, string>
  /** For tasks in a separate worktree: the checkpoint of the plan folder it branched from. */
  sideBase: Record<string, string>
  /** Stop points already confirmed: `task:round`. */
  acked: string[]
  /** Automatic corrections already sent: `task:round:attempt`. */
  corrected: string[]
  /** Sessions that used to belong to a task and no longer do (reassigned): they keep the task role. */
  retired: string[]
  /** Retired session → task it was running (for the banner in its chat). */
  retiredOf: Record<string, string>
  /** Folder in which a task's session was created: a restart reuses it only if the chosen folder is the same. */
  sessionCwd: Record<string, string>
  /** Branch of a task's separate worktree. */
  sideBranch: Record<string, string>
  /** Plan revision at the agent's last proposal: if lower, you edited the card in the meantime. */
  agentRevision: number | null
  /** Tasks interrupted by Ladder being closed ('restart' pause). */
  restart: string[]
  /** When the task's last round started. */
  startAt: Record<string, number>
  /** Files brought into the plan folder by separate-worktree tasks, and when: not undone by "Reassign". */
  merged: { files: string[]; at: number }[]
  /** How to restart a task put back to 'pending' by a loop-back (message with the review's issues). */
  modes: Record<string, PromptMode>
  /** Tasks downstream of a loop-back stopped on purpose: redone once their turn has ended. */
  draining: string[]
  /** Loop-back waiting for the tasks in `draining` to end their turn. */
  deferredLoop: { reviewId: string; result: TaskResult } | null
  /** Executor a task's session was created with: a restart with a different executor or permission needs a new one. */
  sessionSpec: Record<string, { agent: AgentId; model: string | null; effort: Effort | null; permission: PermissionLevel }>
}

export interface RunnerPorts {
  now(): number
  uuid(): string
  t: Tr
  env(name: string): string | undefined
  rules(projectId: string): Promise<PlanRules>
  // Persistence and events.
  save(state: PlanState, meta: PlanMeta): void
  emit(state: PlanState): void
  /** 'waiting': the plan is waiting for you (review or pause); 'resolved': no longer; 'completed': finished. */
  attention(state: PlanState, kind: 'waiting' | 'resolved' | 'completed'): void
  // Coordinator chat.
  notice(sessionId: string, text: string): void
  /** Message to the coordinator agent as if the user wrote it (rejection with a message, reply to an edit). */
  tellAgent(sessionId: string, text: string): Promise<void>
  // Task sessions.
  createSession(spec: TaskSessionSpec): Promise<string>
  send(sessionId: string, text: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  lastAssistantText(sessionId: string): string
  // Folders and git.
  /** New plan folder: 'worktree' creates a worktree (and runs setup), 'main' uses the checkout. Records the base commit. */
  createWorkspace(state: PlanState, kind: 'main' | 'worktree'): Promise<NonNullable<PlanState['workspace']>>
  /** Snapshot of the folder on a ref; null without git. */
  snapshot(cwd: string, ref: string): Promise<string | null>
  diffstat(cwd: string, from: string, to: string): Promise<PromptStat | null>
  /** Separate worktree branched from checkpoint `from` of the plan folder; null if not possible (the task waits in the queue). */
  createSideWorktree(state: PlanState, task: PlanTask, from: string): Promise<{ path: string; branch: string } | null>
  /** Brings the changes of a separate worktree back into the plan folder (base → end). */
  applyChanges(workspace: string, side: string, base: string, end: string): Promise<{ ok: true } | { ok: false; error: string }>
  saveRef(cwd: string, ref: string, sha: string): Promise<void>
  /**
   * Undoes the task's changes (the files touched by the turns of its session) back to the state of checkpoint `sha`,
   * without touching the files in `exclude` (brought in by other tasks) or those the task did not touch (your own edits).
   */
  restoreOwn(cwd: string, sha: string, sessionId: string, exclude: string[], label: string): Promise<void>
  /**
   * Removes a separate worktree and its branch, and archives the session of the task that worked there (its folder disappears).
   * In the background: it does not wait for the archiving (which notifies the plan and would re-enter its queue).
   */
  removeSideWorktree(projectId: string, path: string, branch: string, sessionIds: string[]): Promise<void>
  /** Untracked files that a folder snapshot leaves out (too large); null if the check could not be done. */
  unsaved(cwd: string): Promise<string[] | null>
}

interface Entry {
  state: PlanState
  meta: PlanMeta
  /** Last "waiting for you" condition notified: state + reason + task. */
  waitKey: string | null
}

export type Proposal = { ok: true; state: PlanState } | { ok: false; errors: string[] }

const emptyMeta = (): PlanMeta => ({ starts: {}, sideBase: {}, acked: [], corrected: [], retired: [], retiredOf: {}, sessionCwd: {}, sideBranch: {}, agentRevision: null, restart: [], startAt: {}, merged: [], modes: {}, draining: [], deferredLoop: null, sessionSpec: {} })

const newRun = (task: PlanTask): PlanTaskRun => ({
  taskId: task.id,
  status: 'pending',
  sessionId: null,
  agent: task.agent,
  model: task.model,
  effort: task.effort,
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
  files: null
})

const closed = (run: PlanTaskRun | undefined): boolean => run?.status === 'completed' || run?.status === 'skipped'
const problem = (run: PlanTaskRun): boolean => run.status === 'failed' || run.status === 'blocked' || run.status === 'interrupted'
const firstLine = (text: string, max = 300): string => {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export class PlanRunner {
  private readonly entries = new Map<string, Entry>()
  private readonly chains = new Map<string, Promise<unknown>>()
  /** report_result outcome waiting for the end of the turn, per session. */
  private readonly results = new Map<string, TaskResult>()
  private readonly ports: RunnerPorts

  constructor(ports: RunnerPorts) {
    this.ports = ports
  }

  private get t(): Tr {
    return this.ports.t
  }

  // ── In-memory store ──────────────────────────────────────────────────────

  load(items: { state: PlanState; meta: PlanMeta }[]): void {
    for (const { state, meta } of items) {
      const entry: Entry = { state, meta: { ...emptyMeta(), ...meta }, waitKey: null }
      entry.waitKey = this.waitKeyOf(state)
      this.entries.set(state.id, entry)
    }
  }

  get(planId: string): PlanState | null {
    return this.entries.get(planId)?.state ?? null
  }

  all(): PlanState[] {
    return [...this.entries.values()].map((e) => e.state)
  }

  /** The task running in a session. */
  taskOf(sessionId: string): { planId: string; taskId: string } | null {
    for (const { state } of this.entries.values()) {
      const run = state.runs.find((r) => r.sessionId === sessionId)
      if (run) return { planId: state.id, taskId: run.taskId }
    }
    return null
  }

  /** Task of a session, even a retired one (Reassign): for the banner in its chat. */
  taskRef(sessionId: string): { planId: string; taskId: string } | null {
    const live = this.taskOf(sessionId)
    if (live) return live
    for (const { state, meta } of this.entries.values()) if (meta.retiredOf[sessionId]) return { planId: state.id, taskId: meta.retiredOf[sessionId] }
    return null
  }

  private retire(entry: Entry, sessionId: string, taskId: string): void {
    if (!entry.meta.retired.includes(sessionId)) entry.meta.retired.push(sessionId)
    entry.meta.retiredOf[sessionId] = taskId
    this.results.delete(sessionId)
  }

  /** A task session, even if the task has moved to another session (Reassign). */
  isTaskSession(sessionId: string): boolean {
    if (this.taskOf(sessionId)) return true
    for (const { meta } of this.entries.values()) if (meta.retired.includes(sessionId)) return true
    return false
  }

  private entry(planId: string): Entry {
    const entry = this.entries.get(planId)
    if (!entry) throw new Error(this.t('Plan not found.'))
    return entry
  }

  private exclusive<T>(planId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(planId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    this.chains.set(
      planId,
      next.catch(() => undefined)
    )
    return next
  }

  private runOf(state: PlanState, taskId: string): PlanTaskRun {
    const run = state.runs.find((r) => r.taskId === taskId)
    if (!run) throw new Error(this.t('Task not found in the plan.'))
    return run
  }

  private taskIn(state: PlanState, taskId: string): PlanTask {
    const task = state.plan.tasks.find((x) => x.id === taskId)
    if (!task) throw new Error(this.t('Task not found in the plan.'))
    return task
  }

  // ── Saving, pause and notifications ──────────────────────────────────────

  private waitKeyOf(state: PlanState): string | null {
    if (state.status === 'review') return 'review'
    if (state.status === 'paused') return `paused:${state.pause?.reason ?? ''}:${state.pause?.taskId ?? ''}`
    return null
  }

  /** Choices offered for a stopped task, the same as its pause. */
  private choicesFor(entry: Entry, task: PlanTask, run: PlanTaskRun): PlanChoice[] {
    if (!problem(run) || entry.meta.draining.includes(task.id)) return []
    if (run.status === 'blocked' && task.kind === 'review' && task.onBlocking && run.result?.status === 'done' && run.result.verdict === 'changes-requested') return ['continue', 'stop']
    return ['retry', 'reassign', 'skip', 'stop']
  }

  /** The plan is using this folder right now: its own, or the separate worktree of a task not yet brought back. */
  usesFolder(path: string): boolean {
    for (const { state, meta } of this.entries.values()) {
      if (state.status !== 'running' && state.status !== 'paused') continue
      if (state.workspace?.path === path) return true
      if (state.runs.some((r) => r.cwd === path && r.worktree === path && meta.sideBase[r.taskId])) return true
    }
    return false
  }

  /** The plan governs this session right now (running task): only then it does not notify on its own. */
  controls(sessionId: string): boolean {
    const hit = this.taskOf(sessionId)
    if (!hit) return false
    const entry = this.entries.get(hit.planId)
    if (!entry || (entry.state.status !== 'running' && entry.state.status !== 'paused')) return false
    return entry.state.runs.find((r) => r.taskId === hit.taskId)?.status === 'running'
  }

  /** Pause derived from the state: an edit to confirm, then stopped tasks (in plan order), then stop points. */
  private derivePause(entry: Entry): PlanPause | null {
    const { state, meta } = entry
    const at = this.ports.now()
    const keep = (reason: PlanPause['reason'], taskId: string | null, message: string, choices: PlanChoice[]): PlanPause => {
      const old = state.pause
      return { reason, taskId, message, choices, at: old && old.reason === reason && old.taskId === taskId ? old.at : at }
    }
    if (state.pendingUpdate) return keep('confirm-update', null, this.t('Your agent wants to change the plan: {reason}', { reason: state.updateReason ?? this.t('no reason given') }), ['stop'])
    meta.restart = meta.restart.filter((id) => state.runs.find((r) => r.taskId === id)?.status === 'interrupted')
    for (const task of state.plan.tasks) {
      const run = this.runOf(state, task.id)
      // A task downstream of a loop-back, stopped on purpose, is not a problem: it is redone as soon as its turn ends.
      if (!problem(run) || entry.meta.draining.includes(task.id)) continue
      const title = task.title
      if (run.status === 'failed') return keep('failed', task.id, this.t('“{task}” failed: {error}', { task: title, error: run.error ?? this.t('unknown error') }), ['retry', 'reassign', 'skip', 'stop'])
      if (run.status === 'blocked') {
        const exhausted = task.kind === 'review' && task.onBlocking && run.result?.status === 'done' && run.result.verdict === 'changes-requested'
        if (exhausted) return keep('loops-exhausted', task.id, this.t('“{task}” still finds blocking issues after {n} round trips.', { task: title, n: task.onBlocking!.max }), ['continue', 'stop'])
        return keep('blocked', task.id, this.t('“{task}” is blocked and needs a decision from you: {error}', { task: title, error: run.error ?? this.t('see the task session') }), ['retry', 'reassign', 'skip', 'stop'])
      }
      if (meta.restart.includes(task.id)) return keep('restart', task.id, this.t('Ladder was closed while “{task}” was running.', { task: title }), ['retry', 'reassign', 'skip', 'stop'])
      return keep('interrupted', task.id, this.t('“{task}” was interrupted.', { task: title }), ['retry', 'reassign', 'skip', 'stop'])
    }
    for (const task of state.plan.tasks) {
      const run = this.runOf(state, task.id)
      if (run.status !== 'completed' || !state.plan.stopAfter.includes(task.id) || meta.acked.includes(`${task.id}:${run.iteration}`)) continue
      const waiting = state.plan.tasks.some((next) => next.after.includes(task.id) && ['pending', 'queued'].includes(this.runOf(state, next.id).status))
      if (waiting) return keep('stop-point', task.id, this.t('Stopped after “{task}”, as the plan says. Continue when you are ready.', { task: task.title }), ['continue', 'stop'])
    }
    return null
  }

  /** Updates state and pause, saves, emits and notifies whoever is waiting. Does not start tasks (`advance` does). */
  private commit(entry: Entry): void {
    const state = entry.state
    state.updatedAt = this.ports.now()
    let completedNow = false
    if (state.status === 'running' || state.status === 'paused') {
      if (state.runs.length > 0 && state.runs.every((r) => closed(r))) {
        state.status = 'completed'
        state.pause = null
        state.pendingUpdate = null
        state.endedAt = state.updatedAt
        completedNow = true
      } else {
        state.pause = this.derivePause(entry)
        state.status = state.pause ? 'paused' : 'running'
      }
    } else state.pause = null
    this.ports.save(state, entry.meta)
    this.ports.emit(state)
    const key = this.waitKeyOf(state)
    if (key !== entry.waitKey) {
      const was = entry.waitKey
      entry.waitKey = key
      if (key) this.ports.attention(state, 'waiting')
      else if (was) this.ports.attention(state, 'resolved')
    }
    if (completedNow) {
      this.ports.notice(state.sessionId, this.t('Plan completed: {goal}', { goal: firstLine(state.plan.goal, 120) }))
      this.ports.attention(state, 'completed')
    }
  }

  /** Saves and re-emits without touching state and pause (minor changes, like `waiting`). */
  private touch(entry: Entry): void {
    entry.state.updatedAt = this.ports.now()
    this.ports.save(entry.state, entry.meta)
    this.ports.emit(entry.state)
  }

  private async settle(entry: Entry): Promise<void> {
    this.commit(entry)
    if (entry.state.status === 'running') await this.advance(entry)
  }

  // ── Proposal and edit (agent tools, user card) ───────────────────────────

  /** `propose_plan`: validates, marks the same session's plans in review 'superseded' and creates a new one. */
  async propose(sessionId: string, projectId: string, author: AgentId, input: unknown): Promise<Proposal> {
    const rules = await this.ports.rules(projectId)
    const checked = validatePlan(input, rules)
    if (!checked.ok) return checked
    // Going through the old plan's queue: an approval in progress finishes first and the plan is no longer in review.
    for (const old of [...this.entries.values()]) {
      if (old.state.sessionId !== sessionId || old.state.status !== 'review') continue
      await this.exclusive(old.state.id, async () => {
        if (old.state.status !== 'review') return
        old.state.status = 'superseded'
        old.state.endedAt = this.ports.now()
        this.commit(old)
      })
    }
    const now = this.ports.now()
    const state: PlanState = {
      id: this.ports.uuid(),
      sessionId,
      projectId,
      status: 'review',
      revision: 1,
      plan: checked.plan,
      author,
      updateReason: null,
      pendingUpdate: null,
      runs: checked.plan.tasks.map(newRun),
      pause: null,
      workspace: null,
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
      endedAt: null
    }
    const entry: Entry = { state, meta: { ...emptyMeta(), agentRevision: 1 }, waitKey: null }
    this.entries.set(state.id, entry)
    this.commit(entry)
    return { ok: true, state }
  }

  /** `plan.useTemplate`: same path as propose, with the new goal in place of the example one. */
  useTemplate(sessionId: string, projectId: string, author: AgentId, plan: Plan, goal: string): Promise<Proposal> {
    return this.propose(sessionId, projectId, author, { ...plan, goal })
  }

  /** Checks that `next` is an allowed change for a plan already started: tasks no longer 'pending' stay identical. English error, for the agent. */
  private checkUpdate(state: PlanState, next: Plan): { error: string } | { confirm: boolean } {
    const byId = new Map(next.tasks.map((x) => [x.id, x]))
    let confirm = false
    for (const old of state.plan.tasks) {
      const run = this.runOf(state, old.id)
      const now = byId.get(old.id)
      const open = run.status === 'pending' || run.status === 'queued'
      if (!open) {
        if (!now) return { error: `Task "${old.id}" is ${run.status}: it cannot be removed. Keep it exactly as it is.` }
        if (JSON.stringify(now) !== JSON.stringify(old)) return { error: `Task "${old.id}" is ${run.status}: it cannot change. Send it exactly as it is and change only tasks that have not started.` }
      } else if (now && (now.agent !== old.agent || now.model !== old.model || now.effort !== old.effort || now.permission !== old.permission)) confirm = true
    }
    for (const task of next.tasks) if (!state.plan.tasks.some((x) => x.id === task.id)) confirm = true
    return { confirm }
  }

  /** Replaces the plan keeping the runs of the tasks that remain and the constraints written by you. */
  private replacePlan(entry: Entry, plan: Plan): void {
    const state = entry.state
    for (const old of state.runs) if (old.sessionId && !plan.tasks.some((x) => x.id === old.taskId)) this.retire(entry, old.sessionId, old.taskId)
    const kept = state.plan.constraints.filter((c) => c.by === 'user' && !plan.constraints.some((n) => n.text === c.text))
    state.runs = plan.tasks.map((task) => {
      const old = state.runs.find((r) => r.taskId === task.id)
      if (!old) return newRun(task)
      if (old.status === 'pending' || old.status === 'queued') {
        // Another executor, model, effort or permission: the previous session has the old settings, so a new one is created.
        const before = state.plan.tasks.find((x) => x.id === task.id)
        let sessionId = old.sessionId
        if (sessionId && before && (before.agent !== task.agent || before.model !== task.model || before.effort !== task.effort || before.permission !== task.permission)) {
          this.retire(entry, sessionId, task.id)
          sessionId = null
          delete entry.meta.modes[task.id]
        }
        return { ...old, sessionId, status: 'pending' as const, queuedBehind: null, agent: task.agent, model: task.model, effort: task.effort }
      }
      return old
    })
    state.plan = { ...plan, constraints: [...plan.constraints, ...kept] }
    state.revision += 1
  }

  /** `revise_plan`. Replies with the text for the agent. */
  async revise(sessionId: string, planId: string, input: unknown, reason: string): Promise<{ ok: boolean; text: string }> {
    const entry = this.entries.get(planId)
    if (!entry || entry.state.sessionId !== sessionId) return { ok: false, text: `Plan "${planId}" was not found in this session. Use the planId returned by propose_plan.` }
    return this.exclusive(planId, async () => {
      const state = entry.state
      const rules = await this.ports.rules(state.projectId)
      if (state.status === 'completed' || state.status === 'stopped' || state.status === 'superseded') return { ok: false, text: `This plan is ${state.status}: it cannot change. Propose a new plan with propose_plan if needed.` }
      const checked = validatePlan(input, rules)
      if (!checked.ok) return { ok: false, text: `The plan is not valid:\n${checked.errors.map((e) => `- ${e}`).join('\n')}\nFix them and call revise_plan again.` }
      const why = firstLine(reason, 500) || 'Plan updated'
      if (state.status === 'review') {
        // You edited the card after its last version: its copy is stale and would overwrite your edit.
        if (entry.meta.agentRevision !== null && entry.meta.agentRevision !== state.revision) {
          // The error hands it the current plan: its next version starts from there.
          entry.meta.agentRevision = state.revision
          this.ports.save(state, entry.meta)
          return { ok: false, text: `The user edited the plan since your last version (it is now revision ${state.revision}). Do not overwrite their changes: revise from the current plan below and send the whole plan again.\n${JSON.stringify(state.plan)}` }
        }
        this.replacePlan(entry, checked.plan)
        state.runs = checked.plan.tasks.map(newRun)
        entry.meta.agentRevision = state.revision
        state.updateReason = why
        this.commit(entry)
        return { ok: true, text: `The plan was updated (revision ${state.revision}) and is shown to the user for approval. Do not start the work yourself. End your turn now.` }
      }
      const verdict = this.checkUpdate(state, checked.plan)
      if ('error' in verdict) return { ok: false, text: verdict.error }
      state.updateReason = why
      if (verdict.confirm) {
        state.pendingUpdate = checked.plan
        this.commit(entry)
        return { ok: true, text: 'This change needs the user to confirm it (it changes executors, models, permissions or adds tasks). The plan is paused until the user answers, and stays as it is meanwhile. End your turn now: the answer arrives as a message.' }
      }
      state.pendingUpdate = null
      this.replacePlan(entry, checked.plan)
      await this.settle(entry)
      return { ok: true, text: `The plan was updated (revision ${state.revision}). The tasks that have not started will use the new version. End your turn now.` }
    })
  }

  /** `plan.edit`: the user's card, only in review. */
  edit(planId: string, revision: number, plan: Plan): Promise<PlanState> {
    return this.exclusive(planId, async () => {
      const entry = this.entry(planId)
      const state = entry.state
      if (state.status !== 'review') throw new Error(this.t('Only a plan waiting for approval can be edited.'))
      if (state.revision !== revision) throw new Error(this.t('The plan changed in the meantime. Review the new version.'))
      const checked = validatePlan(plan, await this.ports.rules(state.projectId))
      if (!checked.ok) throw new Error(this.t('The plan is not valid:\n{errors}', { errors: checked.errors.join('\n') }))
      state.plan = checked.plan
      state.runs = checked.plan.tasks.map(newRun)
      state.revision += 1
      state.updateReason = null
      this.commit(entry)
      return state
    })
  }

  // ── User decisions ───────────────────────────────────────────────────────

  approve(planId: string, revision: number, kind: 'main' | 'worktree'): Promise<PlanState> {
    return this.exclusive(planId, async () => {
      const entry = this.entry(planId)
      const state = entry.state
      if (state.status !== 'review') throw new Error(this.t('Only a plan waiting for approval can be approved.'))
      if (state.revision !== revision) throw new Error(this.t('The plan changed in the meantime. Review the new version.'))
      const checked = validatePlan(state.plan, await this.ports.rules(state.projectId))
      if (!checked.ok) throw new Error(this.t('The plan is not valid:\n{errors}', { errors: checked.errors.join('\n') }))
      state.workspace = await this.ports.createWorkspace(state, kind)
      state.plan = checked.plan
      state.runs = checked.plan.tasks.map(newRun)
      state.status = 'running'
      state.approvedAt = this.ports.now()
      await this.settle(entry)
      return state
    })
  }

  /** Rejection in review. The message, if any, goes to the coordinator as a user message. */
  reject(planId: string, message?: string): Promise<PlanState> {
    return this.exclusive(planId, async () => {
      const entry = this.entry(planId)
      const state = entry.state
      if (state.status !== 'review') throw new Error(this.t('Only a plan waiting for approval can be rejected.'))
      state.status = 'stopped'
      state.endedAt = this.ports.now()
      this.commit(entry)
      if (message?.trim()) await this.ports.tellAgent(state.sessionId, message.trim()).catch(() => undefined)
      return state
    })
  }

  /** Confirms or rejects the edit proposed by the agent. The answer reaches it as a message. */
  confirmUpdate(planId: string, accept: boolean): Promise<PlanState> {
    return this.exclusive(planId, async () => {
      const entry = this.entry(planId)
      const state = entry.state
      const next = state.pendingUpdate
      if (!next) throw new Error(this.t('There is no change waiting for your confirmation.'))
      let answer: string
      state.pendingUpdate = null
      if (!accept) answer = 'The user rejected your plan change. The plan stays as it was. Do not insist; ask the user what they want.'
      else {
        const rules = await this.ports.rules(state.projectId)
        const checked = validatePlan(next, rules)
        const verdict = checked.ok ? this.checkUpdate(state, checked.plan) : { error: checked.errors.join('; ') }
        if (!checked.ok || 'error' in verdict) {
          answer = `The user accepted your plan change, but it no longer applies: ${'error' in verdict ? verdict.error : ''} The plan stays as it was.`
        } else {
          this.replacePlan(entry, checked.plan)
          answer = 'The user accepted your plan change. It is in effect.'
        }
      }
      state.updateReason = null
      await this.settle(entry)
      await this.ports.tellAgent(state.sessionId, answer).catch(() => undefined)
      return state
    })
  }

  stop(planId: string): Promise<PlanState> {
    return this.exclusive(planId, async () => {
      const entry = this.entry(planId)
      if (entry.state.status !== 'running' && entry.state.status !== 'paused') throw new Error(this.t('The plan is not running.'))
      return this.stopNow(entry)
    })
  }

  /** Choice from the pause card. */
  choose(planId: string, choice: PlanChoice, taskId: string | undefined, reassign: { agent: AgentId; model: string | null; effort: Effort | null; keepWork: boolean } | undefined): Promise<PlanState> {
    return this.exclusive(planId, async () => {
      const entry = this.entry(planId)
      const state = entry.state
      if (choice === 'stop') {
        // Same effect as plan.stop, without re-entering the queue.
        if (state.status !== 'running' && state.status !== 'paused') throw new Error(this.t('The plan is not running.'))
        return this.stopNow(entry)
      }
      const pause = state.pause
      if (state.status !== 'paused' || !pause) throw new Error(this.t('The plan is not waiting for a choice.'))
      const id = taskId ?? pause.taskId
      if (choice === 'continue') {
        if (!id) throw new Error(this.t('This choice is not available now.'))
        const run = this.runOf(state, id)
        if (pause.reason === 'stop-point') entry.meta.acked.push(`${id}:${run.iteration}`)
        else if (pause.reason === 'loops-exhausted') {
          // Accepted as is: the review counts as completed with its issues.
          run.status = 'completed'
          run.error = null
        } else throw new Error(this.t('This choice is not available now.'))
        await this.settle(entry)
        return state
      }
      if (!id) throw new Error(this.t('This choice is not available now.'))
      const task = this.taskIn(state, id)
      const run = this.runOf(state, id)
      if (!problem(run)) throw new Error(this.t('This task is not stopped.'))
      // Only the choices the card offers for that task: not an exhausted loop-back, not a task being stopped for a loop-back.
      if (!this.choicesFor(entry, task, run).includes(choice)) throw new Error(this.t('This choice is not available now.'))
      if (choice === 'skip') {
        run.status = 'skipped'
        run.error = null
        run.endedAt = this.ports.now()
        if (run.sessionId) this.results.delete(run.sessionId)
        const side = this.sideOf(entry, run)
        if (side) await this.discardSide(entry, task, side, run.sessionId)
        await this.settle(entry)
        return state
      }
      if (choice === 'retry') {
        await this.retry(entry, task, run)
        await this.settle(entry)
        return state
      }
      // reassign
      if (!reassign) throw new Error(this.t('Choose the new executor.'))
      await this.reassign(entry, task, run, reassign)
      await this.settle(entry)
      return state
    })
  }

  private async stopNow(entry: Entry): Promise<PlanState> {
    const state = entry.state
    const sessions: string[] = []
    for (const run of state.runs) {
      if (run.status === 'running') {
        run.status = 'interrupted'
        run.endedAt = this.ports.now()
        run.waiting = false
        if (run.sessionId) sessions.push(run.sessionId)
      } else if (run.status === 'queued') {
        run.status = 'pending'
        run.queuedBehind = null
      }
      if (run.sessionId) this.results.delete(run.sessionId)
    }
    entry.meta.draining = []
    entry.meta.deferredLoop = null
    state.status = 'stopped'
    state.pendingUpdate = null
    state.endedAt = this.ports.now()
    this.commit(entry)
    await Promise.all(sessions.map((id) => this.ports.interrupt(id).catch(() => undefined)))
    // The separate worktrees of stopped tasks are no longer needed: unapplied work stays in a ref.
    for (const run of state.runs) {
      const side = this.sideOf(entry, run)
      if (side) await this.discardSide(entry, this.taskIn(state, run.taskId), side, run.sessionId)
    }
    this.ports.save(state, entry.meta)
    return state
  }

  // ── Restarts: retry and reassign ─────────────────────────────────────────

  private async partial(entry: Entry, run: PlanTaskRun): Promise<PromptStat | null> {
    const start = entry.meta.starts[run.taskId]
    if (!run.cwd || !start) return null
    const now = await this.ports.snapshot(run.cwd, this.ref(entry, run, 'now')).catch(() => null)
    return now ? this.ports.diffstat(run.cwd, start, now).catch(() => null) : null
  }

  private ref(entry: Entry, run: PlanTaskRun, name: string): string {
    return `refs/ladder/plan/${entry.state.id}/${run.taskId}-${run.iteration}-${name}`
  }

  private async retry(entry: Entry, task: PlanTask, run: PlanTaskRun): Promise<void> {
    if (!run.sessionId || !run.cwd) {
      // Never really started: it starts from scratch.
      run.status = 'pending'
      run.error = null
      return
    }
    const mode: PromptMode = { kind: 'retry', error: run.error, partial: await this.partial(entry, run), lastText: this.ports.lastAssistantText(run.sessionId) }
    run.attempt += 1
    run.status = 'running'
    run.error = null
    run.endedAt = null
    run.startedAt = this.ports.now()
    run.waiting = false
    await this.deliver(entry, task, run, mode)
  }

  private checkExecutor(rules: PlanRules, agent: AgentId): string | null {
    if (rules.allowed.length && !rules.allowed.includes(agent)) return this.t('“{agent}” is not allowed in this project.', { agent })
    if (!rules.available.includes(agent)) return this.t('“{agent}” is not available.', { agent })
    return null
  }

  private async reassign(entry: Entry, task: PlanTask, run: PlanTaskRun, to: { agent: AgentId; model: string | null; effort: Effort | null; keepWork: boolean }): Promise<void> {
    const error = this.checkExecutor(await this.ports.rules(entry.state.projectId), to.agent)
    if (error) throw new Error(error)
    const old = run.sessionId
    const failure = run.error
    const lastText = old ? this.ports.lastAssistantText(old) : ''
    const partial = await this.partial(entry, run)
    let partialRef: string | null = null
    if (!to.keepWork && run.cwd) {
      // The partial work is saved to a ref before the folder goes back to the start of the task.
      const start = entry.meta.starts[run.taskId]
      const now = await this.ports.snapshot(run.cwd, this.ref(entry, run, 'now')).catch(() => null)
      if (now) {
        partialRef = `refs/ladder/plan/${entry.state.id}/${run.taskId}-partial`
        await this.ports.saveRef(run.cwd, partialRef, now).catch(() => undefined)
      }
      if (start && old) {
        const since = entry.meta.startAt[run.taskId] ?? 0
        const exclude = entry.meta.merged.filter((m) => m.at >= since).flatMap((m) => m.files)
        await this.ports.restoreOwn(run.cwd, start, old, exclude, this.t('Reassigned task “{task}”', { task: task.title }))
      }
    }
    const previous = run.agent
    if (old) {
      this.retire(entry, old, run.taskId)
    }
    run.agent = to.agent
    run.model = to.model
    run.effort = to.effort
    run.sessionId = null
    run.attempt += 1
    run.status = 'running'
    run.error = null
    run.endedAt = null
    run.startedAt = this.ports.now()
    run.waiting = false
    await this.deliver(entry, task, run, { kind: 'reassign', error: failure, partial, lastText, keepWork: to.keepWork, previous, partialRef })
  }

  // ── Starting tasks ───────────────────────────────────────────────────────

  /** Describes the code state for the delivery message: folder, branch, base and changes since the plan's base commit. */
  private async codeState(entry: Entry, run: PlanTaskRun) {
    const ws = entry.state.workspace!
    const cwd = run.cwd ?? ws.path
    let stat: PromptStat | null = null
    if (ws.base) {
      const now = await this.ports.snapshot(cwd, this.ref(entry, run, 'code')).catch(() => null)
      stat = now ? await this.ports.diffstat(cwd, ws.base, now).catch(() => null) : null
    }
    return { cwd, branch: ws.branch, base: ws.base, stat, separate: !!run.worktree }
  }

  /** Composes the message and delivers it: in a new session (created now) or in the one the task already has. */
  private async deliver(entry: Entry, task: PlanTask, run: PlanTaskRun, mode: PromptMode): Promise<void> {
    const state = entry.state
    try {
      const prompt = composePrompt({ state, task, run, mode, code: await this.codeState(entry, run) })
      if (!run.sessionId) {
        const ws = state.workspace!
        const separate = !!run.worktree
        run.sessionId = await this.ports.createSession({
          projectId: state.projectId,
          planId: state.id,
          taskId: task.id,
          title: task.title,
          agent: run.agent,
          model: run.model,
          effort: run.effort,
          permission: task.permission,
          cwd: run.cwd ?? ws.path,
          worktree: separate ? { path: run.cwd!, branch: entry.meta.sideBranch[task.id] ?? '', base: entry.meta.sideBase[task.id] ?? ws.base ?? '' } : ws.kind === 'worktree' ? { path: ws.path, branch: ws.branch ?? '', base: ws.base ?? '' } : null
        })
        entry.meta.sessionCwd[run.sessionId] = run.cwd ?? ws.path
        entry.meta.sessionSpec[run.sessionId] = { agent: run.agent, model: run.model, effort: run.effort, permission: task.permission }
        // From here the session belongs to this task (role, report_result): saved before the first message.
        this.touch(entry)
      }
      await this.ports.send(run.sessionId, prompt)
    } catch (error) {
      this.fail(entry, run, (error as Error).message)
    }
  }

  private writes(state: PlanState, taskId: string): boolean {
    return taskWrites(this.taskIn(state, taskId))
  }

  /** Starts the ready tasks where they can run; the others wait in the queue. */
  private async advance(entry: Entry): Promise<void> {
    const state = entry.state
    if (state.status !== 'running' || !state.workspace || entry.meta.deferredLoop) return
    const ws = state.workspace
    let changed = false
    for (const task of state.plan.tasks) {
      if (state.status !== 'running') break
      const run = this.runOf(state, task.id)
      if (run.status !== 'pending' && run.status !== 'queued') continue
      if (!task.after.every((dep) => closed(state.runs.find((r) => r.taskId === dep)))) continue
      // A pause that appeared while starting (a task that did not start) stops the others.
      if (state.runs.some(problem) || state.pendingUpdate) break
      const active = state.runs.find((r) => r.status === 'running' && r.cwd === ws.path && this.writes(state, r.taskId))
      const writer = taskWrites(task)
      let separate = false
      if (writer && active) separate = true
      else if (!writer && active) {
        run.status = 'queued'
        run.queuedBehind = this.taskIn(state, active.taskId).title
        changed = true
        continue
      }
      run.queuedBehind = null
      const previousCwd = run.cwd
      const oldSide = entry.meta.sideBase[task.id] && previousCwd ? { cwd: previousCwd, base: entry.meta.sideBase[task.id], branch: entry.meta.sideBranch[task.id] ?? '', session: run.sessionId } : null
      run.cwd = ws.path
      run.worktree = null
      if (separate) {
        const base = await this.ports.snapshot(ws.path, `refs/ladder/plan/${state.id}/${task.id}-${run.iteration}-base`).catch(() => null)
        const side = base ? await this.ports.createSideWorktree(state, task, base).catch(() => null) : null
        if (!base || !side) {
          // Without git (or if the worktree cannot be created) the second writer waits for its turn.
          run.status = 'queued'
          run.queuedBehind = this.taskIn(state, active!.taskId).title
          changed = true
          continue
        }
        run.cwd = side.path
        run.worktree = side.path
        entry.meta.sideBase[task.id] = base
        entry.meta.sideBranch[task.id] = side.branch
        entry.meta.starts[task.id] = base
      } else {
        const start = await this.ports.snapshot(ws.path, this.ref(entry, run, 'start')).catch(() => null)
        if (start) entry.meta.starts[task.id] = start
        else delete entry.meta.starts[task.id]
      }
      run.status = 'running'
      run.startedAt = this.ports.now()
      entry.meta.startAt[task.id] = run.startedAt
      run.endedAt = null
      run.error = null
      run.waiting = false
      run.files = null
      let mode = entry.meta.modes[task.id] ?? (run.sessionId ? ({ kind: 'rerun', round: run.iteration } as PromptMode) : ({ kind: 'start' } as PromptMode))
      delete entry.meta.modes[task.id]
      // A session keeps the folder it was created with: it is reused only if it is the one chosen now, otherwise a new one is created.
      // The same goes for executor, model and permission: a session with different settings is not reused.
      const spec = run.sessionId ? entry.meta.sessionSpec[run.sessionId] : undefined
      const stale = !!spec && (spec.agent !== run.agent || spec.model !== run.model || spec.effort !== run.effort || spec.permission !== task.permission)
      if (run.sessionId && (stale || (entry.meta.sessionCwd[run.sessionId] ?? previousCwd) !== run.cwd)) {
        this.retire(entry, run.sessionId, task.id)
        run.sessionId = null
        mode = mode.kind === 'loop' ? { ...mode, fresh: true } : { kind: 'start' }
      }
      // The separate worktree of a previous round, never brought into the plan folder, is no longer needed.
      if (oldSide && oldSide.cwd !== run.cwd) await this.discardSide(entry, task, oldSide, oldSide.session)
      this.touch(entry)
      await this.deliver(entry, task, run, mode)
      changed = true
    }
    if (changed) this.commit(entry)
  }

  // ── End of turns ─────────────────────────────────────────────────────────

  private fail(entry: Entry, run: PlanTaskRun, error: string): void {
    run.status = 'failed'
    run.error = error
    run.endedAt = this.ports.now()
    run.waiting = false
  }

  /** `report_result` from the task's agent. The result is applied at the end of the turn. */
  reportResult(sessionId: string, input: unknown): { ok: boolean; text: string } {
    const hit = this.taskOf(sessionId)
    if (!hit) return { ok: false, text: 'This session is not running a task of a plan, so there is nothing to report to.' }
    const entry = this.entry(hit.planId)
    const run = this.runOf(entry.state, hit.taskId)
    if (run.status !== 'running') return { ok: false, text: `This task is not running any more (it is ${run.status}). Nothing was recorded. End your turn.` }
    const task = this.taskIn(entry.state, hit.taskId)
    const checked = validateResult(input, task.kind)
    if (!checked.ok) return { ok: false, text: `The result is not valid:\n${checked.errors.map((e) => `- ${e}`).join('\n')}\nFix them and call report_result again.` }
    this.results.set(sessionId, checked.result)
    return { ok: true, text: 'Result recorded. End your turn now.' }
  }

  /** End of a turn of a task session (Host.onTurnEnd hook). */
  onTurnEnd(sessionId: string, end: TurnEnd): Promise<void> {
    const hit = this.taskOf(sessionId)
    if (!hit) return Promise.resolve()
    return this.exclusive(hit.planId, async () => {
      const entry = this.entry(hit.planId)
      const state = entry.state
      const run = this.runOf(state, hit.taskId)
      const task = this.taskIn(state, hit.taskId)
      if (entry.meta.draining.includes(task.id) && run.sessionId === sessionId) return this.drained(entry, task.id, sessionId)
      // Plan stopped or task already closed (turn interrupted by plan.stop): nothing to do.
      if (run.sessionId !== sessionId || run.status !== 'running' || state.status === 'stopped') {
        this.results.delete(sessionId)
        return
      }
      const result = this.results.get(sessionId) ?? null
      this.results.delete(sessionId)
      // Acceptance test: the first attempt of this task ends as a failed turn.
      const simulated = this.ports.env('LADDER_PLAN_FAIL') === task.id && run.iteration === 1 && run.attempt === 1
      await this.collect(entry, run)
      if (simulated) this.fail(entry, run, 'Simulated failure (LADDER_PLAN_FAIL)')
      else if (end.status === 'error') this.fail(entry, run, end.error ?? this.t('The turn stopped because of an error.'))
      else if (end.status === 'interrupted') {
        run.status = 'interrupted'
        run.error = null
        run.endedAt = this.ports.now()
        run.waiting = false
      } else if (!result) {
        const key = `${task.id}:${run.iteration}:${run.attempt}`
        if (!entry.meta.corrected.includes(key)) {
          // Only one automatic correction per attempt: the task stays running.
          entry.meta.corrected.push(key)
          this.touch(entry)
          await this.ports.send(sessionId, correctionPrompt(task)).catch((error: Error) => this.fail(entry, run, error.message))
          if (run.status === 'running') return
        } else this.fail(entry, run, this.t('The agent ended its turn without reporting a result.'))
      } else await this.finish(entry, task, run, result)
      await this.settle(entry)
    })
  }

  /** Files changed by the task (from its start checkpoint to now). */
  private async collect(entry: Entry, run: PlanTaskRun): Promise<void> {
    const stat = await this.partial(entry, run)
    run.files = stat && stat.count > 0 ? { added: stat.added, removed: stat.removed, count: stat.count } : null
  }

  /** `report_result` outcome of a turn that ended without errors. */
  private async finish(entry: Entry, task: PlanTask, run: PlanTaskRun, result: TaskResult): Promise<void> {
    const state = entry.state
    run.result = result
    run.endedAt = this.ports.now()
    run.waiting = false
    if (result.status === 'blocked') {
      run.status = 'blocked'
      run.error = firstLine(result.questions[0] ?? result.summary)
      return
    }
    if (result.status === 'failed') return this.fail(entry, run, firstLine(result.summary))
    // done: the changes of a separate worktree return to the plan folder.
    const base = entry.meta.sideBase[task.id]
    if (run.worktree && base && state.workspace) {
      const end = await this.ports.snapshot(run.cwd!, this.ref(entry, run, 'end')).catch(() => null)
      const merged = end ? await this.ports.applyChanges(state.workspace.path, run.cwd!, base, end) : { ok: false as const, error: this.t('The changes could not be read.') }
      if (!merged.ok) return this.fail(entry, run, this.t('Its changes conflict with the plan folder and were not applied: {error}', { error: merged.error }))
      // Brought into the plan folder: remember the files (not undone by another task's "Reassign") and remove the worktree.
      const stat = end ? await this.ports.diffstat(run.cwd!, base, end).catch(() => null) : null
      entry.meta.merged.push({ files: stat?.files ?? [], at: this.ports.now() })
      // First the worktree entries are removed, then the worktree itself: archiving its sessions must not see it as "in use" (it would skip the teardown script).
      const branch = entry.meta.sideBranch[task.id] ?? ''
      delete entry.meta.sideBase[task.id]
      delete entry.meta.sideBranch[task.id]
      await this.ports.removeSideWorktree(state.projectId, run.cwd!, branch, this.sessionsIn(entry, run.cwd!, run.sessionId)).catch(() => undefined)
    }
    run.status = 'completed'
    run.error = null
    if (task.kind === 'review' && task.onBlocking && result.verdict === 'changes-requested') {
      const used = run.iteration - 1
      if (used < task.onBlocking.max) await this.startLoop(entry, task, result)
      else {
        // Loop-backs exhausted: the review stays paused and asks you (continue = accepted as is).
        run.status = 'blocked'
        run.error = this.t('Blocking issues remain after {n} round trips.', { n: task.onBlocking.max })
      }
    }
  }

  /**
   * Loop-back from a review. Downstream tasks still running (parallel branches) are stopped and redone only after their
   * turn ends: resetting them right away would leave two writers in the same folder and lose their results.
   */
  private async startLoop(entry: Entry, review: PlanTask, result: TaskResult): Promise<void> {
    const state = entry.state
    const ids = new Set([review.onBlocking!.backTo, ...downstreamOf(state.plan.tasks, review.onBlocking!.backTo)])
    const running = [...ids].map((id) => this.runOf(state, id)).filter((r) => r.status === 'running' && r.taskId !== review.id)
    if (running.length === 0) return this.loopBack(entry, review, this.runOf(state, review.id), result)
    entry.meta.deferredLoop = { reviewId: review.id, result }
    const sessions: string[] = []
    for (const run of running) {
      run.status = 'interrupted'
      run.error = null
      run.endedAt = this.ports.now()
      run.waiting = false
      if (!entry.meta.draining.includes(run.taskId)) entry.meta.draining.push(run.taskId)
      if (run.sessionId) sessions.push(run.sessionId)
    }
    await Promise.all(sessions.map((id) => this.ports.interrupt(id).catch(() => undefined)))
  }

  /** A task stopped for the loop-back ended its turn: if it was the last one, the loop-back starts. */
  private async drained(entry: Entry, taskId: string, sessionId: string): Promise<void> {
    entry.meta.draining = entry.meta.draining.filter((id) => id !== taskId)
    this.results.delete(sessionId)
    const deferred = entry.meta.deferredLoop
    if (entry.meta.draining.length > 0 || !deferred) return
    entry.meta.deferredLoop = null
    await this.loopBack(entry, this.taskIn(entry.state, deferred.reviewId), this.runOf(entry.state, deferred.reviewId), deferred.result)
    await this.settle(entry)
  }

  /** A task's session is about to close (archived): if the task was running, its turn will never end. */
  sessionGone(sessionId: string): Promise<void> {
    const hit = this.taskOf(sessionId)
    if (!hit) return Promise.resolve()
    return this.exclusive(hit.planId, async () => {
      const entry = this.entry(hit.planId)
      const run = this.runOf(entry.state, hit.taskId)
      if (run.sessionId !== sessionId) return
      const wasRunning = run.status === 'running' && entry.state.status !== 'stopped'
      // An archived session no longer receives messages, whatever the task state: "Retry" and restarts create a new one.
      this.retire(entry, sessionId, run.taskId)
      run.sessionId = null
      if (entry.meta.draining.includes(run.taskId)) return this.drained(entry, run.taskId, sessionId)
      if (wasRunning) this.fail(entry, run, this.t('The task session was archived.'))
      await this.settle(entry)
    })
  }

  /** The sessions (current and retired) created in a folder: if the folder disappears they must be archived. */
  private sessionsIn(entry: Entry, cwd: string, current: string | null): string[] {
    const ids = new Set(entry.meta.retired.filter((id) => entry.meta.sessionCwd[id] === cwd))
    if (current) ids.add(current)
    return [...ids]
  }

  /** The task's separate worktree not yet brought back into the plan folder, if any. */
  private sideOf(entry: Entry, run: PlanTaskRun): { cwd: string; base: string; branch: string } | null {
    const base = entry.meta.sideBase[run.taskId]
    return base && run.worktree && run.cwd ? { cwd: run.cwd, base, branch: entry.meta.sideBranch[run.taskId] ?? '' } : null
  }

  /**
   * Removes the separate worktree of a task whose work will not return to the plan folder (skipped, stopped, redone in
   * another folder). If it contains unapplied changes it saves them in a git ref and says so in the coordinator's chat.
   */
  private async discardSide(entry: Entry, task: PlanTask, side: { cwd: string; base: string; branch: string }, sessionId: string | null): Promise<void> {
    const { meta, state } = entry
    const { cwd, base, branch } = side
    // The work is always saved to a ref; the folder is removed only if the snapshot succeeded and left nothing out.
    const now = await this.ports.snapshot(cwd, `refs/ladder/plan/${state.id}/${task.id}-side-now`).catch(() => null)
    const ref = `refs/ladder/plan/${state.id}/${task.id}-side-partial`
    let saved = false
    if (now) saved = await this.ports.saveRef(cwd, ref, now).then(() => true, () => false)
    const left = saved ? await this.ports.unsaved(cwd).catch(() => null) : null
    const safe = saved && left !== null && left.length === 0
    const stat = now ? await this.ports.diffstat(cwd, base, now).catch(() => null) : null
    if (!safe) {
      this.ports.notice(state.sessionId, this.t('The work of “{task}” could not be fully saved, so its worktree stays on disk in {path} (branch {branch}).', { task: task.title, path: cwd, branch }))
    } else if (!stat || stat.count > 0) {
      this.ports.notice(state.sessionId, this.t('The unapplied work of “{task}” was saved in the git ref {ref}.', { task: task.title, ref }))
    }
    // The task may already have a new worktree: only the entry of the discarded one is deleted.
    if (meta.sideBase[task.id] === base) {
      delete meta.sideBase[task.id]
      delete meta.sideBranch[task.id]
    }
    if (safe) await this.ports.removeSideWorktree(state.projectId, cwd, branch, this.sessionsIn(entry, cwd, sessionId)).catch(() => undefined)
  }

  /** Review with blocking issues: the loop-back task and everything downstream (the review included) start again. */
  private async loopBack(entry: Entry, review: PlanTask, run: PlanTaskRun, result: TaskResult): Promise<void> {
    const state = entry.state
    const target = review.onBlocking!.backTo
    const round = run.iteration
    const ids = new Set([target, ...downstreamOf(state.plan.tasks, target)])
    const issues = result.issues.filter((i) => i.severity === 'blocking')
    for (const id of ids) {
      const other = this.runOf(state, id)
      // A separate worktree not yet brought into the plan folder (task stopped midway) is no longer needed.
      if (other.worktree && other.cwd && entry.meta.sideBase[id]) await this.discardSide(entry, this.taskIn(state, id), { cwd: other.cwd, base: entry.meta.sideBase[id], branch: entry.meta.sideBranch[id] ?? '' }, other.sessionId)
      other.status = 'pending'
      other.iteration += 1
      other.attempt = 1
      other.error = null
      other.queuedBehind = null
      other.waiting = false
      other.files = null
      other.endedAt = null
      if (id === target) entry.meta.modes[id] = { kind: 'loop', round, max: review.onBlocking!.max, reviewTitle: review.title, reviewSummary: result.summary, issues: issues.length ? issues : result.issues, fresh: !other.sessionId }
      else if (other.sessionId) entry.meta.modes[id] = { kind: 'rerun', round: round + 1 }
    }
  }

  // ── Other session events ─────────────────────────────────────────────────

  /** The user writes in the session of a stopped task: the task goes back to running and the pause is lifted. */
  userWrote(sessionId: string): Promise<void> {
    const hit = this.taskOf(sessionId)
    if (!hit) return Promise.resolve()
    return this.exclusive(hit.planId, async () => {
      const entry = this.entry(hit.planId)
      const state = entry.state
      const run = this.runOf(state, hit.taskId)
      if (run.sessionId !== sessionId || !problem(run) || (state.status !== 'running' && state.status !== 'paused')) return
      // Every resumption is a new attempt: it gets its own automatic correction.
      run.attempt += 1
      run.status = 'running'
      run.error = null
      run.endedAt = null
      run.waiting = false
      this.commit(entry)
    })
  }

  /** The task's session is waiting for an answer (or stopped waiting): mirrored in `run.waiting`. */
  sessionWaiting(sessionId: string, waiting: boolean): void {
    const hit = this.taskOf(sessionId)
    if (!hit) return
    const entry = this.entries.get(hit.planId)
    if (!entry) return
    const run = entry.state.runs.find((r) => r.taskId === hit.taskId)
    if (!run || run.waiting === waiting || run.sessionId !== sessionId) return
    run.waiting = run.status === 'running' ? waiting : false
    this.touch(entry)
  }

  /** Ladder startup: tasks that were running are marked interrupted (a writer does not restart on its own), the pause says why. */
  async recover(): Promise<void> {
    for (const entry of this.entries.values()) {
      const state = entry.state
      if (state.status !== 'running' && state.status !== 'paused') continue
      await this.exclusive(state.id, async () => {
        // A loop-back that was waiting for stopped tasks to finish: those turns will never end, so the loop-back starts now.
        const deferred = entry.meta.deferredLoop
        if (deferred) {
          entry.meta.deferredLoop = null
          entry.meta.draining = []
          await this.loopBack(entry, this.taskIn(state, deferred.reviewId), this.runOf(state, deferred.reviewId), deferred.result)
        }
        for (const run of state.runs) {
          if (run.status === 'running') {
            run.status = 'interrupted'
            run.error = this.t('Ladder was closed while this task was running.')
            entry.meta.restart.push(run.taskId)
            run.endedAt = this.ports.now()
            run.waiting = false
          } else if (run.status === 'queued') {
            run.status = 'pending'
            run.queuedBehind = null
          }
        }
        await this.settle(entry)
      })
    }
  }
}
