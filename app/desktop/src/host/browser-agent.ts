// Browser per l'agente (LAD-57 parte 2), lato host: tiene il server MCP, lo stato mostrato dalla UI e il canale verso il main,
// che possiede la vista. Con l'interruttore spento (AppPrefs.agentBrowser / ProjectUiState.agentBrowser) non parte nulla.
//
// Canale host ↔ main: HostToMain `browser-agent` (richiesta con rid) → MainToHost `browser-agent-result` (stesso rid).
// Il main risponde solo con dati semplici e l'host li tratta come testo: la pagina non può far chiamare nulla all'host.
import { randomUUID } from 'node:crypto'
import { t } from '@shared/i18n'
import type { AgentBrowserState, BrowserAgentOp, BrowserAgentResult, HostEvent, HostToMain, PermissionLevel, RequestResponse } from '@shared/protocol'
import type { UserRequest } from './agents/common'
import { BrowserMcpServer, type BrowserBackend, type BrowserToolsHandle, type ConfirmRequest } from './browser-mcp'

/** Tempo massimo di una risposta del main: oltre, l'operazione è fallita (il main non risponde o la finestra è morta). */
const MAIN_TIMEOUT_MS = 45_000

export interface BrowserAgentDeps {
  send: (message: HostToMain) => void
  broadcast: (event: HostEvent) => void
  /** Interruttore effettivo per il progetto: ProjectUiState.agentBrowser, altrimenti quello globale. */
  setting: (projectId: string) => boolean
  /** Progetto della sessione se la sessione esiste ancora e ha un agente vivo, altrimenti null. */
  alive: (sessionId: string) => string | null
  level: (sessionId: string) => PermissionLevel
  /** Apre una card di approvazione nella chat della sessione (la stessa dei permessi degli strumenti). */
  request: (sessionId: string, request: UserRequest, signal: AbortSignal) => Promise<RequestResponse>
}

export class BrowserAgent implements BrowserBackend {
  private readonly deps: BrowserAgentDeps
  private readonly server: BrowserMcpServer
  private readonly pending = new Map<string, { resolve: (result: BrowserAgentResult) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly states = new Map<string, AgentBrowserState>()
  /** Sessioni con un token attivo e il loro progetto. */
  private readonly registered = new Map<string, string>()
  /** Come si è fermata una sessione: solo lo stop dell'interruzione del turno (`interrupt`) torna da sé al turno dopo dell'utente. */
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

  /** Prima di creare il runtime di una sessione: avvia il server se l'interruttore è acceso (null se non serve). */
  prepare(projectId: string): Promise<void> | null {
    if (!this.deps.setting(projectId) || this.server.started) return null
    return this.server.start().catch((error: Error) => console.error(`[host] server del browser dell'agente: ${error.message}`))
  }

  /** Strumenti da registrare nell'adapter della sessione; null con l'interruttore spento (nessun server né registrazione). */
  register(sessionId: string, projectId: string): BrowserToolsHandle | null {
    if (!this.deps.setting(projectId) || !this.server.started) return null
    const handle = this.server.register(sessionId, projectId)
    this.registered.set(sessionId, projectId)
    this.states.set(sessionId, { sessionId, projectId, tabId: null, enabled: true, stopped: false, closed: false, action: null, last: null, allowedHosts: [] })
    this.emit(sessionId)
    return handle
  }

  /** Sessione chiusa o interruttore spento: token revocato, vista distrutta e partizione svuotata. */
  revoke(sessionId: string): void {
    if (!this.registered.delete(sessionId)) return
    this.server.revoke(sessionId)
    this.stopKind.delete(sessionId)
    this.deps.send({ type: 'browser-agent', rid: randomUUID(), op: { op: 'close', sessionId } })
    this.patch(sessionId, { closed: true, enabled: false, tabId: null, action: null })
    this.states.delete(sessionId)
  }

  /** Cambio di impostazioni: chi non ha più l'interruttore acceso perde gli strumenti subito. */
  sync(): void {
    for (const [sessionId, projectId] of [...this.registered]) if (!this.deps.setting(projectId)) this.revoke(sessionId)
  }

  /**
   * `user`: stop esplicito (definitivo fino a resume, anche se prima c'era uno stop implicito). `interrupt`: l'utente ha interrotto il turno;
   * gli strumenti restano fermi fino al turno dopo, ma la UI non mostra "Fermato" (non c'è nulla da riattivare a mano): azzera solo l'azione in corso.
   */
  stop(sessionId: string, source: 'user' | 'interrupt' = 'user'): AgentBrowserState | null {
    if (!this.registered.has(sessionId)) return this.states.get(sessionId) ?? null
    // Uno stop esplicito vince sempre; l'implicito non declassa uno stop esplicito né la tab chiusa.
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

  /** Un turno nuovo dell'utente riabilita gli strumenti solo se li aveva fermati l'interruzione del turno: non uno stop esplicito né la tab chiusa. */
  turnStarted(sessionId: string): void {
    if (this.server.isStopped(sessionId) && this.stopKind.get(sessionId) === 'interrupt') this.resume(sessionId)
  }

  /** Livello di permesso cambiato: le autorizzazioni "per la sessione" sulle scritture e Full access non valgono più. */
  permissionChanged(sessionId: string): void {
    if (this.registered.has(sessionId)) this.server.levelChanged(sessionId)
  }

  snapshot(sessionId?: string): AgentBrowserState[] {
    return sessionId ? [...(this.states.get(sessionId) ? [this.states.get(sessionId)!] : [])] : [...this.states.values()]
  }

  /** Il main segnala che la vista non c'è più (tab chiusa dall'utente): vale come stop. */
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

  // ── BrowserBackend: le operazioni vanno al main ──────────────────────────

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

  // ── Conferme: le stesse card di approvazione degli altri strumenti ─────────

  private async confirm(sessionId: string, request: ConfirmRequest, signal: AbortSignal): Promise<'allow' | 'always' | 'deny'> {
    const response = await this.deps.request(
      sessionId,
      {
        requestType: 'permission',
        toolName: request.tool,
        title: request.title,
        command: null,
        path: null,
        // Il nome dell'elemento è testo della pagina: in coda e dichiarato tale, mai nel titolo.
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

  // ── Stato per la UI ──────────────────────────────────────────────────────

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
