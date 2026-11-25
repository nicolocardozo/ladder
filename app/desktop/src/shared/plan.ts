// Executable plans. A plan is a plain object: goal, constraints, tasks with who runs them, the order (dependencies),
// permissions, when a task is done, where to stop and when to go back.
// The agent you talk to writes it (the `propose_plan` tool of the Ladder MCP server), you edit it in the card, and Ladder
// validates it with the functions in this file. Claude Code and Codex send the same JSON (same inputSchema), and `validatePlan`
// reduces it to the same normalized shape: two equivalent plans written by different agents produce identical objects.
//
// No dependencies and no path aliases: the file is imported by the host, the renderer and a test script.
import type { AgentId, Effort, PermissionLevel } from './protocol'

// ── Plan ────────────────────────────────────────────────────────────────────

/** Task kind: decides the shape of the expected result (`report_result`) and the instructions given to the executor. */
export type PlanTaskKind = 'plan' | 'implement' | 'review' | 'other'

export interface PlanConstraint {
  text: string
  /** Who wrote it: the agent in the plan or you in the card. */
  by: 'agent' | 'user'
}

export interface PlanTask {
  /** Short, lowercase, dashed: "analysis", "wrapper", "review-1". Unique in the plan. */
  id: string
  /** Readable title, one line. */
  title: string
  /** What the executor must do, in markdown. */
  instruction: string
  kind: PlanTaskKind
  /** Executor. Must be an agent allowed in the project and available. */
  agent: AgentId
  /** null = the agent's default model (per project or global). */
  model: string | null
  effort: Effort | null
  /** 'plan' = read-only. Never above the project maximum (`[agents] permissions_max`). */
  permission: PermissionLevel
  /** Ids of tasks that must be completed first. Empty = starts right away. */
  after: string[]
  /** Completion criterion, if any: "concurrency tests on 401 pass". */
  doneWhen: string | null
  /**
   * Only for kind 'review': with blocking issues in the result it goes back to task `backTo` (which must precede this
   * task in the dependencies) and then runs this review again, at most `max` times (1-5). Beyond that the plan stops and asks you.
   */
  onBlocking: { backTo: string; max: number } | null
}

export interface Plan {
  /** One sentence: what the plan aims to achieve. */
  goal: string
  constraints: PlanConstraint[]
  tasks: PlanTask[]
  /** Stop points: after these tasks the plan pauses until you press "Continue". */
  stopAfter: string[]
}

// ── Limits ──────────────────────────────────────────────────────────────────

export const PLAN_LIMITS = {
  tasks: 20,
  constraints: 30,
  goal: 500,
  title: 120,
  instruction: 8000,
  constraint: 500,
  doneWhen: 500,
  id: 40,
  maxLoops: 5,
  /** Result of a task. */
  summary: 8000,
  listItems: 50,
  itemText: 2000
} as const

const ID_RE = /^[a-z0-9][a-z0-9-]*$/
const LEVELS: PermissionLevel[] = ['plan', 'ask', 'edit', 'full']
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const KINDS: PlanTaskKind[] = ['plan', 'implement', 'review', 'other']

/** Order of the permission levels: for comparisons and for the project maximum. */
export const permissionRank = (level: PermissionLevel): number => LEVELS.indexOf(level)

/** Does the task write files? (Everything except read-only.) Decides folder, worktree and repeatability. */
export const taskWrites = (task: Pick<PlanTask, 'permission'>): boolean => task.permission !== 'plan'

// ── Project rules ───────────────────────────────────────────────────────────

export interface PlanRules {
  /** Agents allowed in the project; empty = all the available ones. */
  allowed: AgentId[]
  /** Agents installed and available right now. */
  available: AgentId[]
  permissionsMax: PermissionLevel | null
}

// ── Validation ──────────────────────────────────────────────────────────────

export type PlanValidation = { ok: true; plan: Plan } | { ok: false; errors: string[] }

