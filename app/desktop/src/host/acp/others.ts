// LAD-79: "Altri agenti" nelle Subscription. Per ogni agente ACP curato o aggiunto (non Claude, Codex, GitHub): installato, versione,
// stato di accesso da una prova ACP (initialize + session/new) e accesso/uscita tramite la CLI dell'agente, in un terminale di Ladder.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { t } from '@shared/i18n'
import type { AcpAgentSpec, AgentLogin, OtherAgentAuth, OtherAgentConnection, Project, TerminalInfo } from '@shared/protocol'
import { whichManyInShell } from '../agents/common'
import type { TerminalManager } from '../terminals'
import { acpProbe, STRIP_ENV } from './adapter'
import { cliVersion, CURATED } from './catalog'
import { loadRegistry, pathSpec, type RegistryEntry } from './registry'

/**
 * Comandi di accesso e uscita noti, argomenti dopo l'eseguibile del catalogo (CURATED.exe). Solo quelli verificati sulla
 * documentazione del vendor; dove manca un comando certo il campo resta vuoto e la UI apre la CLI da sola:
 * - gemini: nessun sottocomando; l'accesso con Google parte lanciando `gemini` (lo dice l'issue LAD-79). Uscita: nessun comando noto.
 * - github-copilot-cli: `copilot login` (docs.github.com, "Authenticate Copilot CLI"); l'uscita è solo `/logout` dentro la CLI.
 * - cursor: `cursor-agent login` / `cursor-agent logout` (cursor.com/docs/cli, authentication; `agent` è lo stesso programma).
 * - grok-build: `grok login` (docs.x.ai/build/overview).
 * - opencode, kiro, qwen-code, cline, goose, junie, factory-droid, amp-acp: non verificati (le pagine non erano leggibili, nessuna
 *   di queste CLI è installata qui per `--help`): vuoto di proposito. OpenCode e Kiro hanno probabilmente `auth login` / `login`: da confermare.
 */
const COMMANDS: Record<string, { login?: string[]; logout?: string[]; logoutHelp?: () => string }> = {
  gemini: { login: [], logoutHelp: () => t('Gemini CLI has no sign-out command. Open it and use /auth to choose another way to sign in.') },
  'github-copilot-cli': { login: ['login'], logoutHelp: () => t('Open Copilot CLI and type /logout at its prompt. This removes the token stored on this Mac.') },
  cursor: { login: ['login'], logout: ['logout'] },
  // LAD-85: `grok login` (docs.x.ai/build/overview; `--device-auth` solo senza browser). Nessun comando di uscita documentato.
  'grok-build': { login: ['login'] }
}

/** Adattatori ACP nativi di Claude e Codex (es. claude-acp, codex-acp): hanno la loro riga, non sono "altri agenti". */
const NATIVE = /^(claude|codex)(-|$)/
/** Programmi che esistono solo per parlare ACP (es. amp-acp): senza argomenti restano fermi su stdin, non c'è una CLI da aprire. */
const ACP_ONLY = /(^|-)acp($|-)/

/** Una prova al massimo ogni 10 minuti per agente, senza che l'utente la chieda. */
const STALE_MS = 10 * 60_000
/** Prove contemporanee: ognuna avvia il programma di un agente. */
const MAX_PROBES = 2

/** Fatti sull'agente che non cambiano tra una prova e l'altra; si rileggono a ogni `list` e `refresh`. */
interface Base {
  id: string
  name: string
  icon: string | null
  added: boolean
  runner: OtherAgentConnection['runner']
  installed: boolean
  path: string | null
  version: string | null
  /** Voce con cui avviare l'agente per la prova (la sua, o per un curato rilevato quella costruita dal registro); null se non si può provare. */
  probe: AcpAgentSpec | null
  exe: string | null
}

