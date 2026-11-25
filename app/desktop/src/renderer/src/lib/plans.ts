// Executable plans: pure functions and hooks for the chat card, the task banner and the palette.
import { useEffect, useMemo, useState } from 'react'
import { downstreamOf, permissionRank, upstreamOf, type Plan, type PlanRules, type PlanState, type PlanTask, type PlanTaskRun, type PlanTaskStatus } from '@shared/plan'
import type { AgentId, ProjectSettings } from '@shared/protocol'
import { t } from '@shared/i18n'
import { request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'

// ── Task state ───────────────────────────────────────────────────────

/** Label for a task state. With `waiting` the session is waiting for an answer from you: it outranks "Running". */
export function taskStatusLabel(status: PlanTaskStatus, waiting = false): string {
  if (status === 'running' && waiting) return t('Waiting for you')
  switch (status) {
    case 'pending':
      return t('Pending')
    case 'queued':
      return t('Queued')
    case 'running':
      return t('Running')
    case 'completed':
      return t('Completed')
    case 'failed':
      return t('Failed')
    case 'blocked':
      return t('Blocked')
    case 'interrupted':
      return t('Interrupted')
    case 'skipped':
      return t('Skipped')
  }
}

export function taskKindLabel(kind: PlanTask['kind']): string {
  switch (kind) {
    case 'plan':
      return t('Plan')
    case 'implement':
      return t('Implement')
    case 'review':
      return t('Review')
    default:
      return t('Task')
  }
}

export function runOf(state: Pick<PlanState, 'runs'>, taskId: string): PlanTaskRun | null {
  return state.runs.find((r) => r.taskId === taskId) ?? null
}

/** Duration of a round: a running one counts up to `now`. Null if it never started. */
export function runDuration(run: PlanTaskRun, now: number): number | null {
  if (!run.startedAt) return null
  return Math.max(0, (run.endedAt ?? now) - run.startedAt)
}

// ── Stages ────────────────────────────────────────────────────────────────────

/**
 * Groups tasks by dependency depth: stage 1 starts right away, stage N waits for the longest upstream one.
 * Tasks in the same stage do not depend on each other, so they can run together. The order is the plan's.
 */
export function phasesOf(tasks: PlanTask[]): PlanTask[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const depth = new Map<string, number>()
  const visit = (id: string, path: Set<string>): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    // A draft may contain a cycle: it stops here, and validation reports it separately.
    if (path.has(id)) return 0
    path.add(id)
    const after = (byId.get(id)?.after ?? []).filter((dep) => byId.has(dep))
    const value = after.length === 0 ? 0 : 1 + Math.max(...after.map((dep) => visit(dep, path)))
    path.delete(id)
    depth.set(id, value)
    return value
  }
  const phases: PlanTask[][] = []
  for (const task of tasks) {
    const level = visit(task.id, new Set())
    ;(phases[level] ??= []).push(task)
  }
  return phases.filter(Boolean)
}

// ── Draft edits ────────────────────────────────────────────────────

export function patchTask(plan: Plan, id: string, patch: Partial<PlanTask>): Plan {
  return { ...plan, tasks: plan.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)) }
}

/**
 * Removes a task from the plan: it also disappears from the others' `after` and from `stopAfter`. Tasks that depended on it inherit its
 * dependencies, so they do not start earlier than the plan intended. A return pointing to it (`onBlocking.backTo`) is removed.
 */
export function removeTask(plan: Plan, id: string): Plan {
  const removed = plan.tasks.find((task) => task.id === id)
  if (!removed) return plan
  const tasks = plan.tasks
    .filter((task) => task.id !== id)
    .map((task) => {
      const after = task.after.includes(id) ? [...new Set([...task.after.filter((dep) => dep !== id), ...removed.after])] : task.after
      const onBlocking = task.onBlocking && task.onBlocking.backTo === id ? null : task.onBlocking
      return after === task.after && onBlocking === task.onBlocking ? task : { ...task, after, onBlocking }
    })
  return { ...plan, tasks, stopAfter: plan.stopAfter.filter((stop) => stop !== id) }
}

/** Tasks that `id` can depend on without creating a cycle. */
export function possibleAfter(plan: Plan, id: string): PlanTask[] {
  const down = downstreamOf(plan.tasks, id)
  return plan.tasks.filter((task) => task.id !== id && !down.has(task.id))
}