const isObj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Single-line text (titles, ids, constraints): whitespace collapsed. */
const line = (value: string): string => value.replace(/\s+/g, ' ').trim()
/** Multi-line text (instructions): line endings unified, trailing spaces removed, at most one blank line in a row. */
const block = (value: string): string =>
  value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** Normalizes an id: lowercase, spaces and underscores become dashes. "Review 1" → "review-1". */
export const normalizeTaskId = (value: string): string =>
  line(value)
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')

/**
 * Validates and normalizes a plan sent by an agent (or edited in the card). It accepts only the shape of the schema
 * (`PLAN_INPUT_SCHEMA`), with defaults for optional fields, and always returns the same shape: fields in a fixed order,
 * cleaned text, `after` without duplicates in the given order, `stopAfter` in task order.
 * Errors are English sentences addressed to the agent (which must fix them and call the tool again), with the field path.
 * No `rules` = no checks on agents and permissions (for example in tests).
 */
export function validatePlan(input: unknown, rules?: PlanRules): PlanValidation {
  const errors: string[] = []
  const err = (path: string, message: string) => errors.length < 30 && errors.push(`${path}: ${message}`)

  const str = (value: unknown, path: string, max: number, opts: { multiline?: boolean; optional?: boolean } = {}): string | null => {
    if (value === undefined || value === null) {
      if (!opts.optional) err(path, 'is required')
      return null
    }
    if (typeof value !== 'string') {
      err(path, 'must be a string')
      return null
    }
    const text = opts.multiline ? block(value) : line(value)
    if (!text) {
      if (!opts.optional) err(path, 'must not be empty')
      return null
    }
    if (text.length > max) err(path, `is too long (max ${max} characters)`)
    return text.slice(0, max)
  }

  if (!isObj(input)) return { ok: false, errors: ['plan: must be an object with goal, tasks and optional constraints and stopAfter'] }
  const known = new Set(['goal', 'constraints', 'tasks', 'stopAfter'])
  for (const key of Object.keys(input)) if (!known.has(key)) err(key, 'unknown field')

  const goal = str(input.goal, 'goal', PLAN_LIMITS.goal) ?? ''

  const constraints: PlanConstraint[] = []
  if (input.constraints !== undefined) {
    if (!Array.isArray(input.constraints)) err('constraints', 'must be a list')
    else {
      if (input.constraints.length > PLAN_LIMITS.constraints) err('constraints', `too many (max ${PLAN_LIMITS.constraints})`)
      input.constraints.slice(0, PLAN_LIMITS.constraints).forEach((raw, i) => {
        // The agent sends a string; the card (user edit) sends an object with `by`.
        const text = str(isObj(raw) ? raw.text : raw, `constraints[${i}]`, PLAN_LIMITS.constraint)
        const by = isObj(raw) && raw.by === 'user' ? 'user' : 'agent'
        if (text && !constraints.some((c) => c.text === text)) constraints.push({ text, by })
      })
    }
  }

  const tasks: PlanTask[] = []
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) err('tasks', 'must be a non-empty list')
  else {
    if (input.tasks.length > PLAN_LIMITS.tasks) err('tasks', `too many (max ${PLAN_LIMITS.tasks})`)
    const taskKeys = new Set(['id', 'title', 'instruction', 'kind', 'agent', 'model', 'effort', 'permission', 'after', 'doneWhen', 'onBlocking'])
    input.tasks.slice(0, PLAN_LIMITS.tasks).forEach((raw, i) => {
      const at = `tasks[${i}]`
      if (!isObj(raw)) return err(at, 'must be an object')
      for (const key of Object.keys(raw)) if (!taskKeys.has(key)) err(`${at}.${key}`, 'unknown field')
      const rawId = str(raw.id, `${at}.id`, PLAN_LIMITS.id)
      const id = rawId ? normalizeTaskId(rawId) : ''
      if (rawId && !ID_RE.test(id)) err(`${at}.id`, 'use lowercase letters, digits and dashes, like "review-1"')
      if (id && tasks.some((t) => t.id === id)) err(`${at}.id`, `duplicate id "${id}"`)
      const kind = raw.kind === undefined ? 'other' : raw.kind
      if (!KINDS.includes(kind as PlanTaskKind)) err(`${at}.kind`, `must be one of ${KINDS.join(', ')}`)
      const agent = str(raw.agent, `${at}.agent`, 80) ?? ''
      if (agent && agent !== 'claude-code' && agent !== 'codex' && !/^acp:[a-z0-9._-]+$/i.test(agent)) err(`${at}.agent`, 'must be "claude-code", "codex" or "acp:<id>"')
      const model = str(raw.model, `${at}.model`, 120, { optional: true })
      let effort: Effort | null = null
      if (raw.effort !== undefined && raw.effort !== null) {
        if (EFFORTS.includes(raw.effort as Effort)) effort = raw.effort as Effort
        else err(`${at}.effort`, `must be one of ${EFFORTS.join(', ')} or null`)
      }
      // Default: reviews and plans are read-only, everything else edits the workspace.
      const permission = raw.permission === undefined ? (kind === 'review' || kind === 'plan' ? 'plan' : 'edit') : raw.permission
      if (!LEVELS.includes(permission as PermissionLevel)) err(`${at}.permission`, `must be one of ${LEVELS.join(', ')} ("plan" is read-only)`)
      const after: string[] = []
      if (raw.after !== undefined && raw.after !== null) {
        if (!Array.isArray(raw.after)) err(`${at}.after`, 'must be a list of task ids')
        else
          for (const dep of raw.after) {
            if (typeof dep !== 'string') err(`${at}.after`, 'must be a list of task ids')
            else {
              const depId = normalizeTaskId(dep)
              if (depId && !after.includes(depId)) after.push(depId)
            }
          }
      }
      let onBlocking: PlanTask['onBlocking'] = null
      if (raw.onBlocking !== undefined && raw.onBlocking !== null) {
        if (!isObj(raw.onBlocking) || typeof raw.onBlocking.backTo !== 'string') err(`${at}.onBlocking`, 'must be { backTo: taskId, max: 1-5 } or null')
        else {
          const max = raw.onBlocking.max === undefined ? 2 : raw.onBlocking.max
          if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > PLAN_LIMITS.maxLoops) err(`${at}.onBlocking.max`, `must be an integer from 1 to ${PLAN_LIMITS.maxLoops}`)
          onBlocking = { backTo: normalizeTaskId(raw.onBlocking.backTo), max: typeof max === 'number' ? max : 2 }
        }
      }
      tasks.push({
        id,
        title: str(raw.title, `${at}.title`, PLAN_LIMITS.title) ?? '',
        instruction: str(raw.instruction, `${at}.instruction`, PLAN_LIMITS.instruction, { multiline: true }) ?? '',
        kind: kind as PlanTaskKind,
        agent: agent as AgentId,
        model: model ?? null,
        effort,
        permission: permission as PermissionLevel,
        after,
        doneWhen: str(raw.doneWhen, `${at}.doneWhen`, PLAN_LIMITS.doneWhen, { optional: true }),
        onBlocking
      })
    })
  }

  // References between tasks: dependencies must exist, no cycles, loop-backs only to an upstream task.
  const ids = new Set(tasks.map((t) => t.id))
  tasks.forEach((task, i) => {
    for (const dep of task.after) {
      if (dep === task.id) err(`tasks[${i}].after`, 'a task cannot depend on itself')
      else if (!ids.has(dep)) err(`tasks[${i}].after`, `unknown task "${dep}"`)
    }
  })
  const cycle = findCycle(tasks)
  if (cycle) err('tasks', `circular dependency: ${cycle.join(' → ')}`)
  tasks.forEach((task, i) => {
    if (!task.onBlocking) return
    if (task.kind !== 'review') err(`tasks[${i}].onBlocking`, 'only review tasks can loop back')
    else if (!ids.has(task.onBlocking.backTo)) err(`tasks[${i}].onBlocking.backTo`, `unknown task "${task.onBlocking.backTo}"`)
    else if (!cycle && !upstreamOf(tasks, task.id).has(task.onBlocking.backTo)) err(`tasks[${i}].onBlocking.backTo`, `"${task.onBlocking.backTo}" must come before this review (list it in after, directly or indirectly)`)
  })

  const stopAfter: string[] = []
  if (input.stopAfter !== undefined && input.stopAfter !== null) {
    if (!Array.isArray(input.stopAfter)) err('stopAfter', 'must be a list of task ids')
    else
      for (const raw of input.stopAfter) {
        const id = typeof raw === 'string' ? normalizeTaskId(raw) : ''
        if (!id || !ids.has(id)) err('stopAfter', `unknown task "${String(raw)}"`)
        else if (!stopAfter.includes(id)) stopAfter.push(id)
      }
  }

  if (rules) {
    tasks.forEach((task, i) => {
      if (!task.agent) return
      if (rules.allowed.length && !rules.allowed.includes(task.agent)) err(`tasks[${i}].agent`, `"${task.agent}" is not allowed in this project (allowed: ${rules.allowed.join(', ')})`)
      else if (!rules.available.includes(task.agent)) err(`tasks[${i}].agent`, `"${task.agent}" is not available (available: ${rules.available.join(', ') || 'none'})`)
      if (rules.permissionsMax && LEVELS.includes(task.permission) && permissionRank(task.permission) > permissionRank(rules.permissionsMax))
        err(`tasks[${i}].permission`, `"${task.permission}" exceeds the project maximum "${rules.permissionsMax}"`)
    })
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, plan: { goal, constraints, tasks, stopAfter: tasks.map((t) => t.id).filter((id) => stopAfter.includes(id)) } }
}

