// "Other agents" in Subscriptions. For each curated or added ACP agent (not Claude, Codex, GitHub): installed, version,
// sign-in state from an ACP probe (initialize + session/new) and sign-in/sign-out through the agent's CLI, in a Ladder terminal.
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
 * Known sign-in and sign-out commands, arguments after the catalog executable (CURATED.exe). Only those verified against the
 * vendor's documentation; where no certain command exists the field stays empty and the UI opens the CLI on its own:
 * - gemini: no subcommand; Google sign-in starts by launching `gemini`. Sign-out: no known command.
 * - github-copilot-cli: `copilot login` (docs.github.com, "Authenticate Copilot CLI"); sign-out is only `/logout` inside the CLI.
 * - cursor: `cursor-agent login` / `cursor-agent logout` (cursor.com/docs/cli, authentication; `agent` is the same program).
 * - grok-build: `grok login` (docs.x.ai/build/overview).
 * - opencode, kiro, qwen-code, cline, goose, junie, factory-droid, amp-acp: not verified (the pages were not readable, none
 *   of these CLIs is installed here for `--help`): empty on purpose. OpenCode and Kiro probably have `auth login` / `login`: to be confirmed.
 */
const COMMANDS: Record<string, { login?: string[]; logout?: string[]; logoutHelp?: () => string }> = {
  gemini: { login: [], logoutHelp: () => t('Gemini CLI has no sign-out command. Open it and use /auth to choose another way to sign in.') },
  'github-copilot-cli': { login: ['login'], logoutHelp: () => t('Open Copilot CLI and type /logout at its prompt. This removes the token stored on this Mac.') },
  cursor: { login: ['login'], logout: ['logout'] },
  // `grok login` (docs.x.ai/build/overview; `--device-auth` only without a browser). No documented sign-out command.
  'grok-build': { login: ['login'] }
}

/** Native ACP adapters of Claude and Codex (e.g. claude-acp, codex-acp): they have their own row, they are not "other agents". */
const NATIVE = /^(claude|codex)(-|$)/
/** Programs that exist only to speak ACP (e.g. amp-acp): without arguments they sit idle on stdin, there is no CLI to open. */
const ACP_ONLY = /(^|-)acp($|-)/

/** At most one probe every 10 minutes per agent, without the user asking for it. */
const STALE_MS = 10 * 60_000
/** Concurrent probes: each one starts an agent's program. */
const MAX_PROBES = 2

/** Facts about the agent that don't change between probes; reread on every `list` and `refresh`. */
interface Base {
  id: string
  name: string
  icon: string | null
  added: boolean
  runner: OtherAgentConnection['runner']
  installed: boolean
  path: string | null
  version: string | null
  /** Entry to start the agent with for the probe (its own, or for a detected curated one the one built from the registry); null if it can't be probed. */
  probe: AcpAgentSpec | null
  exe: string | null
}

export interface OtherAgentsDeps {
  specs: () => Map<string, AcpAgentSpec>
  /** Last sign-in state saved for the agent (from a session, from `agents.authenticate` or from a probe). */
  login: (id: string) => AgentLogin
  saveLogin: (id: string, login: AgentLogin) => void
  emit: (agent: OtherAgentConnection) => void
  terminals: TerminalManager
  /** Project to open the terminal in: the given one or the first; error if there are none. */
  project: (projectId?: string) => Project
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const authOf = (state: AgentLogin['state']): OtherAgentAuth => (state === 'ready' ? 'connected' : state === 'required' ? 'needs-login' : 'unknown')

export class OtherAgents {
  private base = new Map<string, Base>()
  /** Outcome of the last probe in this run (even a failed one: unknown). */
  private probed = new Map<string, { auth: OtherAgentAuth; checkedAt: number }>()
  private probing = new Map<string, Promise<void>>()
  private waiting: (() => void)[] = []
  private active = 0
  /** Sign-in or sign-out terminal per agent, while the process runs. */
  private terminalOf = new Map<string, { id: string; kind: 'login' | 'logout' }>()
  /** Launch in progress per agent (registered synchronously): two simultaneous requests don't open two terminals. */
  private launching = new Map<string, { kind: 'login' | 'logout'; run: Promise<TerminalInfo> }>()
  /** Scan in progress: whoever asks for one while it runs reuses its outcome. */
  private scanning: Promise<void> | null = null
  private scanSeq = 0
  private appliedSeq = 0
  private registryFailedAt = 0

  constructor(private readonly deps: OtherAgentsDeps) {}

  /**
   * List; starts in the background the missing or stale probes (outcomes as `agent.connection` events), but only for agents already
   * added: a program detected in the PATH and never added doesn't start on its own (it could launch the user's MCP servers or
   * updates). For those the probe starts with "Check again" or after a sign-in launched by Ladder.
   */
  async list(): Promise<OtherAgentConnection[]> {
    await this.scan()
    for (const base of this.base.values()) {
      const view = this.view(base)
      if (base.added && base.probe && base.installed && (view.checkedAt === null || Date.now() - view.checkedAt > STALE_MS)) void this.probe(base.id)
    }
    return [...this.base.values()].map((base) => this.view(base))
  }

