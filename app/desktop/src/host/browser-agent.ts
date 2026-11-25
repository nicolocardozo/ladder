// Browser for the agent, host side: holds the MCP server, the state shown by the UI and the channel to main,
// which owns the view. With the switch off (AppPrefs.agentBrowser / ProjectUiState.agentBrowser) nothing starts.
//
// Host ↔ main channel: HostToMain `browser-agent` (request with rid) → MainToHost `browser-agent-result` (same rid).
// Main replies only with plain data and the host treats it as text: the page can't make the host call anything.
import { randomUUID } from 'node:crypto'
import { t } from '@shared/i18n'
import type { AgentBrowserState, BrowserAgentOp, BrowserAgentResult, HostEvent, HostToMain, PermissionLevel, RequestResponse } from '@shared/protocol'
import type { UserRequest } from './agents/common'
import { BrowserMcpServer, type BrowserBackend, type BrowserToolsHandle, type ConfirmRequest } from './browser-mcp'

/** Maximum time for a reply from main: beyond that, the operation failed (main doesn't answer or the window is dead). */
const MAIN_TIMEOUT_MS = 45_000

export interface BrowserAgentDeps {
  send: (message: HostToMain) => void
  broadcast: (event: HostEvent) => void
  /** Effective switch for the project: ProjectUiState.agentBrowser, otherwise the global one. */
  setting: (projectId: string) => boolean
  /** The session's project if the session still exists and has a live agent, otherwise null. */
  alive: (sessionId: string) => string | null
  level: (sessionId: string) => PermissionLevel
  /** Opens an approval card in the session's chat (the same as for tool permissions). */
  request: (sessionId: string, request: UserRequest, signal: AbortSignal) => Promise<RequestResponse>
}

export class BrowserAgent implements BrowserBackend {
  private readonly deps: BrowserAgentDeps
  private readonly server: BrowserMcpServer
  private readonly pending = new Map<string, { resolve: (result: BrowserAgentResult) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly states = new Map<string, AgentBrowserState>()
  /** Sessions with an active token and their project. */
  private readonly registered = new Map<string, string>()
  /** How a session was stopped: only the turn-interrupt stop (`interrupt`) comes back on its own at the user's next turn. */
  private readonly stopKind = new Map<string, 'user' | 'interrupt' | 'closed'>()

  constructor(deps: BrowserAgentDeps) {
    this.deps = deps
    this.server = new BrowserMcpServer(this, {
      enabled: (sessionId) => {
        const project = this.deps.alive(sessionId)
        return project !== null && this.deps.setting(project)
      },
      level: (sessionId) => this.deps.level(sessionId),
      confirm: (sessionId, request, signal) => this.confirm(sessionId, request, signal),
      activity: (sessionId, event) => {
        const state = this.states.get(sessionId)
        if (!state) return
        if (event.phase === 'start') this.patch(sessionId, { action: { ...event.action, at: Date.now(), waitingForYou: false } })
        else if (event.phase === 'waiting') this.patch(sessionId, { action: state.action ? { ...state.action, waitingForYou: event.waiting } : null })
        else this.patch(sessionId, { action: null, last: { ...event.action, at: Date.now(), ok: event.ok, error: event.error } })
      },
      granted: (sessionId, hosts) => this.patch(sessionId, { allowedHosts: hosts })
    })
  }

  /** Before creating a session's runtime: starts the server if the switch is on (null if not needed). */
  prepare(projectId: string): Promise<void> | null {
    if (!this.deps.setting(projectId) || this.server.started) return null
    return this.server.start().catch((error: Error) => console.error(`[host] server del browser dell'agente: ${error.message}`))
  }

  /** Tools to register in the session's adapter; null with the switch off (no server or registration). */
  register(sessionId: string, projectId: string): BrowserToolsHandle | null {
    if (!this.deps.setting(projectId) || !this.server.started) return null
    const handle = this.server.register(sessionId, projectId)
    this.registered.set(sessionId, projectId)
    this.states.set(sessionId, { sessionId, projectId, tabId: null, enabled: true, stopped: false, closed: false, action: null, last: null, allowedHosts: [] })
    this.emit(sessionId)
    return handle
  }

  /** Session closed or switch off: token revoked, view destroyed and partition cleared. */
  revoke(sessionId: string): void {
    if (!this.registered.delete(sessionId)) return
    this.server.revoke(sessionId)
    this.stopKind.delete(sessionId)
    this.deps.send({ type: 'browser-agent', rid: randomUUID(), op: { op: 'close', sessionId } })
    this.patch(sessionId, { closed: true, enabled: false, tabId: null, action: null })
    this.states.delete(sessionId)
  }

  /** Settings change: whoever no longer has the switch on loses the tools immediately. */
  sync(): void {
    for (const [sessionId, projectId] of [...this.registered]) if (!this.deps.setting(projectId)) this.revoke(sessionId)
  }

  /**
   * `user`: explicit stop (final until resume, even if there was an implicit stop before). `interrupt`: the user interrupted the turn;
   * the tools stay stopped until the next turn, but the UI doesn't show "Stopped" (there is nothing to reactivate by hand): it only clears the action in progress.
   */
  stop(sessionId: string, source: 'user' | 'interrupt' = 'user'): AgentBrowserState | null {
    if (!this.registered.has(sessionId)) return this.states.get(sessionId) ?? null
    // An explicit stop always wins; the implicit one doesn't downgrade an explicit stop or the closed tab.
    this.stopKind.set(sessionId, source === 'user' ? 'user' : ((this.server.isStopped(sessionId) ? this.stopKind.get(sessionId) : undefined) ?? source))
    this.server.stop(sessionId)
    this.send({ op: 'stop', sessionId, freeze: true })
    this.patch(sessionId, source === 'user' ? { stopped: true, action: null } : { action: null })
    return this.states.get(sessionId) ?? null
  }

  resume(sessionId: string): AgentBrowserState | null {
    if (!this.registered.has(sessionId)) return this.states.get(sessionId) ?? null
    this.stopKind.delete(sessionId)
    this.server.resume(sessionId)
    this.send({ op: 'resume', sessionId })
    this.patch(sessionId, { stopped: false })
    return this.states.get(sessionId) ?? null
  }

  /** A new user turn re-enables the tools only if the turn interrupt had stopped them: not an explicit stop or the closed tab. */
  turnStarted(sessionId: string): void {
    if (this.server.isStopped(sessionId) && this.stopKind.get(sessionId) === 'interrupt') this.resume(sessionId)
  }

  /** Permission level changed: the "for the session" authorizations on writes and Full access no longer apply. */
  permissionChanged(sessionId: string): void {
    if (this.registered.has(sessionId)) this.server.levelChanged(sessionId)
  }

  snapshot(sessionId?: string): AgentBrowserState[] {
    return sessionId ? [...(this.states.get(sessionId) ? [this.states.get(sessionId)!] : [])] : [...this.states.values()]
  }

  /** Main reports that the view is gone (tab closed by the user): counts as a stop. */
  onClosed(sessionId: string): void {
    if (!this.registered.has(sessionId)) return
    this.stopKind.set(sessionId, 'closed')
    this.server.stop(sessionId)
    this.patch(sessionId, { stopped: true, tabId: null, action: null })
  }

  onResult(rid: string, result: BrowserAgentResult): void {
    const entry = this.pending.get(rid)
    if (!entry) return
    this.pending.delete(rid)
    clearTimeout(entry.timer)
    entry.resolve(result)
  }

  async shutdown(): Promise<void> {
    for (const sessionId of [...this.registered.keys()]) this.revoke(sessionId)
    for (const [rid, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, code: 'closed', error: t('The agent browser is closed.') })
      this.pending.delete(rid)
    }
    await this.server.close()
  }

