// Read-only child sessions (advice): the settings `allow` rules are decided before canUseTool, so
// the barrier is a PreToolUse hook, which runs before the rules. Bash only for read commands, MCP only Ladder's list_agents and report_result.
import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import { t } from '@shared/i18n'
import { LADDER_MCP_NAME } from '../agents/common'

const PLAIN = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'stat', 'file', 'tree', 'rg', 'grep', 'egrep', 'fgrep', 'diff', 'uniq', 'cut', 'basename', 'dirname'])
const GIT = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse', 'grep', 'shortlog', 'describe', 'cat-file'])
/** Arguments that make even a read command write or execute. */
const UNSAFE_ARG = /^(--output(=|$)|--pre(=|$)|--pre-glob|--ext-diff|--textconv|--open-files-in-pager|--exec-path)/
const FIND_UNSAFE = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'])

/** Splits into segments (; & | newline) of words; null if anything cannot be judged (redirections, expansions, subshells). */
function segments(command: string): string[][] | null {
  const out: string[][] = [[]]
  let word: string | null = null
  let quote: '"' | "'" | null = null
  const push = () => {
    if (word !== null) out[out.length - 1].push(word)
    word = null
  }
  for (const ch of command) {
    if (ch === '$' || ch === '`' || ch === '\0') return null
    if (quote) {
      if (ch === quote) quote = null
      else word = (word ?? '') + ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      word = word ?? ''
    } else if (ch === '>' || ch === '<' || ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '\\') return null
    else if (ch === ' ' || ch === '\t') push()
    else if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      push()
      out.push([])
    } else word = (word ?? '') + ch
  }
  if (quote) return null
  push()
  return out.filter((s) => s.length > 0)
}

function readOnlySegment(words: string[]): boolean {
  const [name, ...args] = words
  if (!name || (name !== 'find' && args.some((a) => UNSAFE_ARG.test(a)))) return false
  if (name === 'git') return GIT.has(args[0] ?? '')
  if (name === 'find') return !args.some((a) => FIND_UNSAFE.has(a))
  return PLAIN.has(name)
}

/** The Bash command only reads: every segment is in the list and has no redirections or expansions. */
export function isReadOnlyBash(command: string): boolean {
  const parts = segments(command)
  return !!parts && parts.length > 0 && parts.every(readOnlySegment)
}

/** Only MCP tools allowed to a read-only child: the agent list and the outcome (no handoff or delegation). */
const LADDER_READ_ONLY = new Set([`mcp__${LADDER_MCP_NAME}__list_agents`, `mcp__${LADDER_MCP_NAME}__report_result`])

const decide = (decision: 'allow' | 'deny', reason?: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: decision, ...(reason ? { permissionDecisionReason: reason } : {}) }
})

const hook: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {}
  const { tool_name: tool, tool_input: params } = input
  if (tool.startsWith('mcp__')) return LADDER_READ_ONLY.has(tool) ? decide('allow') : decide('deny', t('This session is read-only: tools from MCP servers are not available.'))
  if (tool !== 'Bash') return {}
  const command = typeof (params as { command?: unknown } | null)?.command === 'string' ? (params as { command: string }).command : ''
  // A read-only command is allowed even without an allow rule: in Plan it would otherwise ask, and requests are refused.
  return isReadOnlyBash(command) ? decide('allow') : decide('deny', t('This session is read-only: only read commands such as git diff, git log, ls, cat, rg or grep can run.'))
}

export const readOnlyHooks: { PreToolUse: HookCallbackMatcher[] } = { PreToolUse: [{ hooks: [hook] }] }