/** First cycle found in the dependencies (ids in order, with the first repeated at the end), or null. */
function findCycle(tasks: PlanTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 1)
    stack.push(id)
    for (const dep of byId.get(id)?.after ?? []) {
      if (!byId.has(dep)) continue
      const found = visit(dep)
      if (found) return found
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const task of tasks) {
    const found = visit(task.id)
    if (found) return found.reverse()
  }
  return null
}

/** All the tasks `id` depends on, directly or not. */
export function upstreamOf(tasks: Pick<PlanTask, 'id' | 'after'>[], id: string): Set<string> {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const seen = new Set<string>()
  const walk = (current: string) => {
    for (const dep of byId.get(current)?.after ?? []) {
      if (seen.has(dep)) continue
      seen.add(dep)
      walk(dep)
    }
  }
  walk(id)
  return seen
}

/** All the tasks that depend on `id`, directly or not. */
export function downstreamOf(tasks: Pick<PlanTask, 'id' | 'after'>[], id: string): Set<string> {
  const seen = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const task of tasks) {
      if (seen.has(task.id)) continue
      if (task.after.some((dep) => dep === id || seen.has(dep))) {
        seen.add(task.id)
        grew = true
      }
    }
  }
  return seen
}

// ── Task result (report_result) ────────────────────────────────────────────

