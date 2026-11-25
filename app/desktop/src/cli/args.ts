// Arguments of the `ladder` CLI: commands, options and help texts. No dependencies: scripts/cli.test.mts tests it.

export type FlagKind = 'bool' | 'value'

export interface CommandSpec {
  name: string
  usage: string
  summary: string
  flags: Record<string, FlagKind>
  /** Positional arguments: minimum and maximum. */
  min: number
  max: number
  help: string
}

const JSON_FLAG = { '--json': 'bool' } as const

export const COMMANDS: CommandSpec[] = [
  {
    name: 'projects',
    usage: 'ladder projects [--json]',
    summary: 'List the projects open in Ladder',
    flags: { ...JSON_FLAG },
    min: 0,
    max: 0,
    help: 'Prints the name and folder of every project in Ladder.'
  },
  {
    name: 'ls',
    usage: 'ladder ls [--project <name|path>] [--json]',
    summary: 'List sessions',
    flags: { ...JSON_FLAG, '--project': 'value' },
    min: 0,
    max: 0,
    help: 'Lists the sessions that are not archived. --project limits them to one project (name, folder path, or "." for the project that contains the current folder).'
  },
  {
    name: 'new',
    usage: 'ladder new <project> "<prompt>" [--agent <id>] [--model <id>] [--effort <level>] [--permission <level>] [--worktree] [--wait] [--json]',
    summary: 'Start a session and give it a prompt',
    flags: { ...JSON_FLAG, '--agent': 'value', '--model': 'value', '--effort': 'value', '--permission': 'value', '--worktree': 'bool', '--wait': 'bool', '--timeout': 'value' },
    min: 2,
    max: 2,
    help: [
      'Starts a chat session in <project> (name, folder path, or "." for the project that contains the current folder).',
      'The prompt is the second argument, or "-" to read it from standard input.',
      '  --agent       claude-code, codex or acp:<id>. Default: the project default in Ladder, then the last agent used there.',
      '  --model       model id. Default: the agent default.',
      '  --effort      low, medium, high, xhigh or max.',
      '  --permission  plan (read-only), ask, edit or full. Default: the project default in Ladder, else edit.',
      '  --worktree    work in a new git worktree.',
      '  --wait        wait for the end of the work and print the final answer (see "ladder wait" for exit codes).',
      '  --timeout     with --wait: seconds to wait (default 600, max 3600).',
      'Prints the session id.'
    ].join('\n')
  },
  {
    name: 'send',
    usage: 'ladder send <session> "<message>" [--wait] [--json]',
    summary: 'Send a message to a session',
    flags: { ...JSON_FLAG, '--wait': 'bool', '--timeout': 'value' },
    min: 2,
    max: 2,
    help: 'Sends a message to a session (id or unique id prefix). The message is the second argument, or "-" to read it from standard input. If the session is busy the message waits for the end of the turn. --wait then waits for the answer.'
  },
  {
    name: 'wait',
    usage: 'ladder wait <session> [--timeout <sec>] [--json]',
    summary: 'Wait for a session and print its final answer',
    flags: { ...JSON_FLAG, '--timeout': 'value' },
    min: 1,
    max: 1,
    help: [
      'Waits until the session has finished its work, then prints the final assistant text (with --json: the full result).',
      'Returns at once if the session is already idle. Default timeout 600 seconds, max 3600.',
      'Exit codes: 0 completed, 1 error, 2 interrupted, 3 needs you (an approval or question waits in Ladder), 4 timeout.'
    ].join('\n')
  },
  {
    name: 'attach',
    usage: 'ladder attach <session>',
    summary: 'Follow a session live',
    flags: {},
    min: 1,
    max: 1,
    help: 'Streams the new activity of a session as readable text: assistant text, tool lines, requests waiting for you in Ladder, and the end of each turn. Ctrl-C detaches and never stops the session.'
  },
  {
    name: 'stop',
    usage: 'ladder stop <session>',
    summary: 'Stop the current turn of a session',
    flags: {},
    min: 1,
    max: 1,
    help: 'Interrupts the turn the session is working on. The session stays open.'
  }
]

export interface Parsed {
  command: CommandSpec
  args: string[]
  flags: Record<string, string | boolean>
}

export type ParseResult = { ok: true; value: Parsed } | { ok: false; error: string; help: boolean }

export function mainHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 2
  return [
    'ladder: control Ladder sessions from the terminal',
    '',
    'Usage: ladder <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}${c.summary}`),
    '',
    'Run "ladder <command> --help" for the options of a command.',
    'Ladder must be open: the commands talk to the running app. LADDER_SOCKET overrides the socket path.'
  ].join('\n')
}

export function commandHelp(spec: CommandSpec): string {
  return `Usage: ${spec.usage}\n\n${spec.help}`
}

/** From the argument list (without node and the script) to the command, its arguments and options. `--help` is recognized in any position. */
export function parseArgs(argv: string[]): ParseResult {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') return { ok: false, error: '', help: true }
  const spec = COMMANDS.find((c) => c.name === argv[0])
  if (!spec) return { ok: false, error: `Unknown command "${argv[0]}". Run "ladder --help" for the list.`, help: false }
  const flags: Record<string, string | boolean> = {}
  const args: string[] = []
  const rest = argv.slice(1)
  if (rest.includes('--help') || rest.includes('-h')) return { ok: false, error: `help:${spec.name}`, help: true }
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token === '-' || !token.startsWith('--')) {
      args.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq >= 0 ? token.slice(0, eq) : token
    const kind = spec.flags[name]
    if (!kind) return { ok: false, error: `Unknown option "${name}" for "ladder ${spec.name}".`, help: false }
    if (kind === 'bool') {
      if (eq >= 0) return { ok: false, error: `Option ${name} does not take a value.`, help: false }
      flags[name] = true
      continue
    }
    const value = eq >= 0 ? token.slice(eq + 1) : rest[++i]
    if (value === undefined || (eq < 0 && value.startsWith('--'))) return { ok: false, error: `Option ${name} needs a value.`, help: false }
    flags[name] = value
  }
  if (args.length < spec.min || args.length > spec.max) return { ok: false, error: `Usage: ${spec.usage}`, help: false }
  return { ok: true, value: { command: spec, args, flags } }
}

/** Outcome of `wait` → exit code: 0 completed, 1 error, 2 interrupted, 3 needs the user, 4 timed out. */
export function exitCodeFor(status: string): number {
  switch (status) {
    case 'error':
      return 1
    case 'interrupted':
      return 2
    case 'needs-user':
      return 3
    case 'timeout':
      return 4
    default:
      return 0
  }
}
