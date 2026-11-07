// Stato del renderer: copia di ciò che l'host pubblica più lo stato dell'interfaccia (selezione, cartelle aperte).
import { create } from 'zustand'
import { send } from '@/lib/host-client'
import type { AgentStatus, ChatItem, HostEvent, Project, ProjectUiState, SessionSummary } from '@shared/protocol'

export type Selection = { kind: 'new'; projectId: string | null } | { kind: 'session'; projectId: string; sessionId: string }

interface AppState {
  connected: boolean
  projects: Project[]
  sessions: Record<string, SessionSummary>
  items: Record<string, ChatItem[]>
  drafts: Record<string, string>
  ui: Record<string, ProjectUiState>
  agents: AgentStatus[]
  selection: Selection
  expanded: string[]
  /** Primo elemento non letto quando la sessione è stata aperta, per il divisore "Nuovo". */
  firstUnread: Record<string, number | null>
  applyEvent: (event: HostEvent) => void
  select: (selection: Selection) => void
  toggleProject: (projectId: string) => void
  setDraft: (key: string, text: string) => void
  setUi: (projectId: string, state: ProjectUiState) => void
  closeTab: (projectId: string, sessionId: string) => void
  /** Torna su un progetto: riapre la tab attiva che aveva, oppure la nuova chat. */
  selectProject: (projectId: string) => void
}

const MAX_TABS = 8
let uiTimer: number | null = null
function persistUi(projectId: string, state: ProjectUiState): void {
  if (uiTimer) window.clearTimeout(uiTimer)
  uiTimer = window.setTimeout(() => send({ type: 'ui.set', projectId, state }), 300)
}
const emptyUi = (): ProjectUiState => ({ tabs: [], activeTab: null, scroll: {} })

function mergeItems(current: ChatItem[] | undefined, incoming: ChatItem[]): ChatItem[] {
  if (!current || current.length === 0) return [...incoming].sort((a, b) => a.seq - b.seq)
  const byId = new Map(current.map((item) => [item.id, item]))
  let appended = false
  for (const item of incoming) {
    if (!byId.has(item.id)) appended = true
    byId.set(item.id, item)
  }
  const merged = [...byId.values()]
  return appended ? merged.sort((a, b) => a.seq - b.seq) : merged
}

export const useApp = create<AppState>((set) => ({
  connected: false,
  projects: [],
  sessions: {},
  items: {},
  drafts: {},
  ui: {},
  agents: [],
  selection: { kind: 'new', projectId: null },
  expanded: [],
  firstUnread: {},

  applyEvent: (event) =>
    set((state) => {
      switch (event.type) {
        case 'snapshot': {
          const sessions: Record<string, SessionSummary> = {}
          for (const s of event.sessions) sessions[s.id] = s
          const firstProject = event.projects[0]?.id ?? null
          const selection =
            state.selection.kind === 'new' && !state.selection.projectId ? { kind: 'new' as const, projectId: firstProject } : state.selection
          return {
            connected: true,
            projects: event.projects,
            sessions,
            drafts: event.drafts,
            ui: event.ui,
            agents: event.agents,
            selection,
            expanded: state.expanded.length ? state.expanded : firstProject ? [firstProject] : []
          }
        }
        case 'project.upsert': {
          const exists = state.projects.some((p) => p.id === event.project.id)
          return {
            projects: exists ? state.projects.map((p) => (p.id === event.project.id ? event.project : p)) : [...state.projects, event.project]
          }
        }
        case 'project.removed':
          return { projects: state.projects.filter((p) => p.id !== event.projectId) }
        case 'session.upsert':
          return { sessions: { ...state.sessions, [event.session.id]: event.session } }
        case 'session.items':
          return {
            items: {
              ...state.items,
              [event.sessionId]: event.replace ? [...event.items].sort((a, b) => a.seq - b.seq) : mergeItems(state.items[event.sessionId], event.items)
            }
          }
        case 'agent.status':
          return { agents: [...state.agents.filter((a) => a.agent !== event.status.agent), event.status] }
      }
    }),

  select: (selection) =>
    set((state) => {
      if (selection.kind !== 'session') return { selection }
      const session = state.sessions[selection.sessionId]
      const firstUnread = { ...state.firstUnread }
      // Il divisore "Nuovo" si calcola all'apertura e resta fermo finché la sessione è aperta.
      if (session && !(selection.sessionId in firstUnread)) firstUnread[selection.sessionId] = session.unread ? session.lastReadSeq + 1 : null
      const expanded = state.expanded.includes(selection.projectId) ? state.expanded : [...state.expanded, selection.projectId]
      // La sessione aperta diventa una tab del suo progetto; oltre 8 tab si chiude la meno recente.
      const ui = state.ui[selection.projectId] ?? emptyUi()
      let tabs = ui.tabs.includes(selection.sessionId) ? ui.tabs : [...ui.tabs, selection.sessionId]
      if (tabs.length > MAX_TABS) tabs = tabs.slice(tabs.length - MAX_TABS)
      const nextUi = { ...ui, tabs, activeTab: selection.sessionId }
      persistUi(selection.projectId, nextUi)
      return { selection, firstUnread, expanded, ui: { ...state.ui, [selection.projectId]: nextUi } }
    }),

  toggleProject: (projectId) =>
    set((state) => ({
      expanded: state.expanded.includes(projectId) ? state.expanded.filter((id) => id !== projectId) : [...state.expanded, projectId]
    })),

  setDraft: (key, text) => set((state) => ({ drafts: { ...state.drafts, [key]: text } })),
  setUi: (projectId, uiState) => set((state) => ({ ui: { ...state.ui, [projectId]: uiState } })),

  closeTab: (projectId, sessionId) =>
    set((state) => {
      const ui = state.ui[projectId] ?? emptyUi()
      const index = ui.tabs.indexOf(sessionId)
      const tabs = ui.tabs.filter((id) => id !== sessionId)
      const wasActive = state.selection.kind === 'session' && state.selection.sessionId === sessionId
      const nextActive = wasActive ? (tabs[Math.min(index, tabs.length - 1)] ?? null) : ui.activeTab
      const nextUi = { ...ui, tabs, activeTab: nextActive }
      persistUi(projectId, nextUi)
      const selection: Selection = wasActive
        ? nextActive
          ? { kind: 'session', projectId, sessionId: nextActive }
          : { kind: 'new', projectId }
        : state.selection
      return { ui: { ...state.ui, [projectId]: nextUi }, selection }
    }),

  selectProject: (projectId) => {
    const state = useApp.getState()
    const active = state.ui[projectId]?.activeTab
    if (active && state.sessions[active] && !state.sessions[active].archived) state.select({ kind: 'session', projectId, sessionId: active })
    else state.select({ kind: 'new', projectId })
  }
}))