  // ── BrowserBackend: operations go to main ──────────────────────────

  run(op: BrowserAgentOp): Promise<BrowserAgentResult> {
    return this.send(op).then((result) => {
      if (result.ok && op.op === 'open' && result.tabId) this.patch(op.sessionId, { tabId: result.tabId })
      return result
    })
  }

  private send(op: BrowserAgentOp): Promise<BrowserAgentResult> {
    return new Promise((resolve) => {
      const rid = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        resolve({ ok: false, code: 'timeout', error: t('The browser did not respond.') })
      }, MAIN_TIMEOUT_MS)
      this.pending.set(rid, { resolve, timer })
      this.deps.send({ type: 'browser-agent', rid, op })
    })
  }

  // ── Confirmations: the same approval cards as the other tools ─────────

  private async confirm(sessionId: string, request: ConfirmRequest, signal: AbortSignal): Promise<'allow' | 'always' | 'deny'> {
    const response = await this.deps.request(
      sessionId,
      {
        requestType: 'permission',
        toolName: request.tool,
        title: request.title,
        command: null,
        path: null,
        // The element's name is page text: put last and declared as such, never in the title.
        reason:
          request.kind === 'navigate'
            ? t('This address is outside localhost. The agent browser is isolated from your accounts and cookies.')
            : t('The agent wants to interact with the page in its browser.') + (request.detail ? ' ' + t('Element name, as written on the page: {name}', { name: request.detail }) : ''),
        options: [
          { id: 'allow', label: request.kind === 'navigate' ? t('Approve this page') : t('Approve'), kind: 'allow' },
          { id: 'always', label: request.kind === 'navigate' ? t('Allow this site for the session') : t('Allow for the session'), kind: 'allow-always' },
          { id: 'deny', label: t('Deny'), kind: 'deny' }
        ],
        questions: null
      },
      signal
    )
    if ('optionId' in response && (response.optionId === 'allow' || response.optionId === 'always')) return response.optionId
    return 'deny'
  }

  // ── State for the UI ──────────────────────────────────────────────────────

  private patch(sessionId: string, change: Partial<AgentBrowserState>): void {
    const state = this.states.get(sessionId)
    if (!state) return
    this.states.set(sessionId, { ...state, ...change })
    this.emit(sessionId)
  }

  private emit(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (state) this.deps.broadcast({ type: 'browser.agent', state })
  }
}
