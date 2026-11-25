// Subagents per session: adapters send partial updates, here they are merged into a list for the map.
// They stay in memory: after an app restart the earlier subagents are no longer alive.
import { t } from '@shared/i18n'
import type { SubagentDetail, SubagentInfo } from '@shared/protocol'

/** Subagent tool: id to update its status when the result arrives. */
export type SubagentTool = SubagentDetail['tools'][number] & { id: string }

/** Heavy fields (prompt, report, tools) do not end up in SubagentInfo: they stay on the board and travel only with subagent.detail. */
export type SubagentUpdate = Partial<Omit<SubagentInfo, 'id'>> & {
  id: string
  prompt?: string | null
  report?: string | null
  /** File with the output of a background subagent. */
  outputFile?: string | null
  /** Full text of the Agent's tool_result: the real report of a foreground subagent. */
  result?: string | null
  tool?: SubagentTool
}

export interface SubagentExtra {
  prompt: string | null
  report: string | null
  outputFile: string | null
  result: string | null
  tools: SubagentTool[]
}

const TOOLS_LIMIT = 200
// Safety net: within the turn no agent disappears; finished ones from past turns are removed by turnStarted.
const HARD_LIMIT = 1000
/** Finished ones removed from the list: last SubagentInfo and heavy data remain available (find, subagent.detail). */
const CACHE_LIMIT = 300

export class SubagentBoard {
  private bySession = new Map<string, Map<string, SubagentInfo>>()
  private extras = new Map<string, Map<string, SubagentExtra>>()
  private cache = new Map<string, Map<string, { info: SubagentInfo; extra: SubagentExtra | null }>>()
  /** Start of the last turn opened by the host: finished ones before that moment leave the list at the next turn. */
  private lastTurnStart = new Map<string, number>()
  /** Last update received for each entry: used to spot those left "running" without working. */
  private touched = new Map<string, Map<string, number>>()
  /** Entries closed by the safety net and not by a real outcome: an update brings them back to running, or their end counts. */
  private expired = new Map<string, Set<string>>()

  /** A subagent by id or by the id of the tool row that launched it; if no longer in the list, from the cache of finished ones. */
  find(sessionId: string, id: string): { info: SubagentInfo; extra: SubagentExtra | null } | null {
    const agents = this.bySession.get(sessionId)
    const info = agents?.get(id) ?? (agents ? [...agents.values()].find((a) => a.toolId === id) : undefined)
    if (info) return { info, extra: this.extras.get(sessionId)?.get(info.id) ?? null }
    const cached = this.cache.get(sessionId)
    return cached?.get(id) ?? (cached ? [...cached.values()].find((c) => c.info.toolId === id) : undefined) ?? null
  }

  list(sessionId: string): SubagentInfo[] | undefined {
    const agents = this.bySession.get(sessionId)
    return agents?.size ? [...agents.values()] : undefined
  }

  /** Light counts for the summary. */
  /** `turnActive`: outside a turn no agent is "foreground" (those that continue, as in Codex, count as background). */
  counts(sessionId: string, turnActive: boolean): { total: number; running: number; runningForeground: number; error: number } | undefined {
    const list = this.list(sessionId)
    if (!list) return undefined
    return {
      total: list.length,
      running: list.filter((a) => a.status === 'running').length,
      runningForeground: turnActive ? list.filter((a) => a.status === 'running' && !a.background).length : 0,
      error: list.filter((a) => a.status === 'error').length
    }
  }