export interface PlanCheck {
  /** Command run: "pnpm vitest run src/lib". */
  cmd: string
  exit: number | null
  summary: string
}

export interface PlanIssue {
  severity: 'blocking' | 'minor'
  file: string | null
  line: number | null
  text: string
}

export interface TaskResult {
  /** done: task completed. blocked: cannot be finished without a decision from you. failed: did not succeed. */
  status: 'done' | 'blocked' | 'failed'
  summary: string
  decisions: string[]
  /** Deviations from the plan or the instruction. */
  deviations: string[]
  checks: PlanCheck[]
  /** Problems found (mostly by reviews). */
  issues: PlanIssue[]
  /** Open questions and risks. */
  questions: string[]
  /** Commands with effects outside the folder already run (installs, migrations): not to be repeated. */
  sideEffects: string[]
  /** Review only: approved without blocking issues? Also derived from `issues`. */
  verdict: 'approved' | 'changes-requested' | null
}

export type ResultValidation = { ok: true; result: TaskResult } | { ok: false; errors: string[] }

/** Validates and normalizes the `report_result` result. A review with blocking issues always has verdict 'changes-requested'. */
export function validateResult(input: unknown, kind: PlanTaskKind): ResultValidation {
  const errors: string[] = []
  const err = (path: string, message: string) => errors.length < 30 && errors.push(`${path}: ${message}`)
  if (!isObj(input)) return { ok: false, errors: ['result: must be an object'] }
  const status = input.status
  if (status !== 'done' && status !== 'blocked' && status !== 'failed') err('status', 'must be "done", "blocked" or "failed"')
  const summary = typeof input.summary === 'string' ? block(input.summary).slice(0, PLAN_LIMITS.summary) : ''
  if (!summary) err('summary', 'is required')
  const texts = (key: string): string[] => {
    const raw = input[key]
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
      err(key, 'must be a list of strings')
      return []
    }
    return (raw as string[]).map((x) => line(x).slice(0, PLAN_LIMITS.itemText)).filter(Boolean).slice(0, PLAN_LIMITS.listItems)
  }
  const checks: PlanCheck[] = []
  if (Array.isArray(input.checks)) {
    input.checks.slice(0, PLAN_LIMITS.listItems).forEach((raw, i) => {
      if (!isObj(raw) || typeof raw.cmd !== 'string') return err(`checks[${i}]`, 'must be { cmd, exit, summary }')
      checks.push({ cmd: line(raw.cmd).slice(0, 500), exit: typeof raw.exit === 'number' && Number.isInteger(raw.exit) ? raw.exit : null, summary: typeof raw.summary === 'string' ? line(raw.summary).slice(0, PLAN_LIMITS.itemText) : '' })
    })
  } else if (input.checks !== undefined && input.checks !== null) err('checks', 'must be a list')
  const issues: PlanIssue[] = []
  if (Array.isArray(input.issues)) {
    input.issues.slice(0, PLAN_LIMITS.listItems).forEach((raw, i) => {
      if (!isObj(raw) || typeof raw.text !== 'string' || !line(raw.text)) return err(`issues[${i}]`, 'must be { severity, file, line, text }')
      if (raw.severity !== 'blocking' && raw.severity !== 'minor') return err(`issues[${i}].severity`, 'must be "blocking" or "minor"')
      issues.push({
        severity: raw.severity,
        file: typeof raw.file === 'string' && line(raw.file) ? line(raw.file).slice(0, 500) : null,
        line: typeof raw.line === 'number' && Number.isInteger(raw.line) && raw.line > 0 ? raw.line : null,
        text: line(raw.text).slice(0, PLAN_LIMITS.itemText)
      })
    })
  } else if (input.issues !== undefined && input.issues !== null) err('issues', 'must be a list')
  const decisions = texts('decisions')
  const deviations = texts('deviations')
  const questions = texts('questions')
  const sideEffects = texts('sideEffects')
  if (errors.length) return { ok: false, errors }
  const blocking = issues.some((i) => i.severity === 'blocking')
  const verdict: TaskResult['verdict'] = kind !== 'review' ? null : blocking || input.verdict === 'changes-requested' ? 'changes-requested' : 'approved'
  return { ok: true, result: { status: status as TaskResult['status'], summary, decisions, deviations, checks, issues, questions, sideEffects, verdict } }
}

