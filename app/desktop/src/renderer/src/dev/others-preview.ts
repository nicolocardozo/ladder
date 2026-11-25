// Fake host for "Other agents": answers agents.others* commands as the real host would and sends `agent.connection`
// when the state changes, so the row goes from "Needs sign-in" to "Connected" without reopening Settings.
import type { HostCommand, OtherAgentConnection, TerminalInfo } from '@shared/protocol'
import { useApp } from '@/store/app-store'
import { emitPreviewEvent, registerPreviewHandler } from './shortcuts-preview'

let installed = false

const base = (id: string, name: string, patch: Partial<OtherAgentConnection>): OtherAgentConnection => ({
  id,
  name,
  icon: null,
  added: true,
  runner: 'program',
  installed: true,
  path: `/opt/homebrew/bin/${id}`,
  version: '1.0.0',
  auth: 'unknown',
  account: null,
  checkedAt: null,
  probing: false,
  loginCommand: null,
  openCommand: id,
  logoutCommand: null,
  logoutHelp: null,
  terminalId: null,
  ...patch
})

/** Test list: one connected (without a sign-out command), one that asks for sign-in with a command, one without a sign-in command, one not probed; plus one not installed, which the list does not show. */
export function previewOtherAgents(): OtherAgentConnection[] {
  return [
    base('gemini', 'Gemini CLI', { version: '0.12.1', auth: 'connected', checkedAt: Date.now() - 60_000, logoutHelp: 'Delete ~/.gemini/oauth_creds.json to sign out.' }),
    base('copilot', 'GitHub Copilot', { version: '1.4.2', auth: 'needs-login', checkedAt: Date.now() - 120_000, loginCommand: 'copilot login', logoutCommand: 'copilot logout' }),
    base('opencode', 'OpenCode', { version: '0.9.7', auth: 'needs-login', checkedAt: Date.now() - 30_000 }),
    base('cursor', 'Cursor Agent', { version: '2026.11.3', auth: 'unknown', loginCommand: 'cursor-agent login', logoutCommand: 'cursor-agent logout' }),
    base('goose', 'Goose', { installed: false, path: null, version: null, openCommand: null })
  ]
}

/** Like the host: the rows and terminals of a sign-in in progress. */
export function installOthersPreview(): void {
  if (installed) return
  installed = true
  let rows = previewOtherAgents()
  const timers: number[] = []
  const publish = (id: string, patch: Partial<OtherAgentConnection>): OtherAgentConnection => {
    rows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row))
    const next = rows.find((row) => row.id === id)!
    emitPreviewEvent({ type: 'agent.connection', agent: next })
    return next
  }
  const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms))
  const terminalFor = (row: OtherAgentConnection, projectId: string | undefined, title: string, command: string): TerminalInfo => ({
    id: `term-${row.id}-${Date.now()}`,
    projectId: projectId ?? useApp.getState().projects[0]?.id ?? 'acme-monorepo',
    sessionId: null,
    kind: 'run',
    title,
    cwd: '/tmp/acme',
    command,
    state: 'running',
    exitCode: null,
    createdAt: Date.now(),
    port: null
  })
  /** The terminal process exits: the host repeats the probe and the row takes the result. */
  const finish = (id: string, terminal: TerminalInfo, auth: OtherAgentConnection['auth']) => {
    later(2500, () => {
      emitPreviewEvent({ type: 'terminal.upsert', terminal: { ...terminal, state: 'exited', exitCode: 0 } })
      publish(id, { terminalId: null, probing: true })
      later(900, () => publish(id, { probing: false, auth, checkedAt: Date.now() }))
    })
  }

  registerPreviewHandler((command: HostCommand) => {
    switch (command.type) {
      case 'agents.others':
        return { ok: true, data: rows }
      case 'agents.others.refresh': {
        const row = rows.find((r) => r.id === command.id)
        if (!row) return { ok: false, error: 'Unknown agent.' }
        publish(row.id, { probing: true })
        // A CLI never probed answers that it requires sign-in.
        later(800, () => publish(row.id, { probing: false, auth: row.auth === 'unknown' ? 'needs-login' : row.auth, checkedAt: Date.now() }))
        return { ok: true, data: { ...row, probing: true } }
      }
      case 'agents.others.login':
      case 'agents.others.logout': {
        const row = rows.find((r) => r.id === command.id)
        if (!row || !row.installed) return { ok: false, error: 'This agent isn’t installed.' }
        const login = command.type === 'agents.others.login'
        if (!login && !row.logoutCommand) return { ok: false, error: 'This agent has no sign-out command.' }
        const typed = login ? (row.loginCommand ?? row.openCommand ?? row.id) : row.logoutCommand!
        const terminal = terminalFor(row, command.projectId, login ? `Sign in to ${row.name}` : `Sign out of ${row.name}`, typed)
        emitPreviewEvent({ type: 'terminal.upsert', terminal })
        publish(row.id, { terminalId: terminal.id })
        finish(row.id, terminal, login ? 'connected' : 'needs-login')
        return { ok: true, data: terminal }
      }
      case 'agents.usage': {
        // The store state as it is: the limits row reads without errors.
        const status = useApp.getState().agents.find((a) => a.agent === command.agent) ?? null
        return { ok: true, data: status ? { ...status, usageAt: Date.now() } : null }
      }
    }
    return undefined
  })
}