  /** Rereads the program and repeats the probe; replies with the updated row. */
  async refresh(id: string): Promise<OtherAgentConnection> {
    await this.scan(true)
    const base = this.base.get(id)
    if (!base) throw new Error(t('Unknown ACP agent.'))
    if (base.probe && base.installed) await this.probe(id)
    return this.view(this.base.get(id) ?? base)
  }

  /**
   * Sign-in (`login`) or sign-out (`logout`) with the agent's CLI, in a `run` terminal of the project. When the process ends the probe is repeated.
   * One launch at a time per agent: the same request twice reuses the launch in progress, the other (logout during a login) is refused.
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
    // One terminal per agent at a time: if the previous one is still running it is reused (same kind) or the request is refused.
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
    // Without a known command and for an ACP-only program, launching it alone would leave it idle on stdin.
    if (kind === 'login' && !known?.login && ACP_ONLY.test(base.exe ?? '')) throw new Error(t('{agent} has no command to sign in from. Sign in from the agent’s own app or CLI.', { agent: base.name }))
    if (live) await this.deps.terminals.close(live.id)
    const project = this.deps.project(projectId)
    const command = [shellQuote(base.path), ...args.map(shellQuote)].join(' ')
    const title = kind === 'login' ? t('Sign in to {agent}', { agent: base.name }) : t('Sign out of {agent}', { agent: base.name })
    // Same criterion as the probe: agent entry applied and API keys removed (the login and subscription count). The terminal is an
    // interactive login shell: a user's .zshrc may re-export them, and then those apply (as for any of their terminals).
    const env = Object.fromEntries(Object.entries(base.probe?.env ?? {}).filter(([key]) => !/^(ANTHROPIC_|CLAUDE|DYLD_|LD_)/.test(key) && key !== 'NODE_OPTIONS'))
    const info = this.deps.terminals.spawn({ projectId: project.id, sessionId: null, kind: 'run', title, cwd: project.path, command, env, unsetEnv: STRIP_ENV, port: null })
    this.terminalOf.set(id, { id: info.id, kind })
    this.deps.emit(this.view(base))
    void this.deps.terminals.onceExit(info.id).then(async () => {
      if (this.terminalOf.get(id)?.id === info.id) this.terminalOf.delete(id)
      // The terminal is gone: the row says so right away, before the probe.
      const current = this.base.get(id) ?? base
      this.deps.emit(this.view(current))
      // Even if the process exited with an error or the terminal was closed: the state is always reread (after a probe already in progress, which is older).
      if (current.probe) {
        await this.probing.get(id)
        await this.probe(id)
      }
    })
    return info
  }

  /** Probe of an agent: one at a time per id, at most MAX_PROBES together. Never an exception: an unknown outcome is `unknown`. */
  private probe(id: string): Promise<void> {
    const running = this.probing.get(id)
    if (running) return running
    const run = (async () => {
      const base = this.base.get(id)
      if (!base?.probe) return
      if (this.active >= MAX_PROBES) await new Promise<void>((resolve) => this.waiting.push(resolve))
      else this.active++
      try {
        // The scan already found the path: no other login shell to find it again.
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
    // The row switches right away to "checking": the probe can take 25 seconds.
    const started = this.base.get(id)
    if (started) this.deps.emit(this.view(started))
    return run
  }

  /** Full row: the agent's facts + state of the last probe or, if more recent, of the last saved login (a chat session, `agents.authenticate`). */
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

  /** Looks up the programs (login shell PATH) and rebuilds the facts of each curated or added agent. */
  private scan(force = false): Promise<void> {
    if (this.scanning && !force) return this.scanning
    // A scan older than one already applied doesn't overwrite: the latest one started always wins.
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
    // Registry unreachable: the names of the added entries and the id remain; don't retry within a minute (the request can take 15 seconds).
    if (Date.now() - this.registryFailedAt > 60_000) {
      try {
        entries = await loadRegistry()
      } catch {
        this.registryFailedAt = Date.now()
      }
    }
    // Curated entries and ones written by hand or added with a name in the PATH: a single login shell round for all.
    const bare = [...specs.values()].filter((s) => !s.command.includes('/') && s.command !== 'npx' && s.command !== 'uvx').map((s) => s.command)
    const found = await whichManyInShell([...CURATED.map((c) => c.exe), ...bare])
    const detected = new Map<string, string>()
    for (const c of CURATED) {
      const path = found.get(c.exe)
      if (path) detected.set(c.id, path)
    }
    // The ACP adapters of Claude and Codex have their own row: they are not "other agents".
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
      // Added with npx/uvx and no local CLI: not probed (it would download the package).
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
    // The version costs a program launch: cliVersion caches it by path and modification time.
    await Promise.all([...next.values()].map(async (base) => {
      if (base.path) base.version = await cliVersion(base.path)
    }))
    return next
  }
}
