// Parti comuni agli adapter degli agenti: interfaccia della sessione, ambiente filtrato, PATH della shell di login.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Attachment, Effort, PermissionLevel } from '@shared/protocol'
export type { AdapterEvents, ToolUpdate, TurnResult, UserRequest } from '../claude/adapter'

const run = promisify(execFile)

/** Una sessione con un agente: Claude Code, Codex o un agente ACP. L'host la usa sempre allo stesso modo. */
export interface AgentSession {
  readonly isRunning: boolean
  start(): void
  send(text: string, attachments?: Attachment[]): void
  interrupt(): Promise<void>
  setPermission(level: PermissionLevel): Promise<void>
  setModel(model: string): Promise<void>
  close(): void
}

export interface SessionOptions {
  cwd: string
  model: string | null
  effort: Effort | null
  permission: PermissionLevel
  /** Id della conversazione dell'agente da riprendere. */
  resume: string | null
}

let loginPath: Promise<string> | null = null

/** PATH della shell di login: le app aperte dal Finder non vedono npx, uvx e le CLI installate. */
export function shellPath(): Promise<string> {
  loginPath ??= run(process.env.SHELL || '/bin/zsh', ['-lc', 'printf %s "$PATH"'], { timeout: 5000 })
    .then(({ stdout }) => stdout.trim() || process.env.PATH || '')
    .catch(() => process.env.PATH || '')
  return loginPath
}

/** Percorso di un comando secondo la shell di login; null se non c'è. */
export async function whichInShell(name: string): Promise<string | null> {
  if (name.includes('/')) return name
  try {
    const { stdout } = await run(process.env.SHELL || '/bin/zsh', ['-lc', `command -v -- ${JSON.stringify(name)}`], { timeout: 5000 })
    const path = stdout.trim().split('\n').pop() ?? ''
    return path.startsWith('/') ? path : null
  } catch {
    return null
  }
}

/**
 * Ambiente per un agente: senza le variabili di Claude Code, di Electron e di Ladder, e senza chiavi API
 * che scavalcherebbero il login dell'abbonamento. Il PATH è quello della shell di login.
 */
export async function agentEnv(strip: string[] = [], extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/^(ANTHROPIC_|CLAUDE|ELECTRON_|LADDER_|CHROME_|VSCODE_|npm_)/.test(key) || key === 'NODE_OPTIONS') continue
    if (strip.includes(key)) continue
    env[key] = value
  }
  env.PATH = await shellPath()
  return { ...env, ...extra }
}

export function firstLine(text: string, max = 80): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export const OUTPUT_LIMIT = 8000

export function clip(text: string | null | undefined): string | null {
  if (!text) return null
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… (${text.length - OUTPUT_LIMIT} caratteri in più)` : text
}

/**
 * Comando da mostrare: Codex lo avvolge in `/bin/zsh -lc '…'` e alcuni adapter ACP lo passano come stringa JSON.
 * La card mostra il comando vero, quello che hai chiesto.
 */
export function displayCommand(raw: string | null | undefined): string | null {
  if (!raw) return null
  let cmd = raw.trim()
  if (/^".*"$/s.test(cmd)) {
    try {
      cmd = JSON.parse(cmd) as string
    } catch {
      // Non era JSON: resta com'è.
    }
  }
  const wrapped = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-l?c\s+'([\s\S]*)'$/.exec(cmd)
  if (wrapped) return wrapped[1].replace(/'\\''/g, "'")
  const doubleQuoted = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-l?c\s+"([\s\S]*)"$/.exec(cmd)
  if (doubleQuoted) return doubleQuoted[1].replace(/\\"/g, '"')
  return cmd
}
