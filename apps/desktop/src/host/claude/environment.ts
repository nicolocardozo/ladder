// Come l'host avvia Claude Code: CLI dell'utente e ambiente filtrato (regole della fase 0, vedi docs/fase-0.md).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { t } from '@shared/i18n'

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

export function claudeAccountLabel(info: { subscriptionType?: string; apiKeySource?: string }): string | null {
  if (info.subscriptionType) return info.subscriptionType
  return info.apiKeySource && info.apiKeySource !== 'none' ? t('API key') : null
}

/**
 * Account e modelli senza aprire una sessione: la CLI parte, risponde e si chiude senza ricevere messaggi,
 * quindi nessuna quota. Le informazioni arrivano dall'SDK: i file delle credenziali restano fuori da Ladder.
 */
export async function probeClaude(cli: string): Promise<{ account: string | null; email: string | null; models: { id: string; label: string }[] }> {
  const abort = new AbortController()
  const closed = new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }))
  // Input che non manda niente: resta aperto finché la risposta non è arrivata.
  async function* silent(): AsyncGenerator<SDKUserMessage> {
    await closed
  }
  const q = query({
    prompt: silent(),
    options: { cwd: homedir(), env: claudeEnv(), abortController: abort, pathToClaudeCodeExecutable: cli, settingSources: [], settings: { disableClaudeAiConnectors: true } }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [info, models] = await Promise.race([
      Promise.all([q.accountInfo(), q.supportedModels()]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 20000)
      })
    ])
    return { account: claudeAccountLabel(info), email: info.email ?? null, models: models.map((m) => ({ id: m.value, label: m.displayName })) }
  } finally {
    clearTimeout(timer)
    abort.abort()
    q.close()
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