export function toggleAfter(plan: Plan, id: string, dep: string): Plan {
  const task = plan.tasks.find((x) => x.id === id)
  if (!task) return plan
  const after = task.after.includes(dep) ? task.after.filter((x) => x !== dep) : [...task.after, dep]
  return patchTask(plan, id, { after })
}

export function toggleStop(plan: Plan, id: string): Plan {
  const stopAfter = plan.tasks.map((task) => task.id).filter((x) => (x === id ? !plan.stopAfter.includes(x) : plan.stopAfter.includes(x)))
  return { ...plan, stopAfter }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** Two plans with the same content. */
export function samePlan(a: Plan, b: Plan): boolean {
  return sameValue(a, b)
}

// ── Differences between two plans ────────────────────────────────────────────────

export type TaskField = 'title' | 'instruction' | 'kind' | 'executor' | 'permission' | 'after' | 'doneWhen' | 'loop'

export type PlanChange =
  | { kind: 'goal'; from: string; to: string }
  | { kind: 'constraint-added'; text: string }
  | { kind: 'constraint-removed'; text: string }
  | { kind: 'task-added'; task: PlanTask }
  | { kind: 'task-removed'; task: PlanTask }
  | { kind: 'task-changed'; before: PlanTask; after: PlanTask; fields: TaskField[] }
  | { kind: 'stop-added'; task: PlanTask }
  | { kind: 'stop-removed'; task: PlanTask }

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

/** What changes going from `from` to `to`: used to confirm an agent's change to an already approved plan. */
export function diffPlans(from: Plan, to: Plan): PlanChange[] {
  const changes: PlanChange[] = []
  if (from.goal !== to.goal) changes.push({ kind: 'goal', from: from.goal, to: to.goal })
  for (const c of to.constraints) if (!from.constraints.some((x) => x.text === c.text)) changes.push({ kind: 'constraint-added', text: c.text })
  for (const c of from.constraints) if (!to.constraints.some((x) => x.text === c.text)) changes.push({ kind: 'constraint-removed', text: c.text })
  const before = new Map(from.tasks.map((task) => [task.id, task]))
  const after = new Map(to.tasks.map((task) => [task.id, task]))
  for (const task of to.tasks) {
    const old = before.get(task.id)
    if (!old) {
      changes.push({ kind: 'task-added', task })
      continue
    }
    const fields: TaskField[] = []
    if (old.title !== task.title) fields.push('title')
    if (old.instruction !== task.instruction) fields.push('instruction')
    if (old.kind !== task.kind) fields.push('kind')
    if (old.agent !== task.agent || old.model !== task.model || old.effort !== task.effort) fields.push('executor')
    if (old.permission !== task.permission) fields.push('permission')
    if (!sameList(old.after, task.after)) fields.push('after')
    if (old.doneWhen !== task.doneWhen) fields.push('doneWhen')
    if (!sameValue(old.onBlocking, task.onBlocking)) fields.push('loop')
    if (fields.length) changes.push({ kind: 'task-changed', before: old, after: task, fields })
  }
  for (const task of from.tasks) if (!after.has(task.id)) changes.push({ kind: 'task-removed', task })
  for (const id of to.stopAfter) if (!from.stopAfter.includes(id) && after.has(id)) changes.push({ kind: 'stop-added', task: after.get(id)! })
  for (const id of from.stopAfter) if (!to.stopAfter.includes(id) && before.has(id)) changes.push({ kind: 'stop-removed', task: before.get(id)! })
  return changes
}

// ── Summary of a completed plan ──────────────────────────────────────────

export interface PlanSummary {
  tasks: number
  completed: number
  agents: AgentId[]
  /** Distinct agent and model pairs (a default model counts as one). */
  models: number
  files: { count: number; added: number; removed: number }
  checks: { total: number; passed: number; failed: number }
  /** From the first start to the end, or to `now` if not finished. */
  durationMs: number | null
}

export function summarizePlan(state: PlanState, now: number): PlanSummary {
  const runs = state.runs.filter((run) => run.status !== 'pending' || run.sessionId)
  const used = state.runs.filter((run) => run.sessionId || run.status === 'completed')
  const agents = [...new Set(used.map((run) => run.agent))]
  const models = new Set(used.map((run) => `${run.agent}\n${run.model ?? ''}`))
  const files = { count: 0, added: 0, removed: 0 }
  const checks = { total: 0, passed: 0, failed: 0 }
  for (const run of state.runs) {
    if (run.files) {
      files.count += run.files.count
      files.added += run.files.added
      files.removed += run.files.removed
    }
    for (const check of run.result?.checks ?? []) {
      checks.total++
      if (check.exit === 0) checks.passed++
      else if (check.exit !== null) checks.failed++
    }
  }
  const started = Math.min(...runs.map((run) => run.startedAt ?? Infinity), state.approvedAt ?? Infinity)
  const end = state.endedAt ?? now
  return {
    tasks: state.plan.tasks.length,
    completed: state.runs.filter((run) => run.status === 'completed' || run.status === 'skipped').length,
    agents,
    models: models.size,
    files,
    checks,
    durationMs: Number.isFinite(started) ? Math.max(0, end - started) : null
  }
}

// ── Selectors and project rules ─────────────────────────────────────────

/** Plans of a coordinator session, newest first. */
export function plansOfSession(plans: Record<string, PlanState>, sessionId: string): PlanState[] {
  return Object.values(plans)
    .filter((plan) => plan.sessionId === sessionId)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function usePlan(planId: string | null | undefined): PlanState | null {
  return useApp((state) => (planId ? (state.plans[planId] ?? null) : null))
}

const settingsCache = new Map<string, ProjectSettings>()

/**
 * Project rules used to validate edits in the card: allowed agents, agents available now, maximum permissions.
 * Null until they are known (or if the host does not answer): local validation then skips the rule checks.
 */
export function usePlanRules(projectId: string, enabled = true): PlanRules | null {
  const [settings, setSettings] = useState<ProjectSettings | null>(() => settingsCache.get(projectId) ?? null)
  const agents = useApp((state) => state.agents)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    request<ProjectSettings>({ type: 'project.settings', projectId })
      .then((data) => {
        settingsCache.set(projectId, data)
        if (!cancelled) setSettings(data)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [projectId, enabled])
  return useMemo(() => {
    if (!settings) return null
    return { allowed: settings.agents.allowed as AgentId[], available: agents.filter((a) => a.available).map((a) => a.agent), permissionsMax: settings.agents.permissionsMax }
  }, [settings, agents])
}

// ── Local checks with translated messages ──────────────────────────────────

export interface PlanProblems {
  byTask: Map<string, string[]>
  general: string[]
  count: number
}

/**
 * Checks on the fields edited in the card, with sentences for you (validatePlan talks to the agent, in English).
 * They cover title, instruction, goal, review return, agents and project permissions.
 */
export function checkPlan(plan: Plan, rules: PlanRules | null): PlanProblems {
  const byTask = new Map<string, string[]>()
  const general: string[] = []
  const add = (id: string, text: string) => byTask.set(id, [...(byTask.get(id) ?? []), text])
  if (!plan.goal.trim()) general.push(t('The goal is empty.'))
  if (plan.tasks.length === 0) general.push(t('The plan has no tasks.'))
  for (const task of plan.tasks) {
    if (!task.title.trim()) add(task.id, t('This task needs a title.'))
    if (!task.instruction.trim()) add(task.id, t('This task needs an instruction for the agent.'))
    if (task.onBlocking && !upstreamOf(plan.tasks, task.id).has(task.onBlocking.backTo)) add(task.id, t('The task it goes back to must run before this review.'))
    if (rules) {
      if (rules.allowed.length && !rules.allowed.includes(task.agent)) add(task.id, t('This agent is not allowed in this project.'))
      else if (!rules.available.includes(task.agent)) add(task.id, t('This agent is not available right now.'))
      if (rules.permissionsMax && permissionRank(task.permission) > permissionRank(rules.permissionsMax)) add(task.id, t('These permissions are above the maximum of this project.'))
    }
  }
  return { byTask, general, count: general.length + [...byTask.values()].reduce((n, list) => n + list.length, 0) }
}

/** Starting name of a template: the part before the colon if it is long enough, otherwise the goal cut at a word boundary. */
export function defaultTemplateName(goal: string, max = 60): string {
  const text = goal.trim()
  const head = text.split(':')[0].trim()
  const base = head.length >= 8 && head.length < text.length ? head : text
  if (base.length <= max) return base
  const cut = base.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}
