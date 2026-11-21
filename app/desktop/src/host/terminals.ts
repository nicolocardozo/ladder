// Terminali dell'host: PTY con node-pty, una copia headless di xterm per ricostruire lo schermo quando la UI
// si ricollega, e lo stato delle sessioni terminale (vedi spikes/terminal-hooks):
// - claude: hook iniettati per processo con --settings, verso un piccolo server locale con token;
// - codex: notifiche OSC 9 della TUI ("Approval requested: …" e fine turno);
// - altre CLI: euristiche su output e campanello, con l'etichetta "stato stimato".
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import * as pty from 'node-pty'
import { Terminal as Headless } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { getLocale, t } from '@shared/i18n'
import type { TerminalInfo } from '@shared/protocol'
import type { Db } from './db'

const run = promisify(execFile)

const FLUSH_MS = 16
const SCROLLBACK = 5000
/** Scrollback salvato alla chiusura, per rivedere l'output dopo il riavvio. */
const SAVED_BYTES = 256 * 1024

export type AgentKind = 'claude' | 'codex' | 'generic'

/** Segnali di stato di una sessione terminale, tradotti dall'host in stato della sessione. */
export type AgentSignal =
  | { type: 'ready' }
  | { type: 'turn-start'; prompt: string | null }
  | { type: 'running'; activity: string | null; estimated: boolean }
  | { type: 'waiting'; label: string; activity: string | null; estimated: boolean }
  | { type: 'done'; estimated: boolean }
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null }

export interface AgentSpec {
  kind: AgentKind
  /** Id della conversazione di Claude Code: --session-id al primo avvio, --resume dopo. */
  claudeSessionId?: string
  resume?: boolean
}

export interface SpawnOptions {
  projectId: string
  sessionId: string | null
  kind: TerminalInfo['kind']
  title: string
  cwd: string
  /** Senza comando: shell di login interattiva. */
  command: string | null
  /** Eseguibile e argomenti espliciti (CLI degli agenti); altrimenti `command` passa dalla shell. */
  file?: string
  args?: string[]
  env?: Record<string, string>
  port: number | null
  agent?: AgentSpec
  cols?: number
  rows?: number
}

interface Live {
  info: TerminalInfo
  options: SpawnOptions
  proc: pty.IPty | null
  screen: Headless
  serializer: SerializeAddon
  pending: string
  timer: NodeJS.Timeout | null
  token: string
  agent: AgentTracker | null
}

export interface TerminalEvents {
  upsert: (terminal: TerminalInfo) => void
  removed: (id: string) => void
  data: (id: string, data: string) => void
  agent: (terminal: TerminalInfo, signal: AgentSignal) => void
}

interface TerminalRow {
  id: string
  project_id: string
  session_id: string | null
  kind: string
  title: string
  cwd: string
  command: string | null
  created_at: number
  scrollback: string | null
  meta: string | null
}

export class TerminalManager {
  private terminals = new Map<string, Live>()
  private server: Server | null = null
  private hookUrl = ''
  private loginPath: string | null = null
  private exitWaiters = new Map<string, ((code: number | null) => void)[]>()

  constructor(
    private readonly db: Db,
    private readonly events: TerminalEvents
  ) {}

  async init(): Promise<void> {
    this.loginPath = await loginShellPath()
    await this.startHookServer()
    // Terminali della volta precedente: tornano come "fermi" con il loro output, il processo non c'è più.
    for (const row of this.db.prepare('select * from terminals order by created_at').all() as unknown as TerminalRow[]) {
      const meta = row.meta ? (JSON.parse(row.meta) as { port?: number | null; options?: Partial<SpawnOptions> }) : {}
      const options: SpawnOptions = {
        projectId: row.project_id,
        sessionId: row.session_id,
        kind: row.kind as TerminalInfo['kind'],
        title: row.title,
        cwd: row.cwd,
        command: row.command,
        port: meta.port ?? null,
        ...(meta.options ?? {})
      }
      const live = this.createLive(row.id, options, row.created_at)
      live.info.state = 'stopped'
      if (row.scrollback) live.screen.write(row.scrollback)
      this.terminals.set(row.id, live)
    }
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((t) => t.info)
  }

