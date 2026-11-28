// Terminal tools of the `ladder` MCP server: an agent runs a command in a terminal of its session that the user can see,
// in the session's folder (its worktree, when it has one), and reads its output. For builds, dev servers and scripts the
// user would otherwise copy from the chat and run by hand, often from the wrong folder.
// Permission follows the session's level: Plan cannot run anything, Ask and Edit ask the user with a card, Full runs.
// Texts are for the agent (English); only the approval card, which the user sees, goes through `t`.
// No path aliases: scripts/cli.test.mts may import it directly.
import type { PermissionLevel, TerminalInfo } from '../shared/protocol'

export type TerminalTool = 'run_in_terminal' | 'read_terminal' | 'stop_terminal'
export const TERMINAL_TOOLS: ReadonlySet<string> = new Set<TerminalTool>(['run_in_terminal', 'read_terminal', 'stop_terminal'])

export const TERMINAL_LIMITS = { command: 4000, title: 80, waitSec: 600, waitDefaultSec: 30, lines: 400, linesDefault: 120, running: 6, outputChars: 12_000 }

export interface TerminalCaller {
  projectId: string
  permission: PermissionLevel
  /** Chat session not archived: it can still start processes. */
  usable: boolean
}

export interface AgentTerminalsDeps {
  t(text: string, vars?: Record<string, string | number>): string
  info(sessionId: string): TerminalCaller | null
  /** Starts the command in a new terminal of the session, in its folder. */
  spawn(sessionId: string, command: string, title: string): TerminalInfo
  get(terminalId: string): TerminalInfo | null
  /** Terminals that belong to the session (its shell, start actions, services, the agent's commands). */
  list(sessionId: string): TerminalInfo[]
  output(terminalId: string, lines: number): string
  onceExit(terminalId: string): Promise<number | null>
  stop(terminalId: string): Promise<void>
  /** Approval card. false if the user refuses or does not answer. */
  confirm(sessionId: string, title: string, reason: string, signal: AbortSignal): Promise<boolean>
}

type Answer = { text: string; isError: boolean }
const fail = (text: string): Answer => ({ text, isError: true })
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clip = (value: string, max: number) => (value.length > max ? `…${value.slice(value.length - max + 1)}` : value)