export interface OtherAgentsDeps {
  specs: () => Map<string, AcpAgentSpec>
  /** Ultimo stato di accesso salvato per l'agente (da una sessione, da `agents.authenticate` o da una prova). */
  login: (id: string) => AgentLogin
  saveLogin: (id: string, login: AgentLogin) => void
  emit: (agent: OtherAgentConnection) => void
  terminals: TerminalManager
  /** Progetto in cui aprire il terminale: quello dato o il primo; errore se non ce ne sono. */
  project: (projectId?: string) => Project
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const authOf = (state: AgentLogin['state']): OtherAgentAuth => (state === 'ready' ? 'connected' : state === 'required' ? 'needs-login' : 'unknown')

export class OtherAgents {
  private base = new Map<string, Base>()
  /** Esito dell'ultima prova di questo avvio (anche fallita: unknown). */
  private probed = new Map<string, { auth: OtherAgentAuth; checkedAt: number }>()
  private probing = new Map<string, Promise<void>>()
  private waiting: (() => void)[] = []
  private active = 0
  /** Terminale di accesso o uscita per agente, finché il processo gira. */
  private terminalOf = new Map<string, { id: string; kind: 'login' | 'logout' }>()
  /** Lancio in corso per agente (registrato in modo sincrono): due richieste insieme non aprono due terminali. */
  private launching = new Map<string, { kind: 'login' | 'logout'; run: Promise<TerminalInfo> }>()
  /** Scansione in corso: chi la chiede mentre gira ne riusa l'esito. */
  private scanning: Promise<void> | null = null
  private scanSeq = 0
  private appliedSeq = 0
  private registryFailedAt = 0

  constructor(private readonly deps: OtherAgentsDeps) {}

  /**
   * Elenco; avvia in background le prove mancanti o vecchie (esiti come eventi `agent.connection`), ma solo per gli agenti già
   * aggiunti: un programma rilevato nel PATH e mai aggiunto non si avvia da solo (potrebbe lanciare i server MCP o gli
   * aggiornamenti dell'utente). Per quelli la prova parte con «Check again» o dopo un accesso lanciato da Ladder.
   */
  async list(): Promise<OtherAgentConnection[]> {
    await this.scan()
    for (const base of this.base.values()) {
      const view = this.view(base)
      if (base.added && base.probe && base.installed && (view.checkedAt === null || Date.now() - view.checkedAt > STALE_MS)) void this.probe(base.id)
    }
    return [...this.base.values()].map((base) => this.view(base))
  }

  /** Rilegge il programma e ripete la prova; risponde la riga aggiornata. */
  async refresh(id: string): Promise<OtherAgentConnection> {
    await this.scan(true)
    const base = this.base.get(id)
    if (!base) throw new Error(t('Unknown ACP agent.'))
    if (base.probe && base.installed) await this.probe(id)
    return this.view(this.base.get(id) ?? base)
  }

  /**
   * Accesso (`login`) o uscita (`logout`) con la CLI dell'agente, in un terminale `run` del progetto. A fine processo si ripete la prova.
   * Un lancio alla volta per agente: la stessa richiesta due volte riusa il lancio in corso, l'altra (logout durante un login) è rifiutata.
   */
  launch(id: string, kind: 'login' | 'logout', projectId?: string): Promise<TerminalInfo> {
    const pending = this.launching.get(id)
    if (pending) return pending.kind === kind ? pending.run : Promise.reject(new Error(this.busy(id)))
    const run = this.open(id, kind, projectId).finally(() => {
      if (this.launching.get(id)?.run === run) this.launching.delete(id)
    })
    this.launching.set(id, { kind, run })
    return run
  }

  private busy(id: string): string {
    return t('{agent} already has a sign-in or sign-out open in a terminal. Finish or close it first.', { agent: this.base.get(id)?.name ?? id })
  }