  /** Merges an update; true if something changed. */
  update(sessionId: string, update: SubagentUpdate): boolean {
    let agents = this.bySession.get(sessionId)
    if (!agents) {
      agents = new Map()
      this.bySession.set(sessionId, agents)
    }
    const { prompt, report, outputFile, result, tool, ...light } = update
    update = light
    const before = agents.get(update.id)
    const lightKeys = Object.keys(defined(update)).filter((k) => k !== 'id')
    if (!before) {
      // An agent already finished and removed from the list: late heavy data goes to the cache, the rest is ignored.
      const cached = this.cache.get(sessionId)?.get(update.id)
      if (cached && lightKeys.length === 0) {
        cached.extra ??= { prompt: null, report: null, outputFile: null, result: null, tools: [] }
        applyExtra(cached.extra, { prompt, report, outputFile, result, tool })
        return false
      }
      // Light fields on a cached agent (it goes back to work): it re-enters the list with its heavy data.
      if (cached) {
        this.cache.get(sessionId)!.delete(update.id)
        agents.set(update.id, cached.info)
        if (cached.extra) {
          let all = this.extras.get(sessionId)
          if (!all) this.extras.set(sessionId, (all = new Map()))
          all.set(update.id, cached.extra)
        }
        return this.update(sessionId, { ...update, prompt, report, outputFile, result, tool }) || true
      }
      // An entry is born only from a reliable source (launch, task_started, spawn): explicit 'running' status and a title.
      // An unknown id with any field (activity, tool, late outcome) does not create ghost agents.
      if (update.status !== 'running' || !update.title) return false
    }
    this.touch(sessionId, update.id)
    const heavyChanged = this.mergeExtra(sessionId, update.id, { prompt, report, outputFile, result, tool })
    const now = Date.now()
    const next: SubagentInfo = {
      parentId: null,
      title: t('Subagent'),
      kind: null,
      model: null,
      status: 'running',
      startedAt: now,
      endedAt: null,
      activity: null,
      tokens: null,
      toolUses: null,
      background: false,
      ...before,
      ...defined(update),
      id: update.id
    }
    const wasExpired = this.expired.get(sessionId)?.delete(update.id) ?? false
    // A real title stays: only the generic one may be replaced.
    if (before && before.title !== t('Subagent') && update.title !== undefined) next.title = before.title
    if (before && before.status !== 'running' && update.status === undefined) next.status = wasExpired && lightKeys.length > 0 ? 'running' : before.status
    if (next.status !== 'running') {
      next.endedAt ??= now
      next.activity = null
    } else {
      next.endedAt = null
    }
    if (before && same(before, next)) return heavyChanged
    agents.set(update.id, next)
    if (agents.size > HARD_LIMIT) {
      const oldest = [...agents.values()].filter((a) => a.status !== 'running').sort((a, b) => a.startedAt - b.startedAt)[0]
      if (oldest) this.drop(sessionId, oldest.id, true)
    }
    return true
  }

  /**
   * Turn opened by the host: finished ones before the start of the previous turn leave the list (they stay in the cache),
   * those at work and those finished in the turn that is closing stay. Must not be called for implicit turns opened by the adapter.
   */
  turnStarted(sessionId: string): boolean {
    const cutoff = this.lastTurnStart.get(sessionId) ?? 0
    this.lastTurnStart.set(sessionId, Date.now())
    const agents = this.bySession.get(sessionId)
    if (!agents) return false
    let changed = false
    for (const [id, agent] of agents) {
      if (agent.status !== 'running' && (agent.endedAt ?? 0) < cutoff) {
        this.drop(sessionId, id, true)
        changed = true
      }
    }
    return changed
  }

  /** Some subagent of the session is still working (even in the background, with the turn closed). */
  hasRunning(sessionId: string): boolean {
    for (const agent of this.bySession.get(sessionId)?.values() ?? []) if (agent.status === 'running') return true
    return false
  }

  /** The agent stopped (interruption, process closed): those that were working show as stopped. */
  stopRunning(sessionId: string, { foregroundOnly = false } = {}): boolean {
    const agents = this.bySession.get(sessionId)
    if (!agents) return false
    let changed = false
    const now = Date.now()
    for (const agent of agents.values()) {
      if (agent.status !== 'running' || (foregroundOnly && agent.background)) continue
      agent.status = 'stopped'
      agent.endedAt = now
      agent.activity = null
      for (const tool of this.extras.get(sessionId)?.get(agent.id)?.tools ?? []) if (tool.status === 'running') tool.status = 'error'
      changed = true
    }
    return changed
  }