// ── Execution state ─────────────────────────────────────────────────────────

/**
 * Plan state:
 * - review: proposed (or edited by the agent), waiting for your approval in the card.
 * - running: approved, Ladder runs the tasks.
 * - paused: stopped and waiting for you; the reason is in `PlanState.pause`.
 * - completed: all tasks completed or skipped.
 * - stopped: stopped by you (or rejected in review). No task restarts.
 * - superseded: replaced by a newer plan of the same session before approval.
 */
export type PlanStatus = 'review' | 'running' | 'paused' | 'completed' | 'stopped' | 'superseded'

/**
 * Task state:
 * - pending: waiting for dependencies (or the plan has not started yet).
 * - queued: ready but the folder is held by another writing task ("Queued: folder in use by …").
 * - running: its session is working (even if waiting for your approval: see `waiting`).
 * - completed: closed with report_result status 'done'.
 * - failed: turn error, 'failed' or missing result, conflict applying the changes.
 * - blocked: 'blocked' result (needs a decision from you) or loop-backs exhausted.
 * - interrupted: stopped by you or by a Ladder restart midway.
 * - skipped: skipped by you.
 */
export type PlanTaskStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'interrupted' | 'skipped'

export interface PlanTaskRun {
  taskId: string
  status: PlanTaskStatus
  /** Ladder session in which the task runs (or ran); null if it never started. A loop-back reuses the same session. */
  sessionId: string | null
  /** Actual executor (changes with "Reassign"). */
  agent: AgentId
  model: string | null
  effort: Effort | null
  /** Round: 1 the first time, +1 on each loop-back from a review. */
  iteration: number
  /** Attempt within the round: +1 on each "Retry" or "Reassign". */
  attempt: number
  /** Folder it works in: the plan's own or a separate worktree (tasks writing in parallel). */
  cwd: string | null
  /** The task's separate worktree, if any (its changes return to the plan folder at the end). */
  worktree: string | null
  startedAt: number | null
  endedAt: number | null
  /** Last valid result. */
  result: TaskResult | null
  /** Readable error (already translated) if failed, blocked or interrupted. */
  error: string | null
  /** Why it is queued: title of the task holding the folder. */
  queuedBehind: string | null
  /** Its session is waiting for an answer from you (approval or question). */
  waiting: boolean
  /** Files changed by the task (since the last round): for the summary. */
  files: { added: number; removed: number; count: number } | null
}

