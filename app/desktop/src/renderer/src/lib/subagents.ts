// Renderer-side subagents: map order, lookup per chat row, detail dialog.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { SubagentDetail, SubagentInfo } from '@shared/protocol'
import { useApp } from '@/store/app-store'
import { onHostConnect, onHostEvent, request } from '@/lib/host-client'

/** Where an agent sits in the map: running, errors (and stopped), completed (closed group). */
export type Bucket = 'running' | 'failed' | 'done'

const RANK: Record<Bucket, number> = { running: 0, failed: 1, done: 2 }

export function bucketOf(agent: SubagentInfo): Bucket {
  if (agent.status === 'running') return 'running'
  if (agent.status === 'error' || agent.status === 'stopped') return 'failed'
  return 'done'
}

export interface AgentNode {
  agent: SubagentInfo
  children: AgentNode[]
  /** The most urgent among the agent and its descendants: a running child keeps the parent among the running agents. */
  bucket: Bucket
}

/** Tree by parent, sorted by section. Agents with an unknown parent or in a cycle become roots. */
export function buildForest(agents: SubagentInfo[]): AgentNode[] {
  const nodes = new Map<string, AgentNode>()
  for (const agent of agents) nodes.set(agent.id, { agent, children: [], bucket: bucketOf(agent) })
  const roots: AgentNode[] = []
  for (const node of nodes.values()) {
    const parent = node.agent.parentId ? nodes.get(node.agent.parentId) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  // A cycle (a is a child of b and b of a) reaches no root: the unreachable ones are recovered.
  const seen = new Set<string>()
  const visit = (node: AgentNode) => {
    if (seen.has(node.agent.id)) return
    seen.add(node.agent.id)
    node.children.forEach(visit)
  }
  roots.forEach(visit)
  for (const node of nodes.values()) {
    if (seen.has(node.agent.id)) continue
    node.children = node.children.filter((c) => !seen.has(c.agent.id))
    roots.push(node)
    visit(node)
  }
  const settle = (node: AgentNode, depth: number): Bucket => {
    let best = node.bucket
    if (depth < 64) for (const child of node.children) if (RANK[settle(child, depth + 1)] < RANK[best]) best = child.bucket
    node.bucket = best
    return best
  }
  for (const root of roots) settle(root, 0)
  const sortChildren = (list: AgentNode[], depth: number) => {
    list.sort((a, b) => a.agent.startedAt - b.agent.startedAt)
    if (depth < 64) for (const n of list) sortChildren(n.children, depth + 1)
  }
  for (const root of roots) sortChildren(root.children, 1)
  roots.sort((a, b) => {
    if (a.bucket !== b.bucket) return RANK[a.bucket] - RANK[b.bucket]
    // Last finished is on top; running and errors in start order.
    if (a.bucket === 'done') return (b.agent.endedAt ?? b.agent.startedAt) - (a.agent.endedAt ?? a.agent.startedAt)
    return a.agent.startedAt - b.agent.startedAt
  })
  return roots
}

/** The agents in map order (section, then parent and children): it is the order of ↑↓ in the dialog. */
export function orderedAgents(forest: AgentNode[]): SubagentInfo[] {
  const out: SubagentInfo[] = []
  const walk = (list: AgentNode[], depth: number) => {
    for (const node of list) {
      out.push(node.agent)
      if (depth < 64) walk(node.children, depth + 1)
    }
  }
  walk(forest, 0)
  return out
}

/** The agent of a 'tool' chat row: by toolId or, for Claude, because the id matches. */
export function findAgentForTool(agents: SubagentInfo[] | undefined, toolId: string): SubagentInfo | null {
  if (!agents?.length) return null
  return agents.find((a) => a.toolId === toolId) ?? agents.find((a) => a.id === toolId) ?? null
}

export function agentElapsed(agent: SubagentInfo, now: number): number {
  return (agent.endedAt ?? (agent.status === 'running' ? now : agent.startedAt)) - agent.startedAt
}

/** What changes about an agent and is worth reloading the detail for. */
export function agentSignature(agent: SubagentInfo | null): string {
  return agent ? [agent.status, agent.endedAt, agent.tokens, agent.toolUses, agent.activity, agent.title, agent.model, agent.effort].join('|') : ''
}

/** Loads the detail from the host. Replaceable: the web preview has no host. */
type DetailLoader = (sessionId: string, id: string) => Promise<SubagentDetail>
let detailLoader: DetailLoader = (sessionId, id) => request<SubagentDetail>({ type: 'subagent.detail', sessionId, id })
export function setSubagentDetailLoader(loader: DetailLoader | null): void {
  detailLoader = loader ?? ((sessionId, id) => request<SubagentDetail>({ type: 'subagent.detail', sessionId, id }))
}
export function loadSubagentDetail(sessionId: string, id: string): Promise<SubagentDetail> {
  return detailLoader(sessionId, id)
}

/** Subagent list per session: it isn't in SessionSummary (which has only counts), it arrives with subagent.list and session.subagents. */
interface ListsState {
  lists: Record<string, SubagentInfo[]>
  set: (sessionId: string, list: SubagentInfo[]) => void
  drop: (sessionId: string) => void
}
export const useSubagentLists = create<ListsState>((set) => ({
  lists: {},
  set: (sessionId, list) => set((s) => ({ lists: { ...s.lists, [sessionId]: list } })),
  drop: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.lists)) return s
      const { [sessionId]: _gone, ...rest } = s.lists
      return { lists: rest }
    })
}))