  /**
   * Safety net: entries in progress with no updates for more than `maxAgeMs` show as stopped.
   * Returns the entries as they were before (empty if nothing changed).
   */
  expireStale(sessionId: string, maxAgeMs: number, live: Set<string> | null = null): SubagentInfo[] {
    const agents = this.bySession.get(sessionId)
    if (!agents) return []
    const now = Date.now()
    const expired: SubagentInfo[] = []
    for (const agent of agents.values()) {
      if (agent.status !== 'running' || live?.has(agent.id)) continue
      if (now - (this.touched.get(sessionId)?.get(agent.id) ?? agent.startedAt) < maxAgeMs) continue
      expired.push({ ...agent })
      let ids = this.expired.get(sessionId)
      if (!ids) this.expired.set(sessionId, (ids = new Set()))
      ids.add(agent.id)
      agent.status = 'stopped'
      agent.endedAt = now
      agent.activity = null
      for (const tool of this.extras.get(sessionId)?.get(agent.id)?.tools ?? []) if (tool.status === 'running') tool.status = 'error'
    }
    return expired
  }

  /** The entry was closed by the safety net and no update has touched it yet. */
  wasExpired(sessionId: string, id: string): boolean {
    return this.expired.get(sessionId)?.has(id) ?? false
  }

  private touch(sessionId: string, id: string): void {
    let all = this.touched.get(sessionId)
    if (!all) this.touched.set(sessionId, (all = new Map()))
    all.set(id, Date.now())
  }

  forget(sessionId: string): void {
    this.touched.delete(sessionId)
    this.expired.delete(sessionId)
    this.bySession.delete(sessionId)
    this.extras.delete(sessionId)
    this.cache.delete(sessionId)
    this.lastTurnStart.delete(sessionId)
  }

  private drop(sessionId: string, id: string, keep = false): void {
    const info = this.bySession.get(sessionId)?.get(id)
    const extra = this.extras.get(sessionId)?.get(id) ?? null
    this.bySession.get(sessionId)?.delete(id)
    this.extras.get(sessionId)?.delete(id)
    this.touched.get(sessionId)?.delete(id)
    this.expired.get(sessionId)?.delete(id)
    if (!keep || !info) return
    let cached = this.cache.get(sessionId)
    if (!cached) this.cache.set(sessionId, (cached = new Map()))
    cached.set(id, { info, extra })
    if (cached.size > CACHE_LIMIT) cached.delete(cached.keys().next().value!)
  }

  /** true if report, result or output files changed (the open detail reloads). */
  private mergeExtra(sessionId: string, id: string, patch: Pick<SubagentUpdate, 'prompt' | 'report' | 'outputFile' | 'result' | 'tool'>): boolean {
    let all = this.extras.get(sessionId)
    if (!all) {
      all = new Map()
      this.extras.set(sessionId, all)
    }
    let extra = all.get(id)
    if (!extra) {
      extra = { prompt: null, report: null, outputFile: null, result: null, tools: [] }
      all.set(id, extra)
    }
    return applyExtra(extra, patch)
  }
}

function applyExtra(extra: SubagentExtra, patch: Pick<SubagentUpdate, 'prompt' | 'report' | 'outputFile' | 'result' | 'tool'>): boolean {
  const before = [extra.report, extra.result, extra.outputFile]
  if (patch.prompt !== undefined) extra.prompt = patch.prompt
  if (patch.report !== undefined) extra.report = patch.report
  if (patch.outputFile !== undefined) extra.outputFile = patch.outputFile
  if (patch.result !== undefined) extra.result = patch.result
  if (patch.tool) {
    const known = extra.tools.find((x) => x.id === patch.tool!.id)
    if (known) Object.assign(known, patch.tool, { at: known.at })
    else {
      extra.tools.push(patch.tool)
      if (extra.tools.length > TOOLS_LIMIT) extra.tools.shift()
    }
  }
  return before[0] !== extra.report || before[1] !== extra.result || before[2] !== extra.outputFile
}

function defined(update: SubagentUpdate): Partial<SubagentInfo> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(update)) if (value !== undefined) out[key] = value
  return out as Partial<SubagentInfo>
}

function same(a: SubagentInfo, b: SubagentInfo): boolean {
  return (Object.keys(b) as (keyof SubagentInfo)[]).every((key) => a[key] === b[key])
}