/** Actions the card offers when the plan is paused. */
export type PlanChoice = 'continue' | 'retry' | 'reassign' | 'skip' | 'stop'

export interface PlanPause {
  /**
   * stop-point: a task in `stopAfter` completed. failed / blocked / interrupted: a task stopped.
   * loops-exhausted: the review still has blocking issues after `max` loop-backs. restart: Ladder was closed midway.
   * confirm-update: the agent asked via update_plan for an executor or permission change, to be confirmed.
   */
  reason: 'stop-point' | 'failed' | 'blocked' | 'interrupted' | 'loops-exhausted' | 'restart' | 'confirm-update'
  /** Task that caused the pause. */
  taskId: string | null
  /** Already translated text for the card. */
  message: string
  /** Actions to show, in order. */
  choices: PlanChoice[]
  at: number
}

export interface PlanState {
  id: string
  /** Session in which the plan was written (the "coordinator"): the card lives in its chat. */
  sessionId: string
  projectId: string
  status: PlanStatus
  /** Version: +1 on each edit (yours or the agent's). The UI sends it back with plan.edit/plan.approve to avoid overwriting a newer version. */
  revision: number
  plan: Plan
  /** Agent that wrote it. */
  author: AgentId
  /** Last edit proposed by the agent with update_plan, if any: the reason the agent gave. */
  updateReason: string | null
  /** Agent edit waiting for confirmation (changes executors or permissions of a running plan); null if none. */
  pendingUpdate: Plan | null
  runs: PlanTaskRun[]
  pause: PlanPause | null
  /** Where the tasks write: main checkout or the plan's worktree. Chosen at approval. */
  workspace: { kind: 'main' | 'worktree'; path: string; branch: string | null; base: string | null } | null
  createdAt: number
  updatedAt: number
  approvedAt: number | null
  endedAt: number | null
}

/** Saved plan template: the plan without state, to reuse with a new goal. */
export interface PlanTemplate {
  id: string
  name: string
  plan: Plan
  createdAt: number
}

/** Tasks ready to start: pending, with all dependencies completed or skipped. */
export function readyTasks(state: Pick<PlanState, 'plan' | 'runs'>): PlanTask[] {
  const run = new Map(state.runs.map((r) => [r.taskId, r]))
  return state.plan.tasks.filter((task) => {
    if (run.get(task.id)?.status !== 'pending') return false
    return task.after.every((dep) => {
      const s = run.get(dep)?.status
      return s === 'completed' || s === 'skipped'
    })
  })
}