/** Counts like those in SessionSummary, derived from a list. */
export function countsOf(list: SubagentInfo[]): { total: number; running: number; runningForeground: number; error: number } {
  const running = list.filter((a) => a.status === 'running')
  return { total: list.length, running: running.length, runningForeground: running.filter((a) => !a.background).length, error: list.filter((a) => a.status === 'error').length }
}

const requested = new Set<string>()
/** Asks the host for the list. Errors (host not connected) don't matter: it retries on reconnect. */
export function loadSubagentList(sessionId: string): Promise<void> {
  requested.add(sessionId)
  return request<SubagentInfo[]>({ type: 'subagent.list', sessionId }).then(
    (list) => useSubagentLists.getState().set(sessionId, list),
    () => undefined
  )
}
onHostEvent((event) => {
  if (event.type !== 'session.subagents') return
  // Empty list: the session has no subagents left, no need to reread it on reconnect.
  if (event.subagents.length === 0) {
    requested.delete(event.sessionId)
    useSubagentLists.getState().drop(event.sessionId)
  } else useSubagentLists.getState().set(event.sessionId, event.subagents)
})
// A session leaving the store (removed) takes its list with it.
useApp.subscribe((state, prev) => {
  if (state.sessions === prev.sessions) return
  for (const id of Object.keys(useSubagentLists.getState().lists)) {
    if (!(id in state.sessions) && Object.keys(state.sessions).length > 0) {
      requested.delete(id)
      useSubagentLists.getState().drop(id)
    }
  }
})
// After a reconnect, missed events are recovered by rereading the lists already requested.
onHostConnect(() => {
  for (const sessionId of requested) void loadSubagentList(sessionId)
})

/** The session's list. With `load` it asks the host if it isn't there yet (or on every change of `refresh`). */
export function useSubagentList(sessionId: string, load = true, refresh = 0): SubagentInfo[] | undefined {
  const list = useSubagentLists((s) => s.lists[sessionId])
  const has = list !== undefined
  useEffect(() => {
    if (load && (!has || refresh > 0)) void loadSubagentList(sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, load, refresh])
  return list
}

export interface SubagentHint {
  title: string
  status: SubagentInfo['status']
  startedAt: number
  endedAt: number | null
  /** Model and effort saved on the 'tool' row (ChatItem.agent). */
  agent?: { model: string | null; effort: SubagentInfo['effort'] } | null
}

interface DialogState {
  /** hint: the chat row's data, for when the host no longer knows the agent (old turns). */
  target: { sessionId: string; id: string; hint?: SubagentHint; returnFocus: HTMLElement | null } | null
  /** returnFocus: where to return focus on close; without it, the element that has focus now. */
  open: (sessionId: string, id: string, hint?: SubagentHint, returnFocus?: HTMLElement | null) => void
  /** Switches to another agent within the same dialog (arrows): the return point doesn't change. */
  show: (id: string) => void
  close: () => void
}

/** There is only one detail dialog: the composer popover and the chat rows open it. */
export const useSubagentDialog = create<DialogState>((set) => ({
  target: null,
  open: (sessionId, id, hint, returnFocus) =>
    set({ target: { sessionId, id, hint, returnFocus: returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null) } }),
  show: (id) => set((s) => (s.target ? { target: { ...s.target, id, hint: undefined } } : s)),
  close: () => set({ target: null })
}))
