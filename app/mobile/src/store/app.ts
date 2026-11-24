// Dati del Mac sul telefono: progetti, sessioni, chat. Stesso stile del desktop (zustand), alimentati dagli eventi del canale
// (reale o demo). Lo stato della connessione e le azioni stanno in src/host.
import { create } from 'zustand'
import type { AgentStatus, ChatItem, PermissionLevel, Project, ProjectGroupsState, RemoteEvent, RemoteSnapshot, SessionSummary, SubagentInfo } from '@shared/protocol'
import { applyItemsEvent, mergeById } from '@/lib/items'
import type { ConnState } from '@/remote/client'

export type Mode = 'none' | 'demo' | 'remote'

export interface AppState {
  mode: Mode
  conn: ConnState
  macName: string | null
  /** Tema del Mac: il canale lo porterà (LAD-52 follow-up); finché è null vale Circuit. */
  macTheme: string | null
  hydrated: boolean
  projects: Project[]
  sessions: Record<string, SessionSummary>
  ui: RemoteSnapshot['ui']
  projectGroups: ProjectGroupsState | null
  agents: AgentStatus[]
  /** Massimo di permesso per progetto (oggi solo nella demo; vedi report). */
  permissionMax: Record<string, PermissionLevel>
  items: Record<string, ChatItem[]>
  hasMore: Record<string, boolean>
  /** La pagina iniziale della sessione è arrivata (la chat si può mostrare). */
  loaded: Record<string, boolean>
  subagents: Record<string, SubagentInfo[]>
  setMode: (mode: Mode) => void
  setConn: (conn: ConnState) => void
  setMac: (name: string | null, theme?: string | null) => void
  applySnapshot: (snapshot: RemoteSnapshot) => void
  applyEvent: (event: RemoteEvent) => void
  mergeItems: (sessionId: string, items: ChatItem[], opts: { replace?: boolean; hasMore?: boolean }) => void
  setPermissionMax: (max: Record<string, PermissionLevel>) => void
  /** Svuota i dati del Mac (uscita dalla demo, scollegamento). */
  reset: () => void
  restore: (data: Partial<Pick<AppState, 'projects' | 'sessions' | 'ui' | 'projectGroups' | 'agents' | 'items' | 'macName' | 'macTheme' | 'hasMore'>>) => void
}

const empty = {
  projects: [] as Project[],
  sessions: {} as Record<string, SessionSummary>,
  ui: {} as RemoteSnapshot['ui'],
  projectGroups: null as ProjectGroupsState | null,
  agents: [] as AgentStatus[],
  permissionMax: {} as Record<string, PermissionLevel>,
  items: {} as Record<string, ChatItem[]>,
  hasMore: {} as Record<string, boolean>,
  loaded: {} as Record<string, boolean>,
  subagents: {} as Record<string, SubagentInfo[]>
}

/** Parte dello stato che dipende da uno snapshot (all'`hello` e come evento): sessioni sparite = chat in memoria via. */
function snapshotPatch(snap: RemoteSnapshot, items: Record<string, ChatItem[]>) {
  const sessions: Record<string, SessionSummary> = {}
  for (const x of snap.sessions) sessions[x.id] = x
  return {
    projects: snap.projects,
    sessions,
    ui: snap.ui,
    projectGroups: snap.projectGroups ?? null,
    agents: snap.agents,
    items: Object.fromEntries(Object.entries(items).filter(([id]) => sessions[id]))
  }
}

export const useApp = create<AppState>((set) => ({
  mode: 'none',
  conn: { kind: 'connecting', since: Date.now() },
  macName: null,
  macTheme: null,
  hydrated: false,
  ...empty,
  setMode: (mode) => set({ mode }),
  setConn: (conn) => set({ conn }),
  setMac: (macName, macTheme) => set((s) => ({ macName, macTheme: macTheme === undefined ? s.macTheme : macTheme })),
  applySnapshot: (snap) => set((s) => snapshotPatch(snap, s.items)),
  applyEvent: (event) =>
    set((s) => {
      switch (event.type) {
        case 'snapshot':
          return snapshotPatch(event, s.items)
        case 'session.upsert': {
          const sessions = { ...s.sessions }
          if (event.session.archived) delete sessions[event.session.id]
          else sessions[event.session.id] = event.session
          return { sessions }
        }
        case 'session.items': {
          const r = applyItemsEvent(s.items[event.sessionId] ?? [], !!s.hasMore[event.sessionId], event.items, event.replace)
          return {
            items: { ...s.items, [event.sessionId]: r.items },
            hasMore: { ...s.hasMore, [event.sessionId]: r.hasMore },
            ...(event.replace ? { loaded: { ...s.loaded, [event.sessionId]: true } } : {})
          }
        }
        case 'session.subagents':
          return { subagents: { ...s.subagents, [event.sessionId]: event.subagents } }
        case 'sessions.autoArchived': {
          const sessions = { ...s.sessions }
          for (const id of event.sessionIds) delete sessions[id]
          return { sessions }
        }
        case 'project.upsert': {
          const exists = s.projects.some((p) => p.id === event.project.id)
          return { projects: exists ? s.projects.map((p) => (p.id === event.project.id ? event.project : p)) : [...s.projects, event.project] }
        }
        case 'project.removed':
          return { projects: s.projects.filter((p) => p.id !== event.projectId) }
        case 'projectGroups.changed':
          return { projectGroups: event.state }
        case 'agent.status': {
          const rest = s.agents.filter((a) => !(a.agent === event.status.agent && a.profileId === event.status.profileId))
          return { agents: [...rest, event.status] }
        }
        default:
          return s
      }
    }),
  mergeItems: (sessionId, items, { replace, hasMore }) =>
    set((s) => ({
      items: { ...s.items, [sessionId]: replace ? mergeById([], items) : mergeById(s.items[sessionId] ?? [], items) },
      ...(hasMore === undefined ? {} : { hasMore: { ...s.hasMore, [sessionId]: hasMore } }),
      loaded: { ...s.loaded, [sessionId]: true }
    })),
  setPermissionMax: (permissionMax) => set({ permissionMax }),
  reset: () => set({ ...empty, macName: null, macTheme: null }),
  restore: (data) => set((s) => ({ ...s, ...data, loaded: s.loaded }))
}))

export const sessionList = (state: AppState): SessionSummary[] => Object.values(state.sessions)
