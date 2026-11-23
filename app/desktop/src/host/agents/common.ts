// Parti comuni agli adapter degli agenti: interfaccia della sessione, ambiente filtrato, PATH della shell di login.
import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { promisify } from 'node:util'
import { cleanEnv } from '@shared/env'
import { t } from '@shared/i18n'
import type { Attachment, Effort, PermissionLevel } from '@shared/protocol'
export type { AdapterEvents, ToolUpdate, TurnResult, UserRequest } from '../claude/adapter'

const run = promisify(execFile)

/** Una sessione con un agente: Claude Code, Codex o un agente ACP. L'host la usa sempre allo stesso modo. */
export interface AgentSession {
  readonly isRunning: boolean
  start(): void
  send(text: string, attachments?: Attachment[]): void
  /** Esegue un comando della lista: come send(), parte un turno. */
  command(name: string, args: string): void
  /** Inserisce un messaggio nel turno in corso, senza aprirne uno nuovo. Assente o false: l'host lo accoda. */
  steer?(text: string, attachments?: Attachment[], id?: string): Promise<boolean>
  /** Messaggi inseriti che l'agente non ha ancora unito al turno (Claude): dopo un'interruzione girano da soli. */
  readonly pendingSteerCount?: number
  /** Turno aperto per messaggi inseriti che l'agente non ha ancora fatto partire (Claude). */
  readonly idleImplicitTurn?: boolean
  /** `all`: Stop, ferma anche ciò che l'agente ha in coda; senza, "invia ora" lo lascia unire al messaggio nuovo. */
  interrupt(all?: boolean): Promise<void>
  /** Interrompe e mette subito dopo la ricevuta un messaggio nello stream (Claude, "invia ora" con messaggi pendenti). */
  interruptThenSend?(text: string, attachments: Attachment[], id: string, beforePush: () => void): Promise<boolean>
  setPermission(level: PermissionLevel): Promise<void>
  setModel(model: string): Promise<void>
  /** Vale dal prossimo messaggio. */
  setEffort(effort: Effort): Promise<void>
  /** Voci dei sotto-agenti che l'agente dà per vivi (Claude, background_tasks_changed). Assente o null: a turno chiuso vale solo il tempo dall'ultimo aggiornamento. */
  liveAgentIds?(): Set<string> | null
  close(): void
}

export interface SessionOptions {
  cwd: string
  model: string | null
  effort: Effort | null
  permission: PermissionLevel
  /** Id della conversazione dell'agente da riprendere. */
  resume: string | null
  /** Cartella di configurazione del profilo (CLAUDE_CONFIG_DIR / CODEX_HOME); null = quella della CLI. */
  configDir?: string | null
  /** Istruzione di autonomia (HostPrefs.autonomyHint): prompt di sistema di Claude e developerInstructions di Codex. */
  autonomyHint?: boolean
  /** LAD-57 parte 2: server MCP del browser dell'agente (URL e token della sessione); assente = interruttore spento, nessuna registrazione. */
  browserTools?: { url: string; token: string } | null
}

/** LAD-57 parte 2: nome con cui il server MCP del browser dell'agente si registra negli adapter (in Claude: `mcp__ladder-browser__browser_*`). */
export const BROWSER_MCP_NAME = 'ladder-browser'

/** Istruzione di autonomia (HostPrefs.autonomyHint) per Edit e Full access, nel prompt di sistema di Claude e nelle developerInstructions di Codex: compiti lunghi senza fermarsi per prudenza. */
export const AUTONOMY_HINT =
  'When the user gives you a long or multi-step task, work through it autonomously until it is done. Do not stop to ask for confirmation or out of caution when the next step is clear. If you do stop, say why and what you need from the user to continue.'

let loginPath: Promise<string> | null = null

/** PATH della shell di login: le app aperte dal Finder non vedono npx, uvx e le CLI installate. */
export function shellPath(): Promise<string> {
  loginPath ??= run(process.env.SHELL || '/bin/zsh', ['-lc', 'printf %s "$PATH"'], { timeout: 5000, env: cleanEnv() })
    .then(({ stdout }) => stdout.trim() || process.env.PATH || '')
    .catch(() => process.env.PATH || '')
  return loginPath
}

/** Percorso di un comando secondo la shell di login; null se non c'è. */
export async function whichInShell(name: string): Promise<string | null> {
  if (name.includes('/')) return name
  try {
    const { stdout } = await run(process.env.SHELL || '/bin/zsh', ['-lc', `command -v -- ${JSON.stringify(name)}`], { timeout: 5000, env: cleanEnv() })
    const path = stdout.trim().split('\n').pop() ?? ''
    return path.startsWith('/') ? path : null
  } catch {
    return null
  }
}

/** Percorsi di più comandi con una sola shell di login (una per comando costerebbe molto di più). Solo nomi semplici; manca chi non c'è. */
export async function whichManyInShell(names: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const safe = names.filter((n) => /^[\w.-]+$/.test(n))
  if (!safe.length) return found
  // `; true`: senza, l'ultimo nome mancante dà stato 1 a tutto lo script e execFile scarta anche i percorsi già trovati.
  const script = `for n in ${safe.join(' ')}; do p=$(command -v -- "$n") && printf '%s\\t%s\\n' "$n" "$p"; done; true`
  try {
    const { stdout } = await run(process.env.SHELL || '/bin/zsh', ['-lc', script], { timeout: 8000, env: cleanEnv() })
    for (const line of stdout.split('\n')) {
      const [name, path] = line.split('\t')
      if (name && path?.startsWith('/') && safe.includes(name)) found.set(name, path)
    }
  } catch {
    // Shell che non risponde: nessuna CLI rilevata.
  }
  return found
}

export { cleanEnv }

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
  // Anche `extra` (ambiente di una voce del registro o dell'utente) non può rimettere ciò che sopra si toglie né caricare librerie.
  for (const [key, value] of Object.entries(extra)) {
    if (/^(ANTHROPIC_|CLAUDE|DYLD_|LD_)/.test(key) || key === 'NODE_OPTIONS') continue
    env[key] = value
  }
  return env
}

export function firstLine(text: string, max = 80): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export const OUTPUT_LIMIT = 8000

export function clip(text: string | null | undefined): string | null {
  if (!text) return null
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n${t('… ({n} more characters)', { n: text.length - OUTPUT_LIMIT })}` : text
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

/** Legge un file di config solo se è un file normale e non enorme (tetto 1 MB): mai una lettura che possa bloccare. */
export function readSmallFile(path: string, maxBytes = 1_000_000): string | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > maxBytes) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