  private async open(id: string, kind: 'login' | 'logout', projectId?: string): Promise<TerminalInfo> {
    // Un solo terminale per agente alla volta: se quello di prima gira ancora lo si riusa (stesso tipo) o si rifiuta.
    const running = this.terminalOf.get(id)
    const live = running ? this.deps.terminals.get(running.id) : null
    if (running && live?.state === 'running') {
      if (running.kind === kind) return live
      throw new Error(this.busy(id))
    }
    await this.scan()
    const base = this.base.get(id)
    if (!base) throw new Error(t('Unknown ACP agent.'))
    if (!base.installed || !base.path) throw new Error(t('{agent} is not installed.', { agent: base.name }))
    const known = COMMANDS[id]
    const args = kind === 'login' ? (known?.login ?? []) : known?.logout
    if (!args) throw new Error(t('{agent} has no sign-out command.', { agent: base.name }))
    // Senza un comando noto e per un programma solo ACP, lanciarlo da solo lo lascerebbe fermo su stdin.
    if (kind === 'login' && !known?.login && ACP_ONLY.test(base.exe ?? '')) throw new Error(t('{agent} has no command to sign in from. Sign in from the agent’s own app or CLI.', { agent: base.name }))
    if (live) await this.deps.terminals.close(live.id)
    const project = this.deps.project(projectId)
    const command = [shellQuote(base.path), ...args.map(shellQuote)].join(' ')
    const title = kind === 'login' ? t('Sign in to {agent}', { agent: base.name }) : t('Sign out of {agent}', { agent: base.name })
    // Stesso criterio della prova: voce dell'agente applicata e chiavi API tolte (valgono il login e l'abbonamento). Il terminale è una
    // shell di login interattiva: un .zshrc dell'utente può riesportarle, e allora valgono quelle (come per ogni suo terminale).
    const env = Object.fromEntries(Object.entries(base.probe?.env ?? {}).filter(([key]) => !/^(ANTHROPIC_|CLAUDE|DYLD_|LD_)/.test(key) && key !== 'NODE_OPTIONS'))
    const info = this.deps.terminals.spawn({ projectId: project.id, sessionId: null, kind: 'run', title, cwd: project.path, command, env, unsetEnv: STRIP_ENV, port: null })
    this.terminalOf.set(id, { id: info.id, kind })
    this.deps.emit(this.view(base))
    void this.deps.terminals.onceExit(info.id).then(async () => {
      if (this.terminalOf.get(id)?.id === info.id) this.terminalOf.delete(id)
      // Il terminale non c'è più: la riga lo dice subito, prima della prova.
      const current = this.base.get(id) ?? base
      this.deps.emit(this.view(current))
      // Anche se il processo è uscito con errore o il terminale è stato chiuso: lo stato si rilegge sempre (dopo una prova già in corso, che è di prima).
      if (current.probe) {
        await this.probing.get(id)
        await this.probe(id)
      }
    })
    return info
  }

  /** Prova di un agente: una alla volta per id, al massimo MAX_PROBES insieme. Mai un'eccezione: l'esito ignoto è `unknown`. */
  private probe(id: string): Promise<void> {
    const running = this.probing.get(id)
    if (running) return running
    const run = (async () => {
      const base = this.base.get(id)
      if (!base?.probe) return
      if (this.active >= MAX_PROBES) await new Promise<void>((resolve) => this.waiting.push(resolve))
      else this.active++
      try {
        // Il percorso lo ha già trovato la scansione: niente altra shell di login per ritrovarlo.
        const login = await acpProbe(base.path ? { ...base.probe, command: base.path } : base.probe, homedir())
        this.probed.set(id, { auth: authOf(login.state), checkedAt: login.checkedAt ?? Date.now() })
        this.deps.saveLogin(id, login)
      } catch {
        this.probed.set(id, { auth: 'unknown', checkedAt: Date.now() })
      } finally {
        const next = this.waiting.shift()
        if (next) next()
        else this.active--
        this.probing.delete(id)
        const current = this.base.get(id)
        if (current) this.deps.emit(this.view(current))
      }
    })()
    this.probing.set(id, run)
    // La riga passa subito a «in controllo»: la prova può durare 25 secondi.
    const started = this.base.get(id)
    if (started) this.deps.emit(this.view(started))
    return run
  }

  /** Riga completa: fatti dell'agente + stato dell'ultima prova o, se più recente, dell'ultimo login salvato (una sessione di chat, `agents.authenticate`). */
  private view(base: Base): OtherAgentConnection {
    const stored = this.deps.login(base.id)
    const probed = this.probed.get(base.id)
    const fromStored = stored.state !== 'unknown' && stored.checkedAt !== null && (!probed || stored.checkedAt > probed.checkedAt)
    const auth: OtherAgentAuth = !base.installed ? 'unknown' : fromStored ? authOf(stored.state) : (probed?.auth ?? 'unknown')
    const checkedAt = !base.installed ? null : fromStored ? stored.checkedAt : (probed?.checkedAt ?? null)
    const known = COMMANDS[base.id]
    const openable = base.installed && base.exe && (known?.login !== undefined || !ACP_ONLY.test(base.exe))
    const show = (args: string[] | undefined) => (base.installed && base.exe && args ? [base.exe, ...args].join(' ') : null)
    return {
      id: base.id,
      name: base.name,
      icon: base.icon,
      added: base.added,
      runner: base.runner,
      installed: base.installed,
      path: base.path,
      version: base.version,
      auth,
      account: null,
      checkedAt,
      probing: this.probing.has(base.id),
      loginCommand: show(known?.login),
      openCommand: openable ? base.exe : null,
      logoutCommand: show(known?.logout),
      logoutHelp: known?.logout ? null : (known?.logoutHelp?.() ?? null),
      terminalId: this.terminalOf.get(base.id)?.id ?? null
    }
  }

