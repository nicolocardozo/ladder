// Executable plans on the host side: connects the runner (plan-runner.ts, dependency-free) to SQLite, git, the `ladder` MCP server
// and the `plan.*` commands. It has a narrow interface with Host (`PlansDeps`): sessions.ts only provides the hooks.
import { randomUUID } from 'node:crypto'
import { t } from '@shared/i18n'
import type { Plan, PlanRules, PlanState, PlanTask, PlanTemplate } from '@shared/plan'
import type { AgentId, AttentionEvent, HostCommand, HostEvent, Project, SessionSummary } from '@shared/protocol'
import type { Db } from './db'
import { changedFiles, createCheckpoint, git, untrackedLeftOut } from './git'
import type { CheckpointRow } from './db'
import { LadderMcpServer, type LadderTool, type LadderToolsHandle } from './ladder-mcp'
import { applySideChanges } from './plan-git'
import { AGENT_TOOLS, type AgentTool } from './agent-sessions'
import { PlanRunner, type PlanMeta, type RunnerPorts, type TaskSessionSpec } from './plan-runner'
import { restore } from './workspace'

export interface PlansDeps {
  db: Db
  broadcast: (event: HostEvent) => void
  attention: (event: AttentionEvent) => void
  project: (projectId: string) => Project | undefined
  /** The session, if it exists. `chat` is false for terminal sessions. */
  session: (sessionId: string) => { projectId: string; agent: AgentId; archived: boolean; title: string; chat: boolean } | null
  rules: (projectId: string) => Promise<PlanRules>
  createTaskSession: (spec: TaskSessionSpec) => string
  send: (sessionId: string, text: string) => Promise<void>
  interrupt: (sessionId: string) => Promise<void>
  lastAssistantText: (sessionId: string) => string
  /** The plan card in the coordinator's chat (in the current turn, if any). */
  addCard: (sessionId: string, planId: string) => void
  notice: (sessionId: string, text: string) => void
  emitSummary: (sessionId: string) => void
  /** The plan's folder: a new worktree (with copied files and setup) or the main checkout. */
  workspace: (state: PlanState, kind: 'main' | 'worktree') => Promise<NonNullable<PlanState['workspace']>>
  /** Separate worktree started from checkpoint `from`, for a task that writes in parallel. */
  sideWorktree: (state: PlanState, task: PlanTask, from: string) => Promise<{ path: string; branch: string }>
  /** Removes a separate worktree and its branch (the work has already been brought into the plan folder). */
  removeWorktree: (projectId: string, path: string, branch: string) => Promise<void>
  /** Archives the session (its worktree goes away). */
  archiveSession: (sessionId: string) => Promise<void>
  /** `ladder_*` tools (start and wait on other sessions), handled by AgentSessions. */
  agentTool: (sessionId: string, tool: AgentTool, args: unknown, signal: AbortSignal) => Promise<{ text: string; isError: boolean }>
  /** Changes in the folder: the UI re-reads tree and diff. */
  changed: (root: string) => void
}

