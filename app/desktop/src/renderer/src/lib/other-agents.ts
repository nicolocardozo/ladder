// "Other agents": CLIs like Gemini, Copilot or Cursor, with sign-in state and login from their terminal.
// The list lives in app-store (`otherAgents`); rows are updated by `agent.connection` events.
import type { OtherAgentConnection, TerminalInfo } from '@shared/protocol'
import { t } from '@shared/i18n'
import { useSettings } from '@/hooks/use-theme'
import { onHostConnect, request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'

// Order of updates per row: the `agents.others` response that started before an event does not overwrite it.
let sequence = 0
const stamp: Record<string, number> = {}
useApp.subscribe((state, prev) => {
  if (state.otherAgents === prev.otherAgents) return
  for (const row of state.otherAgents ?? []) if (row !== prev.otherAgents?.find((p) => p.id === row.id)) stamp[row.id] = ++sequence
})

/** An agent is connected to Ladder if the CLI is present and the probe opened a session without asking for sign-in. */
export function isOtherLinked(agent: OtherAgentConnection): boolean {
  return agent.installed && agent.auth === 'connected'
}

let loaded = false
let loading: Promise<void> | null = null

/**
 * Reads the list only once (then `agent.connection` events and «Check again» keep it updated): the host answers immediately with
 * what it knows and sends the probes as events. Calling it while one is in progress or after a success does not relaunch anything; it retries only after
 * an error or with `force` (new connection with the host).
 */
export function loadOtherAgents(force = false): Promise<void> {
  if (!force) {
    if (loading) return loading
    if (loaded) return Promise.resolve()
  }
  const startedAt = sequence
  const run = request<OtherAgentConnection[]>({ type: 'agents.others' })
    .then((list) => {
      const current = useApp.getState().otherAgents ?? []
      useApp.getState().setOtherAgents(list.map((row) => ((stamp[row.id] ?? 0) > startedAt ? (current.find((c) => c.id === row.id) ?? row) : row)))
      loaded = true
    })
    .finally(() => {
      if (loading === run) loading = null
    })
  loading = run
  return run
}
// A new connection with the host (even the first) rereads the list; the host has its own state.
onHostConnect(() => void loadOtherAgents(true).catch(() => undefined))

function upsert(agent: OtherAgentConnection): void {
  useApp.getState().applyEvent({ type: 'agent.connection', agent })
}

/** Repeats an agent's probe. */
export async function refreshOtherAgent(id: string): Promise<void> {
  upsert(await request<OtherAgentConnection>({ type: 'agents.others.refresh', id }))
}

/** Project in which the terminal opens: the one in view, otherwise the first. */
function terminalProject(): string | null {
  const state = useApp.getState()
  return state.selection.projectId ?? state.projects[0]?.id ?? null
}

/** Brings a Ladder terminal into view: selects its project, opens the panel and closes the Settings that would cover it. */
export function showTerminal(terminal: Pick<TerminalInfo, 'id' | 'projectId'>): void {
  const state = useApp.getState()
  if (state.selection.projectId !== terminal.projectId) state.selectProject(terminal.projectId)
  state.setTerminalPanel(terminal.projectId, { open: true, active: terminal.id })
  useSettings.getState().setSettingsOpen(false)
}

/** Opens the agent's sign-in or sign-out in the project's terminal. Rejects with a clear message if there is no project. */
async function openInTerminal(kind: 'login' | 'logout', id: string): Promise<void> {
  const projectId = terminalProject()
  if (!projectId) throw new Error(t('Open a project first: the sign-in runs in one of its terminals.'))
  const terminal = await request<TerminalInfo>({ type: kind === 'login' ? 'agents.others.login' : 'agents.others.logout', id, projectId })
  useApp.getState().applyEvent({ type: 'terminal.upsert', terminal })
  showTerminal(terminal)
}

export const loginOtherAgent = (id: string) => openInTerminal('login', id)
export const logoutOtherAgent = (id: string) => openInTerminal('logout', id)

/** The terminal of a sign-in in progress, for "Show terminal". */
export function showOtherAgentTerminal(terminalId: string): boolean {
  const terminal = useApp.getState().terminals[terminalId]
  if (!terminal) return false
  showTerminal(terminal)
  return true
}
