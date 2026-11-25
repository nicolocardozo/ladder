// Connections (Claude, Codex, GitHub): names, states and commands to the host. State lives in app-store (`connections`).
import type { AgentId, ConnectionId, ConnectionStatus, Profile, ProfileAgent } from '@shared/protocol'
import { request } from '@/lib/host-client'
import { hostProfileId, isDefaultProfileId } from '@/lib/profiles'
import { useApp } from '@/store/app-store'

/** Row order, in Settings and at first launch. */
export const CONNECTION_ORDER: ConnectionId[] = ['claude-code', 'codex', 'github']

export const CONNECTION_NAME: Record<ConnectionId, string> = {
  'claude-code': 'Claude',
  codex: 'ChatGPT / Codex',
  github: 'GitHub'
}

/** Connection that a native agent requires; ACP agents handle login themselves. */
export function connectionOfAgent(agent: AgentId): ConnectionId | null {
  return agent === 'claude-code' || agent === 'codex' ? agent : null
}

/** Connected and not in the middle of an account switch. */
export function isLinked(status: ConnectionStatus | null | undefined): boolean {
  return status?.state === 'connected'
}

/** Login (or the tool) is missing: a session with this agent would fail at the first message. `error` does not block: the state could not be read. */
export function needsSignIn(status: ConnectionStatus | null | undefined): boolean {
  return status?.state === 'missing' || status?.state === 'unauthenticated'
}

/** At least one agent can answer: an active native connection or an available ACP agent. */
export function hasLinkedAgent(): boolean {
  const { connections, profileConnections, agents } = useApp.getState()
  return isLinked(connections['claude-code']) || isLinked(connections.codex) || Object.values(profileConnections).some(isLinked) || agents.some((a) => a.kind === 'acp' && a.available)
}

/** Commands may return a promise: the row disables the buttons until it resolves. */
export interface ConnectionActions {
  /** `profileId` (Claude Code and Codex): absent = default profile. */
  login: (id: ConnectionId, switchAccount?: boolean, profileId?: string) => void | Promise<void>
  cancel: (id: ConnectionId, profileId?: string) => void | Promise<void>
  logout: (id: ConnectionId, profileId?: string) => void | Promise<void>
  /** Profile management. Absent where they are not managed (first launch). They reject with the host's message (name already used, profile in use…). */
  createProfile?: (agent: ProfileAgent, name: string) => Promise<Profile>
  renameProfile?: (profileId: string, name: string) => Promise<Profile>
  removeProfile?: (profileId: string) => Promise<void>
}

/** Row key: connection plus profile (absent = default). */
export function connectionKey(id: ConnectionId, profileId?: string | null): string {
  return isDefaultProfileId(profileId) ? id : `${id}:${profileId}`
}

// Order of updates per row: a `connection.list` response that started before an event does not overwrite it.
let sequence = 0
const stamp: Record<string, number> = {}
useApp.subscribe((state, prev) => {
  for (const id of CONNECTION_ORDER) if (state.connections[id] !== prev.connections[id]) stamp[id] = ++sequence
  if (state.profileConnections !== prev.profileConnections) {
    for (const [profileId, status] of Object.entries(state.profileConnections)) if (status !== prev.profileConnections[profileId]) stamp[connectionKey(status.id, profileId)] = ++sequence
  }
})

function apply(status: ConnectionStatus): void {
  useApp.getState().applyEvent({ type: 'connection.update', status })
}

/** Command with a state response: the rest arrives with `connection.update` events. A channel error becomes the row's error. */
function run(id: ConnectionId, command: Parameters<typeof request>[0], useResponse = true, profileId?: string): Promise<void> {
  // `connection.cancel` does not promise a state response: the event that follows is enough.
  return request<ConnectionStatus | undefined>(command)
    .then((status) => {
      if (useResponse && status) apply(status)
    })
    .catch((e: Error) => {
      const state = useApp.getState()
      const current = isDefaultProfileId(profileId) ? state.connections[id] : state.profileConnections[profileId!]
      // A deliberate cancellation is not an error.
      if (current && !/cancell?ed|annullat/i.test(e.message)) apply({ ...current, login: null, error: e.message })
    })
}

export const liveConnectionActions: ConnectionActions = {
  // The login response (initial phase) may be older than the events already arrived, like the GitHub code: the events are enough.
  login: (id, switchAccount, profileId) => run(id, { type: 'connection.login', id, ...(switchAccount ? { switchAccount: true } : {}), ...withProfile(profileId) }, false, profileId),
  cancel: (id, profileId) => run(id, { type: 'connection.cancel', id, ...withProfile(profileId) }, true, profileId),
  logout: (id, profileId) => run(id, { type: 'connection.logout', id, ...withProfile(profileId) }, true, profileId),
  createProfile: async (agent, name) => {
    const profile = await request<Profile>({ type: 'profile.create', agent, name })
    useApp.getState().applyEvent({ type: 'profile.upsert', profile })
    // The new profile has no connection in the store yet: it is read, so the row shows "Sign in".
    void run(agent, { type: 'connection.refresh', id: agent, profileId: profile.id }, true, profile.id)
    return profile
  },
  renameProfile: async (profileId, name) => {
    const profile = await request<Profile>({ type: 'profile.rename', profileId, name })
    useApp.getState().applyEvent({ type: 'profile.upsert', profile })
    return profile
  },
  removeProfile: async (profileId) => {
    await request({ type: 'profile.remove', profileId })
    useApp.getState().applyEvent({ type: 'profile.removed', profileId })
  }
}

function withProfile(profileId?: string): { profileId?: string } {
  const id = hostProfileId(profileId)
  return id ? { profileId: id } : {}
}

/** Rereads the state of all connections, without starting anything (host without snapshot.connections, opening of Settings → Subscriptions). Rows already updated by an event after the request stay as they are. */
export function refreshConnections(): void {
  const startedAt = sequence
  request<ConnectionStatus[]>({ type: 'connection.list' })
    .then((list) => list.forEach((status) => (stamp[connectionKey(status.id, status.profileId)] ?? 0) <= startedAt && apply(status)))
    .catch(() => undefined)
}