/** Short title for the terminal tab: the first non-empty line of the command. */
export function commandTitle(command: string, max = TERMINAL_LIMITS.title): string {
  const line = command
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  const flat = (line ?? command.trim()).replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export class AgentTerminals {
  private readonly deps: AgentTerminalsDeps

  constructor(deps: AgentTerminalsDeps) {
    this.deps = deps
  }

  async call(sessionId: string, tool: string, raw: unknown, signal: AbortSignal): Promise<Answer> {
    const caller = this.deps.info(sessionId)
    if (!caller?.usable) return fail('This session is no longer active.')
    const input = raw === undefined || raw === null ? {} : raw
    if (!isObj(input)) return fail('Arguments must be an object.')
    switch (tool) {
      case 'run_in_terminal':
        return this.run(sessionId, caller, input, signal)
      case 'read_terminal':
        return this.read(sessionId, input, signal)
      case 'stop_terminal':
        return this.stopOne(sessionId, caller, input)
      default:
        return fail('Unknown tool.')
    }
  }

  private waitSec(input: Record<string, unknown>): number | Answer {
    const value = input.wait_sec
    if (value === undefined) return TERMINAL_LIMITS.waitDefaultSec
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > TERMINAL_LIMITS.waitSec) return fail(`wait_sec must be an integer from 0 to ${TERMINAL_LIMITS.waitSec}.`)
    return value
  }

  private async run(sessionId: string, caller: TerminalCaller, input: Record<string, unknown>, signal: AbortSignal): Promise<Answer> {
    for (const key of Object.keys(input)) if (!['command', 'title', 'wait_sec'].includes(key)) return fail(`Unexpected argument "${key.slice(0, 40)}".`)
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (!command) return fail('"command" is required.')
    if (command.length > TERMINAL_LIMITS.command) return fail(`"command" must be at most ${TERMINAL_LIMITS.command} characters.`)
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > TERMINAL_LIMITS.title)) return fail(`"title" must be a text up to ${TERMINAL_LIMITS.title} characters.`)
    const wait = this.waitSec(input)
    if (typeof wait !== 'number') return wait
    if (caller.permission === 'plan') return fail('This session is read-only (Plan), so it cannot run commands. Tell the user the command instead, or ask them to raise the permission level.')
    const running = this.running(sessionId)
    if (running >= TERMINAL_LIMITS.running) return fail(`You already have ${running} commands running in terminals. Stop one with stop_terminal before starting another.`)

    const title = (typeof input.title === 'string' && input.title.trim()) || commandTitle(command)
    // Below Full access the user approves each command, as for the agent's own shell tool.
    if (caller.permission !== 'full') {
      const allowed = await this.deps.confirm(sessionId, this.deps.t('Run in a terminal'), command, signal)
      if (!allowed) return fail('The user did not allow running this command. Do not try again unless the user asks you to.')
      // The card can stay open for a while: the session may have closed, dropped to Plan, or started other commands meanwhile.
      const now = this.deps.info(sessionId)
      if (!now?.usable) return fail('This session is closed, so nothing was run.')
      if (now.permission === 'plan') return fail('The session is now read-only (Plan), so nothing was run.')
      if (this.running(sessionId) >= TERMINAL_LIMITS.running) return fail('Too many of your commands are already running. Stop one with stop_terminal first.')
    }
    const terminal = this.deps.spawn(sessionId, command, title)
    return this.report(terminal.id, wait, TERMINAL_LIMITS.linesDefault, signal)
  }

  private running(sessionId: string): number {
    return this.deps.list(sessionId).filter((term) => term.kind === 'run' && term.origin === 'agent' && term.state === 'running').length
  }

  private own(sessionId: string, input: Record<string, unknown>): TerminalInfo | Answer {
    const id = typeof input.terminalId === 'string' ? input.terminalId : ''
    const terminal = id ? this.deps.get(id) : null
    if (!terminal || terminal.sessionId !== sessionId) return fail('No terminal with this terminalId in your session. Use the id returned by run_in_terminal.')
    return terminal
  }

  private async read(sessionId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<Answer> {
    for (const key of Object.keys(input)) if (!['terminalId', 'lines', 'wait_sec'].includes(key)) return fail(`Unexpected argument "${key.slice(0, 40)}".`)
    const terminal = this.own(sessionId, input)
    if ('isError' in terminal) return terminal
    const lines = input.lines === undefined ? TERMINAL_LIMITS.linesDefault : input.lines
    if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > TERMINAL_LIMITS.lines) return fail(`lines must be an integer from 1 to ${TERMINAL_LIMITS.lines}.`)
    const wait = input.wait_sec === undefined ? 0 : this.waitSec(input)
    if (typeof wait !== 'number') return wait
    return this.report(terminal.id, wait, lines, signal)
  }

  private async stopOne(sessionId: string, caller: TerminalCaller, input: Record<string, unknown>): Promise<Answer> {
    for (const key of Object.keys(input)) if (key !== 'terminalId') return fail(`Unexpected argument "${key.slice(0, 40)}".`)
    const terminal = this.own(sessionId, input)
    if ('isError' in terminal) return terminal
    if (caller.permission === 'plan') return fail('This session is read-only (Plan), so it cannot stop processes.')
    // Only what the agent started: the user's shell, Run buttons, start actions and the worktree's services are the user's.
    if (terminal.origin !== 'agent') return fail('You can only stop commands you started with run_in_terminal. Ask the user to stop this one.')
    await this.deps.stop(terminal.id)
    // The pty reports the exit a moment after the processes are gone: a short wait keeps the state accurate.
    return this.report(terminal.id, 2, 40, new AbortController().signal)
  }

  /** Waits up to `waitSec` for the process to end, then describes the terminal: state, exit code and the last lines. */
  private async report(terminalId: string, waitSec: number, lines: number, signal: AbortSignal): Promise<Answer> {
    const current = this.deps.get(terminalId)
    if (current?.state === 'running' && waitSec > 0) {
      let timer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined
      await Promise.race([
        this.deps.onceExit(terminalId),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, waitSec * 1000))),
        new Promise<void>((resolve) => {
          onAbort = () => resolve()
          signal.addEventListener('abort', onAbort, { once: true })
        })
      ])
      clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
    const terminal = this.deps.get(terminalId)
    if (!terminal) return fail('The terminal was closed by the user.')
    let output = ''
    try {
      output = clip(this.deps.output(terminalId, lines), TERMINAL_LIMITS.outputChars)
    } catch {
      output = ''
    }
    const head = JSON.stringify({ terminalId, title: terminal.title, cwd: terminal.cwd, state: terminal.state, exitCode: terminal.exitCode })
    const next =
      terminal.state === 'running'
        ? 'Still running in a terminal the user can see. Call read_terminal with this terminalId (and wait_sec to wait for it to end) to follow it, or stop_terminal to stop it. If it waits for input, ask the user to answer in that terminal.'
        : terminal.exitCode === 0
          ? 'The command ended successfully.'
          : 'The command ended with an error: read the output before trying again.'
    return { text: `${head}\n\n${next}\n\nOutput (last lines, as on screen):\n${output || '(no output)'}`, isError: false }
  }
}