// ── JSON schema of the tools (MCP inputSchema) ──────────────────────────────
// The same schema for Claude Code, Codex and ACP: it is what makes the plans of different agents identical.

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'instruction', 'kind', 'agent', 'permission'],
  properties: {
    id: { type: 'string', maxLength: PLAN_LIMITS.id, description: 'Short unique id: lowercase letters, digits and dashes, like "wrapper" or "review-1".' },
    title: { type: 'string', maxLength: PLAN_LIMITS.title, description: 'One-line title shown to the user.' },
    instruction: { type: 'string', maxLength: PLAN_LIMITS.instruction, description: 'What the executor must do, in markdown. The executor also receives the goal, the constraints and the results of earlier tasks.' },
    kind: { type: 'string', enum: KINDS, description: '"plan": research and write a plan. "implement": change code. "review": read-only review of the changes. "other": anything else.' },
    agent: { type: 'string', description: 'Executor: "claude-code", "codex" or "acp:<id>". Use only agents the user asked for or that are available.' },
    model: { type: ['string', 'null'], description: 'Model id, or null for the agent default.' },
    effort: { type: ['string', 'null'], enum: [...EFFORTS, null], description: 'Reasoning effort, or null for the default.' },
    permission: { type: 'string', enum: LEVELS, description: '"plan" = read-only, "ask" = asks before changes, "edit" = edits files in the workspace, "full" = no approvals. Use the lowest that works.' },
    after: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks that must finish first. Tasks without dependencies between them may run in parallel.' },
    doneWhen: { type: ['string', 'null'], maxLength: PLAN_LIMITS.doneWhen, description: 'Acceptance criterion, like "concurrency tests on 401 pass".' },
    onBlocking: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['backTo'],
      properties: { backTo: { type: 'string', description: 'Earlier task to send blocking issues back to.' }, max: { type: 'integer', minimum: 1, maximum: PLAN_LIMITS.maxLoops, description: 'Max round trips (default 2).' } },
      description: 'Review tasks only: when the review finds blocking issues, rerun backTo with the issues, then this review again.'
    }
  }
} as const

export const PLAN_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'tasks'],
  properties: {
    goal: { type: 'string', maxLength: PLAN_LIMITS.goal, description: 'One sentence: what the plan achieves.' },
    constraints: { type: 'array', maxItems: PLAN_LIMITS.constraints, items: { type: 'string', maxLength: PLAN_LIMITS.constraint }, description: 'Rules every task must respect, like "do not touch src/legacy/".' },
    tasks: { type: 'array', minItems: 1, maxItems: PLAN_LIMITS.tasks, items: TASK_SCHEMA, description: 'Tasks in order. Each one runs in its own agent session.' },
    stopAfter: { type: 'array', items: { type: 'string' }, description: 'Task ids after which Ladder pauses for the user before going on.' }
  }
} as const

export const RESULT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'failed'], description: '"done" when the task is complete, "blocked" when you need a decision from the user, "failed" when it cannot be done.' },
    summary: { type: 'string', maxLength: PLAN_LIMITS.summary, description: 'What you did and the outcome, in markdown. For a plan task: the plan with steps and acceptance criteria.' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions taken that later tasks must respect.' },
    deviations: { type: 'array', items: { type: 'string' }, description: 'Where you departed from the instruction, and why.' },
    checks: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['cmd'], properties: { cmd: { type: 'string' }, exit: { type: ['integer', 'null'] }, summary: { type: 'string' } } },
      description: 'Checks you ran (tests, typecheck, lint) with exit code and a short outcome.'
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'text'],
        properties: { severity: { type: 'string', enum: ['blocking', 'minor'] }, file: { type: ['string', 'null'] }, line: { type: ['integer', 'null'] }, text: { type: 'string' } }
      },
      description: 'Problems found. Reviews: "blocking" sends the work back when the plan allows it.'
    },
    questions: { type: 'array', items: { type: 'string' }, description: 'Open questions and risks.' },
    sideEffects: { type: 'array', items: { type: 'string' }, description: 'Commands with effects outside the folder already run (installs, migrations, pushes) that must not be repeated.' },
    verdict: { type: ['string', 'null'], enum: ['approved', 'changes-requested', null], description: 'Review tasks only.' }
  }
} as const