type PlanCommand = Extract<HostCommand, { type: `plan.${string}` }>

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export class Plans {
  private readonly runner: PlanRunner
  private readonly server: LadderMcpServer
  /** Last `SessionSummary.plan` reference sent per session: the summary is re-emitted only if it changes. */
  private readonly refs = new Map<string, string>()

  constructor(private readonly deps: PlansDeps) {
    this.runner = new PlanRunner(this.ports())
    this.server = new LadderMcpServer({
      role: (sessionId) => {
        const session = deps.session(sessionId)
        if (!session || session.archived || !session.chat) return null
        return this.runner.isTaskSession(sessionId) ? 'task' : 'coordinator'
      },
      call: (sessionId, tool, args, signal) => (AGENT_TOOLS.has(tool) ? deps.agentTool(sessionId, tool as AgentTool, args, signal) : this.call(sessionId, tool, args))
    })
    const rows = deps.db.prepare('select json, meta from plans').all() as { json: string; meta: string }[]
    const items: { state: PlanState; meta: PlanMeta }[] = []
    for (const row of rows) {
      try {
        items.push({ state: JSON.parse(row.json) as PlanState, meta: JSON.parse(row.meta) as PlanMeta })
      } catch {
        // Unreadable row: that plan is not loaded, the others are.
      }
    }
    this.runner.load(items)
  }

  // ── MCP server ───────────────────────────────────────────────────────────

  /** Before a chat's first runtime: the server must already be listening. Null if it already started. */
  prepare(): Promise<void> | null {
    if (this.server.started) return null
    return this.server.start().catch((error: Error) => console.error(`[host] Ladder MCP server: ${error.message}`))
  }

  register(sessionId: string): LadderToolsHandle | null {
    return this.server.register(sessionId)
  }

  revoke(sessionId: string): void {
    this.server.revoke(sessionId)
  }

  async shutdown(): Promise<void> {
    await this.server.close()
  }

  private async call(sessionId: string, tool: LadderTool, args: unknown): Promise<{ text: string; isError: boolean }> {
    if (tool === 'report_result') {
      const answer = this.runner.reportResult(sessionId, args)
      return { text: answer.text, isError: !answer.ok }
    }
    const session = this.deps.session(sessionId)
    if (!session || this.runner.isTaskSession(sessionId)) return { text: 'Plans can only be proposed from the chat where the user talks to you.', isError: true }
    if (tool === 'revise_plan') {
      const input = (args && typeof args === 'object' ? args : {}) as { planId?: unknown; plan?: unknown; reason?: unknown }
      if (typeof input.planId !== 'string') return { text: 'planId is required: use the id returned by propose_plan.', isError: true }
      const answer = await this.runner.revise(sessionId, input.planId, input.plan, typeof input.reason === 'string' ? input.reason : '')
      return { text: answer.text, isError: !answer.ok }
    }
    const proposal = await this.runner.propose(sessionId, session.projectId, session.agent, args)
    if (!proposal.ok) return { text: `The plan is not valid:\n${proposal.errors.map((e) => `- ${e}`).join('\n')}\nFix them and call propose_plan again.`, isError: true }
    this.deps.addCard(sessionId, proposal.state.id)
    return {
      text: `Plan "${proposal.state.id}" was recorded and is shown to the user as a card in this chat, for review. Do not start the work yourself: Ladder runs each task in its own session once the user approves. If the user wants changes they will write to you. End your turn now.`,
      isError: false
    }
  }

  // ── For Host ─────────────────────────────────────────────────────────────

  /** The plan uses this folder (its own or a separate worktree not yet merged back): archiving a session must not close it. */
  usesFolder(path: string): boolean {
    return this.runner.usesFolder(path)
  }

  /** The plan governs the session right now (task in progress). */
  controls(sessionId: string): boolean {
    return this.runner.controls(sessionId)
  }

  isTask(sessionId: string): boolean {
    return this.runner.isTaskSession(sessionId)
  }

  /** Plans of non-archived sessions, without the superseded ones: the UI's initial state. */
  snapshot(): PlanState[] {
    // Superseded plans too: their card stays in the chat and must be able to say how it ended.
    return this.runner.all().filter((s) => this.deps.session(s.sessionId)?.archived === false)
  }

  /** `SessionSummary.plan`: the task the session runs, or the last plan it wrote. */
  refFor(sessionId: string): SessionSummary['plan'] {
    // A retired session (Reassign) keeps its task banner as well.
    const task = this.runner.taskRef(sessionId)
    if (task) return { planId: task.planId, role: 'task', taskId: task.taskId }
    let last: PlanState | null = null
    for (const state of this.runner.all()) if (state.sessionId === sessionId && state.status !== 'superseded' && (!last || state.createdAt > last.createdAt)) last = state
    return last ? { planId: last.id, role: 'coordinator', taskId: null } : null
  }

  /** The coordinator is waiting for you: a plan to approve or paused. */
  waitingFor(sessionId: string): { label: string; since: number } | null {
    let found: { label: string; since: number } | null = null
    for (const state of this.runner.all()) {
      if (state.sessionId !== sessionId) continue
      if (state.status === 'review') found = { label: t('Plan review'), since: state.updatedAt }
      else if (state.status === 'paused' && !found) found = { label: t('Plan paused'), since: state.pause?.at ?? state.updatedAt }
    }
    return found
  }

  /** How many coordinators are waiting for you (for the Dock badge). */
  waitingCount(isIdle: (sessionId: string) => boolean): number {
    const ids = new Set<string>()
    for (const state of this.runner.all()) if ((state.status === 'review' || state.status === 'paused') && isIdle(state.sessionId)) ids.add(state.sessionId)
    return ids.size
  }

  onTurnEnd(sessionId: string, end: { status: 'completed' | 'error' | 'interrupted'; error: string | null }): Promise<void> {
    return this.runner.onTurnEnd(sessionId, end)
  }

  /** A task's session is archived: its turn will never finish. */
  sessionGone(sessionId: string): Promise<void> {
    return this.runner.sessionGone(sessionId)
  }

  userWrote(sessionId: string): void {
    void this.runner.userWrote(sessionId).catch(() => undefined)
  }

  sessionWaiting(sessionId: string, waiting: boolean): void {
    this.runner.sessionWaiting(sessionId, waiting)
  }

  recover(): Promise<void> {
    return this.runner.recover()
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  async handle(command: PlanCommand): Promise<unknown> {
    switch (command.type) {
      case 'plan.get': {
        const state = this.runner.get(command.planId)
        if (!state) throw new Error(t('Plan not found.'))
        return state
      }
      case 'plan.edit':
        return this.runner.edit(command.planId, command.revision, command.plan)
      case 'plan.approve':
        return this.runner.approve(command.planId, command.revision, command.workspace)
      case 'plan.reject':
        return this.runner.reject(command.planId, command.message)
      case 'plan.choose':
        return this.runner.choose(command.planId, command.choice, command.taskId, command.reassign)
      case 'plan.confirmUpdate':
        return this.runner.confirmUpdate(command.planId, command.accept)
      case 'plan.stop':
        return this.runner.stop(command.planId)
      case 'plan.templates':
        return this.templates()
      case 'plan.saveTemplate': {
        const state = this.runner.get(command.planId)
        if (!state) throw new Error(t('Plan not found.'))
        const name = command.name.trim()
        if (!name) throw new Error(t('A template needs a name.'))
        const template: PlanTemplate = { id: randomUUID(), name: clip(name, 80), plan: state.plan, createdAt: Date.now() }
        this.deps.db.prepare('insert into plan_templates (id, name, json, created_at) values (?, ?, ?, ?)').run(template.id, template.name, JSON.stringify(template.plan), template.createdAt)
        return template
      }
      case 'plan.deleteTemplate':
        this.deps.db.prepare('delete from plan_templates where id = ?').run(command.templateId)
        return null
      case 'plan.useTemplate': {
        const session = this.deps.session(command.sessionId)
        if (!session || session.archived || !session.chat) throw new Error(t('Session not found.'))
        const template = this.templates().find((x) => x.id === command.templateId)
        if (!template) throw new Error(t('Template not found.'))
        const goal = command.goal.trim()
        if (!goal) throw new Error(t('Write the goal of the plan first.'))
        const proposal = await this.runner.useTemplate(command.sessionId, session.projectId, session.agent, template.plan, goal)
        if (!proposal.ok) throw new Error(t('The template does not fit this project:\n{errors}', { errors: proposal.errors.join('\n') }))
        this.deps.addCard(command.sessionId, proposal.state.id)
        return proposal.state
      }
    }
  }

  private templates(): PlanTemplate[] {
    const rows = this.deps.db.prepare('select id, name, json, created_at from plan_templates order by created_at desc').all() as { id: string; name: string; json: string; created_at: number }[]
    const out: PlanTemplate[] = []
    for (const row of rows) {
      try {
        out.push({ id: row.id, name: row.name, plan: JSON.parse(row.json) as Plan, createdAt: row.created_at })
      } catch {
        // Unreadable template: not shown.
      }
    }
    return out
  }

  // ── Runner ports ─────────────────────────────────────────────────────────

  private ports(): RunnerPorts {
    const { db } = this.deps
    return {
      now: () => Date.now(),
      uuid: () => randomUUID(),
      t,
      env: (name) => process.env[name],
      rules: (projectId) => this.deps.rules(projectId),
      save: (state, meta) => {
        db.prepare(
          `insert into plans (id, session_id, project_id, status, json, meta, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do update set status = excluded.status, json = excluded.json, meta = excluded.meta, updated_at = excluded.updated_at`
        ).run(state.id, state.sessionId, state.projectId, state.status, JSON.stringify(state), JSON.stringify(meta), state.createdAt, state.updatedAt)
      },
      emit: (state) => {
        this.deps.broadcast({ type: 'plan.updated', plan: state })
        // The coordinator may be waiting; task sessions change only if their plan reference changes.
        this.deps.emitSummary(state.sessionId)
        for (const run of state.runs) {
          if (!run.sessionId) continue
          const key = JSON.stringify(this.refFor(run.sessionId))
          if (this.refs.get(run.sessionId) === key) continue
          this.refs.set(run.sessionId, key)
          this.deps.emitSummary(run.sessionId)
        }
      },
      attention: (state, kind) => {
        const session = this.deps.session(state.sessionId)
        const project = this.deps.project(state.projectId)
        if (!session || !project) return
        if (kind === 'resolved') return this.deps.attention({ kind: 'resolved', sessionId: state.sessionId, itemId: null })
        const title = `${project.name} · ${session.title}`
        if (kind === 'completed') {
          return this.deps.attention({ kind: 'agents', sessionId: state.sessionId, projectId: project.id, projectName: project.name, itemId: `plan:${state.id}`, outcome: 'done', finished: state.runs.length, failed: 0, title, body: t('Plan completed: {goal}', { goal: clip(state.plan.goal, 120) }) })
        }
        const body = state.status === 'review' ? t('Plan to review: {goal}', { goal: clip(state.plan.goal, 120) }) : (state.pause?.message ?? t('The plan is paused.'))
        this.deps.attention({ kind: 'request', sessionId: state.sessionId, projectId: project.id, itemId: `plan:${state.id}`, title, body: clip(body, 200) })
      },
      notice: (sessionId, text) => this.deps.notice(sessionId, text),
      tellAgent: (sessionId, text) => this.deps.send(sessionId, text),
      createSession: async (spec) => this.deps.createTaskSession(spec),
      send: (sessionId, text) => this.deps.send(sessionId, text),
      interrupt: (sessionId) => this.deps.interrupt(sessionId),
      lastAssistantText: (sessionId) => this.deps.lastAssistantText(sessionId),
      createWorkspace: (state, kind) => this.deps.workspace(state, kind),
      snapshot: (cwd, ref) => createCheckpoint(cwd, ref, 'ladder: plan checkpoint'),
      diffstat: async (cwd, from, to) => {
        const files = await changedFiles(cwd, from, to)
        return { added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0), count: files.length, files: files.map((f) => f.path) }
      },
      createSideWorktree: async (state, task, from) => this.deps.sideWorktree(state, task, from),
      applyChanges: async (workspace, side, base, end) => {
        const ref = `refs/ladder/plan/tmp-${randomUUID()}`
        const current = await createCheckpoint(workspace, ref, 'ladder: plan folder before merging a task')
        if (!current) return { ok: false, error: t('The plan folder is not a git repository.') }
        const merged = await applySideChanges(workspace, current, base, end).finally(() => git(workspace, ['update-ref', '-d', ref]).catch(() => undefined))
        if (merged.ok) {
          this.deps.changed(workspace)
          return { ok: true }
        }
        return { ok: false, error: merged.conflicts.length ? t('conflicts in {files}', { files: merged.conflicts.slice(0, 8).join(', ') }) : clip(merged.detail || t('git could not apply them'), 300) }
      },
      saveRef: async (cwd, ref, sha) => {
        await git(cwd, ['update-ref', ref, sha])
      },
      restoreOwn: async (cwd, sha, sessionId, exclude, label) => {
        // Files touched by the session's turns (checkpoints at the start and end of each turn), minus those brought in by other tasks.
        const rows = db.prepare(`select turn_id, kind, sha from checkpoints where session_id = ? and kind in ('start', 'end') order by at`).all(sessionId) as Pick<CheckpointRow, 'turn_id' | 'kind' | 'sha'>[]
        const turns = new Map<string, { start?: string; end?: string }>()
        for (const row of rows) if (row.turn_id) turns.set(row.turn_id, { ...turns.get(row.turn_id), [row.kind]: row.sha })
        const own = new Set<string>()
        for (const { start, end } of turns.values()) {
          if (!start || !end) continue
          for (const file of await changedFiles(cwd, start, end).catch(() => [])) for (const path of file.oldPath ? [file.oldPath, file.path] : [file.path]) own.add(path)
        }
        const paths = [...own].filter((path) => !exclude.includes(path))
        if (paths.length) await restore(db, cwd, sha, paths, label, null)
        this.deps.changed(cwd)
      },
      unsaved: (cwd) => untrackedLeftOut(cwd).catch(() => null),
      removeSideWorktree: async (projectId, path, branch, sessionIds) => {
        // In the background: archiving notifies the plan, which is still working in this call. One at a time: the last one closes the worktree.
        void (async () => {
          for (const sessionId of sessionIds) await this.deps.archiveSession(sessionId).catch(() => undefined)
          await this.deps.removeWorktree(projectId, path, branch)
        })().catch(() => undefined)
      }
    }
  }
}
