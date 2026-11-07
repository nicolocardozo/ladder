// Come l'host avvia Claude Code: CLI dell'utente e ambiente filtrato (regole della fase 0, vedi docs/fase-0.md).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const CANDIDATES = [
  join(homedir(), '.local/bin/claude'),
  join(homedir(), '.claude/local/claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude'
]

/** Percorso della CLI `claude` installata dall'utente, se c'è. */
export async function findClaudeCli(): Promise<string | null> {
  for (const path of CANDIDATES) if (existsSync(path)) return path
  try {
    // L'utility process eredita un PATH ridotto: chiediamo alla shell di login.
    const { stdout } = await run('/bin/zsh', ['-lc', 'command -v claude'], { timeout: 5000 })
    const path = stdout.trim()
    return path && existsSync(path) ? path : null
  } catch {
    return null
  }
}

export async function claudeVersion(cli: string): Promise<string | null> {
  try {
    const { stdout } = await run(cli, ['--version'], { timeout: 10000, env: claudeEnv() })
    return stdout.trim().split(' ')[0] || null
  } catch {
    return null
  }
}

/**
 * Ambiente per il processo `claude`: copia di quello dell'host senza variabili ANTHROPIC_* e CLAUDE*.
 * Una ANTHROPIC_API_KEY passerebbe alla fatturazione a consumo; avviato da Claude Code, l'host
 * erediterebbe anche CLAUDE_CODE_SIMPLE (= --bare), un proxy e altre variabili della sessione madre.
 */
export function claudeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE)/.test(key)) continue
    env[key] = value
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'ladder/0.0.0'
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1'
  env.DISABLE_AUTOUPDATER = '1'
  return env
}