  get(id: string): TerminalInfo | null {
    return this.terminals.get(id)?.info ?? null
  }

  bySession(sessionId: string, kind?: TerminalInfo['kind']): TerminalInfo[] {
    return this.list().filter((t) => t.sessionId === sessionId && (!kind || t.kind === kind))
  }

  /** Apre un nuovo terminale e avvia il processo. */
  spawn(options: SpawnOptions): TerminalInfo {
    const id = randomUUID()
    const live = this.createLive(id, options, Date.now())
    this.terminals.set(id, live)
    this.db
      .prepare('insert into terminals (id, project_id, session_id, kind, title, cwd, command, created_at, meta) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, options.projectId, options.sessionId, options.kind, options.title, options.cwd, options.command, live.info.createdAt, JSON.stringify(this.meta(options)))
    this.start(live)
    return live.info
  }

  /** Si risolve quando il processo del terminale esce (subito se non sta girando). */
  onceExit(id: string): Promise<number | null> {
    const live = this.terminals.get(id)
    if (!live || !live.proc) return Promise.resolve(live?.info.exitCode ?? null)
    return new Promise((resolve) => {
      const list = this.exitWaiters.get(id) ?? []
      list.push(resolve)
      this.exitWaiters.set(id, list)
    })
  }

  private resolveExit(id: string, code: number | null): void {
    const list = this.exitWaiters.get(id)
    this.exitWaiters.delete(id)
    for (const resolve of list ?? []) resolve(code)
  }

  /** Riavvia il processo nello stesso terminale: l'output precedente resta sopra. */
  restart(id: string, patch: Partial<SpawnOptions> = {}): TerminalInfo {
    const live = this.must(id)
    live.proc?.kill()
    live.proc = null
    live.options = { ...live.options, ...patch }
    this.db.prepare('update terminals set command = ?, meta = ? where id = ?').run(live.options.command, JSON.stringify(this.meta(live.options)), id)
    this.write(live, `\r\n\x1b[2m— ${t('restarted')} —\x1b[0m\r\n`)
    this.start(live)
    return live.info
  }

  /** Stato dello schermo per una UI che si collega. Una shell ferma riparte qui. */
  attach(id: string, cols: number, rows: number): string {
    const live = this.must(id)
    if (live.info.state === 'stopped' && live.info.kind === 'shell') {
      this.write(live, `\r\n\x1b[2m— ${t('Ladder was restarted: new shell')} —\x1b[0m\r\n`)
      this.start(live, cols, rows)
    } else this.resize(id, cols, rows)
    this.flush(live)
    return live.serializer.serialize({ scrollback: SCROLLBACK })
  }

  input(id: string, data: string): void {
    const live = this.terminals.get(id)
    if (!live?.proc) return
    live.agent?.onInput(data)
    live.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const live = this.terminals.get(id)
    if (!live || cols < 2 || rows < 1) return
    if (live.screen.cols !== cols || live.screen.rows !== rows) live.screen.resize(cols, rows)
    try {
      live.proc?.resize(cols, rows)
    } catch {
      // Il processo è appena uscito.
    }
  }

  close(id: string): void {
    const live = this.terminals.get(id)
    if (!live) return
    const proc = live.proc
    // Prima si stacca il processo, così la sua uscita non arriva a un terminale già chiuso.
    live.proc = null
    proc?.kill()
    this.resolveExit(id, null)
    live.agent?.dispose()
    live.screen.dispose()
    if (live.timer) clearTimeout(live.timer)
    this.terminals.delete(id)
    this.db.prepare('delete from terminals where id = ?').run(id)
    this.events.removed(id)
  }

  /** Testo semplice delle ultime righe, come lo vedi sullo schermo: per @terminal. */
  output(id: string, lines = 200): string {
    const live = this.must(id)
    this.flush(live)
    const buffer = live.screen.buffer.active
    // Si parte dall'ultima riga scritta: sotto, in un terminale appena aperto, c'è solo schermo vuoto.
    let end = buffer.length
    while (end > 0 && !buffer.getLine(end - 1)?.translateToString(true).trim()) end--
    const out: string[] = []
    for (let i = Math.max(0, end - lines * 3); i < end; i++) {
      const line = buffer.getLine(i)
      if (!line) continue
      const text = line.translateToString(true)
      if (line.isWrapped && out.length > 0) out[out.length - 1] += text
      else out.push(text)
    }
    while (out.length > 0 && !out[out.length - 1].trim()) out.pop()
    return out.slice(-lines).join('\n')
  }

  /** Comando di `kill` per tutti i processi e scrollback salvato per il prossimo avvio. */
  shutdown(): void {
    const save = this.db.prepare('update terminals set scrollback = ? where id = ?')
    for (const live of this.terminals.values()) {
      this.flush(live)
      try {
        let data = live.serializer.serialize({ scrollback: 1000 })
        if (data.length > SAVED_BYTES) data = data.slice(data.length - SAVED_BYTES)
        save.run(data, live.info.id)
      } catch {
        // Lo scrollback è una comodità.
      }
      live.proc?.kill()
    }
    this.server?.close()
  }

  // ── Interni ──────────────────────────────────────────────────────────────

  private meta(options: SpawnOptions) {
    // Si salva quanto serve per riavviare: niente variabili d'ambiente.
    return { port: options.port, options: { file: options.file, args: options.args, agent: options.agent } }
  }

  private must(id: string): Live {
    const live = this.terminals.get(id)
    if (!live) throw new Error(t('Terminal not found.'))
    return live
  }

  private createLive(id: string, options: SpawnOptions, createdAt: number): Live {
    const screen = new Headless({ cols: options.cols ?? 100, rows: options.rows ?? 30, scrollback: SCROLLBACK, allowProposedApi: true })
    const serializer = new SerializeAddon()
    screen.loadAddon(serializer as never)
    const live: Live = {
      info: {
        id,
        projectId: options.projectId,
        sessionId: options.sessionId,
        kind: options.kind,
        title: options.title,
        cwd: options.cwd,
        command: options.command,
        state: 'running',
        exitCode: null,
        createdAt,
        port: options.port
      },
      options,
      proc: null,
      screen,
      serializer,
      pending: '',
      timer: null,
      token: randomBytes(24).toString('hex'),
      agent: null
    }
    if (options.agent) {
      live.agent = new AgentTracker(options.agent.kind, (signal) => this.events.agent(live.info, signal))
      if (options.agent.kind === 'codex') {
        // La TUI di Codex manda OSC 9 all'approvazione e a fine turno.
        screen.parser.registerOscHandler(9, (data) => {
          live.agent?.onOsc9(data)
          return false
        })
      }
      screen.onBell(() => live.agent?.onBell())
    }
    return live
  }

  private start(live: Live, cols?: number, rows?: number): void {
    const { options } = live
    const env = this.env(live)
    const shell = process.env.SHELL || '/bin/zsh'
    let file: string
    let args: string[]
    if (options.file) {
      file = options.file
      args = this.agentArgs(live, options.args ?? [])
    } else if (options.command) {
      file = shell
      args = ['-l', '-i', '-c', options.command]
    } else {
      file = shell
      args = ['-l', '-i']
    }
    let proc: pty.IPty
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: cols ?? live.screen.cols,
        rows: rows ?? live.screen.rows,
        cwd: options.cwd,
        env
      })
    } catch (error) {
      live.info = { ...live.info, state: 'exited', exitCode: null }
      this.write(live, `\r\n\x1b[31m${t('Can’t start {file}: {message}', { file: basename(file), message: (error as Error).message })}\x1b[0m\r\n`)
      this.events.upsert(live.info)
      live.agent?.onExit(null)
      this.resolveExit(live.info.id, null)
      return
    }
    if (cols && rows && (live.screen.cols !== cols || live.screen.rows !== rows)) live.screen.resize(cols, rows)
    live.proc = proc
    live.info = { ...live.info, state: 'running', exitCode: null }
    live.agent?.reset()
    proc.onData((data) => {
      if (live.proc !== proc) return
      this.write(live, data)
      live.agent?.onOutput()
    })
    proc.onExit(({ exitCode }) => {
      if (live.proc !== proc) return
      live.proc = null
      live.info = { ...live.info, state: 'exited', exitCode }
      const tone = exitCode === 0 ? '2' : '31'
      const ended = exitCode === 0 ? t('[process exited]') : t('[process exited with code {code}]', { code: exitCode })
      this.write(live, `\r\n\x1b[${tone}m${ended}\x1b[0m\r\n`)
      this.events.upsert(live.info)
      live.agent?.onExit(exitCode)
      this.resolveExit(live.info.id, exitCode)
    })
    this.events.upsert(live.info)
  }

  /** Argomenti della CLI di un agente con l'aggancio per lo stato. */
  private agentArgs(live: Live, args: string[]): string[] {
    const agent = live.options.agent
    if (agent?.kind === 'claude') {
      const url = `${this.hookUrl}/hook/${live.info.id}`
      const curl = (event: string) => `curl -s -o /dev/null -m 5 -H "X-Ladder-Token: $LADDER_HOOK_TOKEN" --data-binary @- ${url}/${event}`
      const hooks: Record<string, unknown[]> = {}
      for (const event of ['SessionStart', 'SessionEnd']) hooks[event] = [{ hooks: [{ type: 'command', command: curl(event), timeout: 10 }] }]
      for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure']) {
        hooks[event] = [
          {
            hooks: [
              {
                type: 'http',
                url: `${url}/${event}`,
                timeout: 10,
                headers: { 'X-Ladder-Token': '$LADDER_HOOK_TOKEN' },
                allowedEnvVars: ['LADDER_HOOK_TOKEN']
              }
            ]
          }
        ]
      }
      const session = agent.claudeSessionId ? (agent.resume ? ['--resume', agent.claudeSessionId] : ['--session-id', agent.claudeSessionId]) : []
      return [...session, '--settings', JSON.stringify({ hooks }), ...args]
    }
    if (agent?.kind === 'codex') {
      return [
        '-c',
        'tui.notifications=["agent-turn-complete","approval-requested"]',
        '-c',
        'tui.notification_method="osc9"',
        '-c',
        'tui.notification_condition="always"',
        ...args
      ]
    }
    return args
  }

  private env(live: Live): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      // Niente variabili di Electron, dell'host e della sessione di Claude Code da cui Ladder potrebbe essere partito.
      if (/^(ELECTRON_|LADDER_|ANTHROPIC_|CLAUDE|CHROME_|VSCODE_|npm_)/.test(key) || key === 'NODE_OPTIONS') continue
      env[key] = value
    }
    if (this.loginPath) env.PATH = this.loginPath
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'Ladder'
    env.LANG ??= getLocale() === 'it' ? 'it_IT.UTF-8' : 'en_US.UTF-8'
    env.HOME ??= homedir()
    if (live.info.port !== null) env.LADDER_PORT = String(live.info.port)
    if (live.options.agent?.kind === 'claude') {
      env.LADDER_HOOK_TOKEN = live.token
      env.DISABLE_AUTOUPDATER = '1'
    }
    return { ...env, ...(live.options.env ?? {}) }
  }

  private write(live: Live, data: string): void {
    live.screen.write(data)
    live.pending += data
    live.timer ??= setTimeout(() => this.flush(live), FLUSH_MS)
  }

  private flush(live: Live): void {
    if (live.timer) clearTimeout(live.timer)
    live.timer = null
    if (!live.pending) return
    const data = live.pending
    live.pending = ''
    this.events.data(live.info.id, data)
  }

  /** Server degli hook di Claude Code: solo 127.0.0.1, token per terminale, risposta 200 vuota (mai una decisione). */
  private startHookServer(): Promise<void> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        const match = /^\/hook\/([0-9a-f-]{36})\/([A-Za-z]+)$/.exec(req.url ?? '')
        const live = match ? this.terminals.get(match[1]) : undefined
        const token = req.headers['x-ladder-token']
        if (req.method !== 'POST' || !match || !live || token !== live.token) {
          res.writeHead(404)
          res.end()
          req.resume()
          return
        }
        let body = ''
        req.on('data', (chunk: Buffer) => {
          if (body.length < 512 * 1024) body += chunk.toString()
        })
        req.on('end', () => {
          res.writeHead(200)
          res.end()
          let payload: Record<string, unknown> = {}
          try {
            payload = JSON.parse(body) as Record<string, unknown>
          } catch {
            // Corpo vuoto o non JSON: conta solo l'evento.
          }
          live.agent?.onHook(match[2], payload)
        })
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        this.hookUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
        resolve()
      })
      server.on('error', () => resolve())
      this.server = server
    })
  }
}

