// Come l'host avvia Claude Code: CLI dell'utente e ambiente filtrato (regole della fase 0, vedi docs/fase-0.md).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { localeTag, t } from '@shared/i18n'
import type { Effort, UsageWindow } from '@shared/protocol'

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

/** Un modello come lo vede Ladder: nome, e livelli di effort quando il modello li ha. */
export function claudeModel(m: { value: string; displayName: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }): { id: string; label: string; efforts?: Effort[] } {
  const efforts = m.supportsEffort === false ? [] : (m.supportedEffortLevels as Effort[] | undefined)
  return { id: m.value, label: m.displayName, ...(efforts ? { efforts } : {}) }
}

const CLAUDE_WINDOWS: Record<string, { minutes: number; model: string | null }> = {
  five_hour: { minutes: 300, model: null },
  seven_day: { minutes: 10080, model: null },
  seven_day_opus: { minutes: 10080, model: 'Opus' },
  seven_day_sonnet: { minutes: 10080, model: 'Sonnet' }
}

/** Evento dei limiti di Claude Code come finestra di Ladder. `utilization` è una frazione da 0 a 1. */
export function claudeUsage(info: Record<string, unknown>): UsageWindow | null {
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : null
  const window = type ? CLAUDE_WINDOWS[type] : null
  if (!type || !window) return null
  return {
    key: type,
    ...window,
    percent: typeof info.utilization === 'number' ? info.utilization * 100 : null,
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
    state: info.status === 'rejected' ? 'limited' : info.status === 'allowed_warning' ? 'warning' : 'ok'
  }
}

type PlanWindow = { utilization: number | null; resets_at: string | null } | null | undefined

function planWindow(key: string, window: PlanWindow, minutes: number, model: string | null, label?: string): UsageWindow | null {
  if (!window || (window.utilization === null && !window.resets_at)) return null
  const percent = window.utilization
  const resetsAt = window.resets_at ? Math.round(Date.parse(window.resets_at) / 1000) : null
  return { key, minutes, model, percent, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null, state: percent !== null && percent >= 100 ? 'limited' : percent !== null && percent >= 80 ? 'warning' : 'ok', ...(label ? { label } : {}) }
}

/** Limiti del piano Claude letti su richiesta (la stessa fonte di /usage): tutte le finestre, con percentuale e reset. */
export function claudePlanUsage(data: unknown): UsageWindow[] | null {
  const limits = (data as { rate_limits?: Record<string, unknown> | null } | null)?.rate_limits
  if (!limits) return null
  const rows = ((limits.seven_day_breakdown as { rows?: { display_name: string; percent_of_limit: number }[] } | null | undefined)?.rows ?? [])
    .filter((r) => typeof r.percent_of_limit === 'number' && r.percent_of_limit > 0)
    .map((r) => ({ label: r.display_name, percent: r.percent_of_limit }))
  const weekly = planWindow('seven_day', limits.seven_day as PlanWindow, 10080, null)
  const out: (UsageWindow | null)[] = [
    planWindow('five_hour', limits.five_hour as PlanWindow, 300, null),
    weekly && rows.length ? { ...weekly, breakdown: rows } : weekly,
    planWindow('seven_day_opus', limits.seven_day_opus as PlanWindow, 10080, 'Opus'),
    planWindow('seven_day_sonnet', limits.seven_day_sonnet as PlanWindow, 10080, 'Sonnet')
  ]
  for (const scoped of (limits.model_scoped as { display_name: string; utilization: number | null; resets_at: string | null }[] | undefined) ?? []) {
    out.push(planWindow(`model:${scoped.display_name}`, scoped, 10080, scoped.display_name))
  }
  const extra = limits.extra_usage as { is_enabled: boolean; monthly_limit: number | null; used_credits: number | null; utilization: number | null; currency?: string | null } | null | undefined
  if (extra?.is_enabled) {
    const money = (value: number) => new Intl.NumberFormat(localeTag(), { style: 'currency', currency: extra.currency || 'USD' }).format(value / 100)
    const detail = extra.used_credits !== null && extra.monthly_limit !== null ? t('{used} of {limit} this month', { used: money(extra.used_credits), limit: money(extra.monthly_limit) }) : undefined
    out.push({ key: 'extra_usage', minutes: 0, model: null, percent: extra.utilization, resetsAt: null, state: extra.utilization !== null && extra.utilization >= 100 ? 'limited' : 'ok', label: t('Extra usage'), ...(detail ? { detail } : {}) })
  }
  return out.filter((w): w is UsageWindow => w !== null)
}

export function claudeAccountLabel(info: { subscriptionType?: string; apiKeySource?: string }): string | null {
  if (info.subscriptionType) return info.subscriptionType
  return info.apiKeySource && info.apiKeySource !== 'none' ? t('API key') : null
}

/**
 * Account e modelli senza aprire una sessione: la CLI parte, risponde e si chiude senza ricevere messaggi,
 * quindi nessuna quota. Le informazioni arrivano dall'SDK: i file delle credenziali restano fuori da Ladder.
 */
export async function probeClaude(cli: string): Promise<{ account: string | null; email: string | null; models: { id: string; label: string; efforts?: Effort[] }[]; usage?: UsageWindow[]; usageAt?: number }> {
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
    // API sperimentale dell'SDK: se cambia forma o non risponde, restano i limiti visti nelle sessioni.
    const usage = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).then(claudePlanUsage),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000))
    ]).catch(() => null)
    return { account: claudeAccountLabel(info), email: info.email ?? null, models: models.map(claudeModel), ...(usage ? { usage, usageAt: Date.now() } : {}) }
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