  /** Cerca i programmi (PATH della shell di login) e ricostruisce i fatti di ogni agente curato o aggiunto. */
  private scan(force = false): Promise<void> {
    if (this.scanning && !force) return this.scanning
    // Una scansione più vecchia di una già applicata non sovrascrive: vince sempre l'ultima partita.
    const seq = ++this.scanSeq
    const run = this.scanNow().then((next) => {
      if (seq > this.appliedSeq) {
        this.appliedSeq = seq
        this.base = next
      }
    })
    const done = run.finally(() => {
      if (this.scanning === done) this.scanning = null
    })
    this.scanning = done
    return done
  }

  private async scanNow(): Promise<Map<string, Base>> {
    const specs = this.deps.specs()
    let entries: RegistryEntry[] = []
    // Registro non raggiungibile: restano i nomi delle voci aggiunte e l'id; non si riprova prima di un minuto (la richiesta può durare 15 secondi).
    if (Date.now() - this.registryFailedAt > 60_000) {
      try {
        entries = await loadRegistry()
      } catch {
        this.registryFailedAt = Date.now()
      }
    }
    // Curati e voci scritte a mano o aggiunte con un nome nel PATH: un solo giro di shell di login per tutti.
    const bare = [...specs.values()].filter((s) => !s.command.includes('/') && s.command !== 'npx' && s.command !== 'uvx').map((s) => s.command)
    const found = await whichManyInShell([...CURATED.map((c) => c.exe), ...bare])
    const detected = new Map<string, string>()
    for (const c of CURATED) {
      const path = found.get(c.exe)
      if (path) detected.set(c.id, path)
    }
    // Gli adattatori ACP di Claude e Codex hanno la loro riga: non sono "altri agenti".
    const ids = [...new Set([...CURATED.map((c) => c.id), ...specs.keys()])].filter((id) => !NATIVE.test(id))
    const next = new Map<string, Base>()
    for (const id of ids) {
      const spec = specs.get(id)
      const entry = entries.find((e) => e.id === id)
      const curated = CURATED.find((c) => c.id === id)
      const launcher = spec ? (spec.distribution === 'npx' || spec.distribution === 'uvx' ? spec.distribution : spec.command === 'npx' || spec.command === 'uvx' ? spec.command : null) : null
      let path: string | null = null
      if (spec && !launcher) path = spec.command.includes('/') ? (existsSync(spec.command) ? spec.command : null) : (found.get(spec.command) ?? null)
      else path = detected.get(id) ?? null
      // Aggiunto con npx/uvx e nessuna CLI locale: non si prova (scaricherebbe il pacchetto).
      const runner: Base['runner'] = launcher && !path ? launcher : 'program'
      let probe: AcpAgentSpec | null = null
      if (path && spec && !launcher) probe = spec
      else if (path && entry) probe = pathSpec(entry, path)
      const old = this.base.get(id)
      next.set(id, {
        id,
        name: spec?.name ?? entry?.name ?? id,
        icon: spec?.icon ?? old?.icon ?? null,
        added: Boolean(spec),
        runner,
        installed: runner === 'program' && path !== null,
        path,
        version: null,
        probe,
        exe: curated?.exe ?? (path ? basename(path) : null)
      })
    }
    // La versione costa un avvio del programma: cliVersion la tiene in cache per percorso e data di modifica.
    await Promise.all([...next.values()].map(async (base) => {
      if (base.path) base.version = await cliVersion(base.path)
    }))
    return next
  }
}