/** PATH della shell di login: un'app avviata dal Finder ne ha uno ridotto. */
async function loginShellPath(): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const { stdout } = await run(shell, ['-lc', 'printf "%s" "$PATH"'], { timeout: 5000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Testo breve di un'attività da un hook di Claude Code. */
function hookActivity(payload: Record<string, unknown>): string | null {
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : null
  const input = (payload.tool_input ?? {}) as Record<string, unknown>
  if (!tool) return null
  const first = (value: unknown) => (typeof value === 'string' ? value.split('\n')[0].slice(0, 80) : null)
  const file = () => (first(input.file_path) ? basename(String(input.file_path)) : t('a file'))
  if (tool === 'Bash') return t('Runs {command}', { command: first(input.command) ?? t('a command') })
  if (tool === 'Read') return t('Reads {file}', { file: file() })
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write') return t('Edits {file}', { file: file() })
  if (tool === 'Grep' || tool === 'Glob') return t('Searches {pattern}', { pattern: first(input.pattern) ?? '' }).trim()
  if (tool === 'WebFetch' || tool === 'WebSearch') return t('Searches the web')
  return t('Uses {tool}', { tool })
}

/**
 * Macchina a stati di una sessione terminale (tabelle in spikes/terminal-hooks/README.md).
 * Un rifiuto con Esc non manda segnali: dopo un tasto in attesa si passa allo stato stimato,
 * e per Claude Code si controlla la coda della trascrizione.
 */
class AgentTracker {
  private state: 'starting' | 'idle' | 'running' | 'waiting' = 'starting'
  private transcript: string | null = null
  private fallback: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private lastInput = 0
  private runningSince = 0

  constructor(
    private readonly kind: AgentKind,
    private readonly emit: (signal: AgentSignal) => void
  ) {}

  reset(): void {
    this.state = 'starting'
    this.clearTimers()
  }

  dispose(): void {
    this.clearTimers()
  }

  private clearTimers(): void {
    if (this.fallback) clearTimeout(this.fallback)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.fallback = null
    this.idleTimer = null
  }

  private set(state: AgentTracker['state'], signal: AgentSignal): void {
    this.state = state
    if (state === 'running' && !this.runningSince) this.runningSince = Date.now()
    if (state !== 'running') this.runningSince = 0
    this.emit(signal)
  }

  onHook(event: string, payload: Record<string, unknown>): void {
    if (this.kind !== 'claude') return
    if (this.fallback) {
      clearTimeout(this.fallback)
      this.fallback = null
    }
    const isQuestion = payload.tool_name === 'AskUserQuestion'
    switch (event) {
      case 'SessionStart':
        if (typeof payload.transcript_path === 'string') this.transcript = payload.transcript_path
        if (this.state === 'starting') this.set('idle', { type: 'ready' })
        return
      case 'UserPromptSubmit':
        this.emit({ type: 'turn-start', prompt: typeof payload.prompt === 'string' ? payload.prompt : null })
        this.set('running', { type: 'running', activity: t('Thinking…'), estimated: false })
        return
      case 'PreToolUse':
        if (isQuestion) this.set('waiting', { type: 'waiting', label: t('Question'), activity: null, estimated: false })
        else this.set('running', { type: 'running', activity: hookActivity(payload), estimated: false })
        return
      case 'PostToolUse':
        this.set('running', { type: 'running', activity: t('Thinking…'), estimated: false })
        return
      case 'PermissionRequest':
        if (isQuestion) this.set('waiting', { type: 'waiting', label: t('Question'), activity: null, estimated: false })
        else this.set('waiting', { type: 'waiting', label: t('Approval'), activity: hookActivity(payload), estimated: false })
        return
      case 'Notification':
        // permission_prompt arriva 6 s dopo PermissionRequest: serve solo se quello è mancato. idle_prompt è un falso "in attesa".
        if (payload.notification_type === 'permission_prompt' && this.state !== 'waiting')
          this.set('waiting', { type: 'waiting', label: t('Approval'), activity: null, estimated: false })
        return
      case 'Stop':
        this.set('idle', { type: 'done', estimated: false })
        return
      case 'StopFailure':
        this.state = 'idle'
        this.emit({ type: 'error', message: typeof payload.error === 'string' ? payload.error : t('agent error') })
        return
    }
  }

  onOsc9(data: string): void {
    if (this.kind !== 'codex') return
    if (/^Approval requested/i.test(data)) {
      const what = data.replace(/^Approval requested:\s*/i, '').slice(0, 80)
      this.set('waiting', { type: 'waiting', label: t('Approval'), activity: what ? t('Asks to run {command}', { command: what }) : null, estimated: false })
    } else if (this.state === 'running' || this.state === 'waiting') {
      this.set('idle', { type: 'done', estimated: false })
    }
  }

  onBell(): void {
    // Codex manda OSC 9; per le altre CLI il campanello è l'unico segnale che chiedono qualcosa.
    if (this.kind === 'generic' && this.state !== 'waiting') this.set('waiting', { type: 'waiting', label: t('Needs you'), activity: null, estimated: true })
  }

  onInput(data: string): void {
    this.lastInput = Date.now()
    const enter = data.includes('\r')
    const escape = data === '\x1b'
    if (this.state === 'waiting') {
      if (this.kind === 'generic') {
        this.set('running', { type: 'running', activity: null, estimated: true })
        return
      }
      if (!enter && !escape && !/^[0-9yYnN]$/.test(data)) return
      // Nessun hook segnala la risposta: si stima subito e, per Claude Code, si verifica sulla trascrizione.
      const denied = escape || /^[nN]$/.test(data)
      if (this.fallback) clearTimeout(this.fallback)
      this.fallback = setTimeout(() => void this.checkAfterAnswer(denied), 1200)
      return
    }
    if (enter && (this.state === 'idle' || this.state === 'starting') && this.kind === 'codex') {
      this.emit({ type: 'turn-start', prompt: null })
      this.set('running', { type: 'running', activity: t('Working…'), estimated: false })
    }
  }

  private async checkAfterAnswer(denied: boolean): Promise<void> {
    this.fallback = null
    if (this.state !== 'waiting') return
    let interrupted = denied
    if (this.kind === 'claude' && this.transcript) {
      const tail = await readTail(this.transcript, 16 * 1024)
      if (tail !== null) interrupted = /Request interrupted by user/.test(tail.slice(-4000))
    }
    if (interrupted) this.set('idle', { type: 'done', estimated: true })
    else this.set('running', { type: 'running', activity: null, estimated: true })
  }

  onOutput(): void {
    if (this.kind !== 'generic') return
    // L'eco dei tasti non conta come lavoro.
    if (Date.now() - this.lastInput < 300) return
    if (this.state !== 'running' && this.state !== 'waiting') this.set('running', { type: 'running', activity: null, estimated: true })
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.state !== 'running') return
      const long = Date.now() - this.runningSince > 3000
      this.set('idle', long ? { type: 'done', estimated: true } : { type: 'ready' })
    }, 2000)
  }

  onExit(code: number | null): void {
    this.clearTimers()
    this.state = 'idle'
    this.emit({ type: 'exit', code })
  }
}

async function readTail(path: string, bytes: number): Promise<string | null> {
  try {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, bytes)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}
