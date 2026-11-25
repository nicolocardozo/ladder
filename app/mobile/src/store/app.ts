// Mac data on the phone: projects, sessions, chats. Same style as the desktop (zustand), fed by the channel's events
// (real or demo). Connection state and actions live in src/host.
import { create } from 'zustand'
import type { ChatItem, PermissionLevel, Project, ProjectGroupsState, RemoteAgentStatus, RemoteEvent, RemotePrefs, RemoteProfile, RemoteProjectDefaults, RemoteSnapshot, SessionSummary, SubagentInfo } from '@shared/protocol'
import { applyItemsEvent, mergeById, mergeSnapshotSessions } from '@/lib/items'
import { runWorldReset } from '@/lib/world-reset'
import type { ConnState } from '@/remote/client'

export type Mode = 'none' | 'demo' | 'remote'

export interface AppState {
  mode: Mode
  conn: ConnState
  macName: string | null
  /** Mac theme: the channel will carry it; until then it is null and Circuit applies. */
  macTheme: string | null
  hydrated: boolean
  projects: Project[]
  sessions: Record<string, SessionSummary>
  ui: RemoteSnapshot['ui']
  projectGroups: ProjectGroupsState | null
  agents: RemoteAgentStatus[]
  /** Claude Code and Codex accounts (subscriptions); `AgentStatus.profileId` links them to the status. */
  profiles: RemoteProfile[]
  /** How a new session starts, per project (allowed agents, model and effort chosen by Ladder, permission). */
  defaults: Record<string, RemoteProjectDefaults>
  /** Permission ceiling per project (null = no ceiling), from the snapshot. */
  permissionsMax: Record<string, PermissionLevel | null>
  /** Mac preferences the phone mirrors: what sending to a working session does, and whether Full is allowed from the phone. */
  prefs: RemotePrefs
  items: Record<string, ChatItem[]>
  hasMore: Record<string, boolean>
  /** The session's first page has arrived (the chat can be shown). */
  loaded: Record<string, boolean>
  subagents: Record<string, SubagentInfo[]>
  setMode: (mode: Mode) => void
  setConn: (conn: ConnState) => void
  setMac: (name: string | null, theme?: string | null) => void
  applySnapshot: (snapshot: RemoteSnapshot) => void
  applyEvent: (event: RemoteEvent) => void
  mergeItems: (sessionId: string, items: ChatItem[], opts: { replace?: boolean; hasMore?: boolean }) => void
  setAllowFull: (allowFull: boolean) => void
  /** Archived sessions read from the project screen: they stay in `sessions` (with archived: true) so they can be opened. */
  addArchived: (sessions: SessionSummary[]) => void
  /** Clears the Mac's data (leaving the demo, disconnecting). */
  reset: () => void
  restore: (data: Partial<Pick<AppState, 'projects' | 'sessions' | 'ui' | 'projectGroups' | 'agents' | 'profiles' | 'defaults' | 'items' | 'macName' | 'macTheme' | 'hasMore' | 'permissionsMax' | 'prefs'>>) => void
}

const empty = {
  projects: [] as Project[],
  sessions: {} as Record<string, SessionSummary>,
  ui: {} as RemoteSnapshot['ui'],
  projectGroups: null as ProjectGroupsState | null,
  agents: [] as RemoteAgentStatus[],
  profiles: [] as RemoteProfile[],
  defaults: {} as Record<string, RemoteProjectDefaults>,
  permissionsMax: {} as Record<string, PermissionLevel | null>,
  prefs: { busySend: 'queue', allowFull: true } as RemotePrefs,
  items: {} as Record<string, ChatItem[]>,
  hasMore: {} as Record<string, boolean>,
  loaded: {} as Record<string, boolean>,
  subagents: {} as Record<string, SubagentInfo[]>
}

/** Part of the state that depends on a snapshot (on `hello` and as an event): vanished sessions = their in-memory chat is dropped. */
function snapshotPatch(snap: RemoteSnapshot, previous: Record<string, SessionSummary>, items: Record<string, ChatItem[]>) {
  const sessions = mergeSnapshotSessions(previous, snap.sessions, snap.projects.map((p) => p.id))
  return {
    projects: snap.projects,
    sessions,
    ui: snap.ui,
    projectGroups: snap.projectGroups ?? null,
    agents: snap.agents,
    profiles: snap.profiles ?? [],
    defaults: snap.defaults ?? {},
    permissionsMax: snap.permissionsMax ?? {},
    prefs: snap.prefs ?? { busySend: 'queue', allowFull: true },
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
  applySnapshot: (snap) => set((s) => snapshotPatch(snap, s.sessions, s.items)),
  applyEvent: (event) =>
    set((s) => {
      switch (event.type) {
        case 'snapshot':
          return snapshotPatch(event, s.sessions, s.items)
        case 'remote.prefs':
          return { prefs: event.prefs }
        case 'remote.defaults':
          return { defaults: event.defaults, permissionsMax: event.permissionsMax }
        case 'profile.upsert': {
          const exists = s.profiles.some((p) => p.id === event.profile.id)
          return { profiles: exists ? s.profiles.map((p) => (p.id === event.profile.id ? event.profile : p)) : [...s.profiles, event.profile] }
        }
        case 'profile.removed':
          return { profiles: s.profiles.filter((p) => p.id !== event.profileId) }
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
  setAllowFull: (allowFull) => set((s) => ({ prefs: { ...s.prefs, allowFull } })),
  addArchived: (list) =>
    set((s) => {
      const sessions = { ...s.sessions }
      for (const x of list) if (!sessions[x.id] || sessions[x.id].archived) sessions[x.id] = x
      return { sessions }
    }),
  reset: () => {
    runWorldReset()
    set({ ...empty, macName: null, macTheme: null })
  },
  restore: (data) => set((s) => ({ ...s, ...data, loaded: s.loaded }))
}))

export const sessionList = (state: AppState): SessionSummary[] => Object.values(state.sessions)
