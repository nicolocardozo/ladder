// Sotto-agenti lato renderer: ordine della mappa, ricerca per riga di chat, dialogo di dettaglio.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { SubagentDetail, SubagentInfo } from '@shared/protocol'
import { useApp } from '@/store/app-store'
import { onHostConnect, onHostEvent, request } from '@/lib/host-client'

/** Dove sta un agente nella mappa: in corso, errori (e fermati), completati (gruppo chiuso). */
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
  /** Il più urgente fra l'agente e i suoi discendenti: un figlio in corso tiene il genitore fra gli agenti in corso. */
  bucket: Bucket
}

/** Albero per genitore, ordinato per sezione. Gli agenti con un genitore sconosciuto o in un ciclo diventano radici. */
export function buildForest(agents: SubagentInfo[]): AgentNode[] {
  const nodes = new Map<string, AgentNode>()
  for (const agent of agents) nodes.set(agent.id, { agent, children: [], bucket: bucketOf(agent) })
  const roots: AgentNode[] = []
  for (const node of nodes.values()) {
    const parent = node.agent.parentId ? nodes.get(node.agent.parentId) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  // Un ciclo (a è figlio di b e b di a) non arriva a nessuna radice: si recuperano gli irraggiungibili.
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
    // Chi è finito per ultimo sta in alto; in corso ed errori nell'ordine di partenza.
    if (a.bucket === 'done') return (b.agent.endedAt ?? b.agent.startedAt) - (a.agent.endedAt ?? a.agent.startedAt)
    return a.agent.startedAt - b.agent.startedAt
  })
  return roots
}

/** Gli agenti nell'ordine della mappa (sezione, poi genitore e figli): è l'ordine di ↑↓ nel dialogo. */
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

/** L'agente di una riga di chat 'tool': per toolId o, per Claude, perché l'id coincide. */
export function findAgentForTool(agents: SubagentInfo[] | undefined, toolId: string): SubagentInfo | null {
  if (!agents?.length) return null
  return agents.find((a) => a.toolId === toolId) ?? agents.find((a) => a.id === toolId) ?? null
}

export function agentElapsed(agent: SubagentInfo, now: number): number {
  return (agent.endedAt ?? (agent.status === 'running' ? now : agent.startedAt)) - agent.startedAt
}

/** Cosa cambia di un agente e merita di ricaricare il dettaglio. */
export function agentSignature(agent: SubagentInfo | null): string {
  return agent ? [agent.status, agent.endedAt, agent.tokens, agent.toolUses, agent.activity, agent.title, agent.model, agent.effort].join('|') : ''
}

/** Carica il dettaglio dall'host. Sostituibile: l'anteprima web non ha un host. */
type DetailLoader = (sessionId: string, id: string) => Promise<SubagentDetail>
let detailLoader: DetailLoader = (sessionId, id) => request<SubagentDetail>({ type: 'subagent.detail', sessionId, id })
export function setSubagentDetailLoader(loader: DetailLoader | null): void {
  detailLoader = loader ?? ((sessionId, id) => request<SubagentDetail>({ type: 'subagent.detail', sessionId, id }))
}
export function loadSubagentDetail(sessionId: string, id: string): Promise<SubagentDetail> {
  return detailLoader(sessionId, id)
}

/** Elenco dei sotto-agenti per sessione: non sta nel SessionSummary (ci sono solo i conteggi), arriva con subagent.list e session.subagents. */
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

/** Conteggi come quelli del SessionSummary, ricavati da un elenco. */
export function countsOf(list: SubagentInfo[]): { total: number; running: number; runningForeground: number; error: number } {
  const running = list.filter((a) => a.status === 'running')
  return { total: list.length, running: running.length, runningForeground: running.filter((a) => !a.background).length, error: list.filter((a) => a.status === 'error').length }
}

const requested = new Set<string>()
/** Chiede l'elenco all'host. Gli errori (host non connesso) non contano: si riprova alla riconnessione. */
export function loadSubagentList(sessionId: string): Promise<void> {
  requested.add(sessionId)
  return request<SubagentInfo[]>({ type: 'subagent.list', sessionId }).then(
    (list) => useSubagentLists.getState().set(sessionId, list),
    () => undefined
  )
}
onHostEvent((event) => {
  if (event.type !== 'session.subagents') return
  // Elenco vuoto: la sessione non ha più sotto-agenti, non serve rileggerla alla riconnessione.
  if (event.subagents.length === 0) {
    requested.delete(event.sessionId)
    useSubagentLists.getState().drop(event.sessionId)
  } else useSubagentLists.getState().set(event.sessionId, event.subagents)
})
// Una sessione che esce dallo store (rimossa) porta via il suo elenco.
useApp.subscribe((state, prev) => {
  if (state.sessions === prev.sessions) return
  for (const id of Object.keys(useSubagentLists.getState().lists)) {
    if (!(id in state.sessions) && Object.keys(state.sessions).length > 0) {
      requested.delete(id)
      useSubagentLists.getState().drop(id)
    }
  }
})
// Dopo una riconnessione gli eventi persi si recuperano rileggendo gli elenchi già richiesti.
onHostConnect(() => {
  for (const sessionId of requested) void loadSubagentList(sessionId)
})

/** L'elenco della sessione. Con `load` lo chiede all'host se non c'è ancora (o a ogni cambio di `refresh`). */
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
  /** Modello ed effort salvati sulla riga 'tool' (ChatItem.agent). */
  agent?: { model: string | null; effort: SubagentInfo['effort'] } | null
}

interface DialogState {
  /** hint: i dati della riga di chat, per quando l'host non conosce più l'agente (turni vecchi). */
  target: { sessionId: string; id: string; hint?: SubagentHint; returnFocus: HTMLElement | null } | null
  /** returnFocus: dove riportare il focus alla chiusura; senza, l'elemento che ha il focus adesso. */
  open: (sessionId: string, id: string, hint?: SubagentHint, returnFocus?: HTMLElement | null) => void
  /** Passa a un altro agente restando nello stesso dialogo (frecce): il punto di ritorno non cambia. */
  show: (id: string) => void
  close: () => void
}

/** Il dialogo di dettaglio è uno solo: lo aprono il popover del composer e le righe della chat. */
export const useSubagentDialog = create<DialogState>((set) => ({
  target: null,
  open: (sessionId, id, hint, returnFocus) =>
    set({ target: { sessionId, id, hint, returnFocus: returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null) } }),
  show: (id) => set((s) => (s.target ? { target: { ...s.target, id, hint: undefined } } : s)),
  close: () => set({ target: null })
}))
