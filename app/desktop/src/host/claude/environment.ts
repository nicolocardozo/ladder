// Come l'host avvia Claude Code: CLI dell'utente e ambiente filtrato (regole della fase 0, vedi docs/fase-0.md).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { localeTag, t } from '@shared/i18n'
import type { AgentStatus, Effort, UsageWindow } from '@shared/protocol'
import { cleanEnv, readSmallFile, whichInShell } from '../agents/common'

const run = promisify(execFile)

const CANDIDATES = [
  join(homedir(), '.local/bin/claude'),
  join(homedir(), '.claude/local/claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude'
]

/**
 * Il binario di Claude Code che porta l'Agent SDK (pacchetto opzionale della piattaforma), per chi non ha la CLI.
 * Nell'app impacchettata sta fuori dall'asar (asarUnpack); in sviluppo si risolve accanto al pacchetto dell'SDK.
 */
export function bundledClaudeCli(): string | null {
  const name = `claude-agent-sdk-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const pkg = join('node_modules/@anthropic-ai', name, 'claude')
  const found: string[] = []
  if (process.resourcesPath) found.push(join(process.resourcesPath, 'app.asar.unpacked', pkg))
  // In sviluppo host.js sta in out/main: il pacchetto è dipendenza diretta, quindi in apps/desktop/node_modules.
  found.push(join(__dirname, '../..', pkg))
  return found.find((p) => existsSync(p)) ?? null
}

/** Percorso della CLI `claude` installata dall'utente, se c'è: stesso login della sua CLI. */
export async function findUserClaudeCli(): Promise<string | null> {
  for (const path of CANDIDATES) if (existsSync(path)) return path
  // L'utility process eredita un PATH ridotto: chiediamo alla shell di login.
  const path = await whichInShell('claude')
  return path && existsSync(path) ? path : null
}

/** La CLI dell'utente se c'è, altrimenti il binario incluso in Ladder. */
export async function findClaudeCli(): Promise<string | null> {
  return (await findUserClaudeCli()) ?? bundledClaudeCli()
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

function asEffort(value: unknown): Effort | null {
  return typeof value === 'string' && (EFFORTS as string[]).includes(value) ? (value as Effort) : null
}

/** Solo i campi che servono (model, effortLevel, modelSettings.*.effortLevel): il resto dei settings può contenere segreti e non si tiene. */
export interface ClaudeDefaults {
  model: string | null
  effort: Effort | null
  /** Senza prototipo: i nomi dei modelli vengono dai file. */
  modelEffort: Record<string, Effort>
}

/**
 * Modello ed effort predefiniti dai settings di Claude Code: progetto locale > progetto > utente, campo per campo.
 * `configDir` è la cartella del profilo (altrimenti ~/.claude); senza `cwd` contano solo i settings utente.
 */
export function readClaudeDefaults(configDir: string | null, cwd?: string | null): ClaudeDefaults {
  // I summary partono spesso: i file si rileggono al più ogni 5 secondi per percorso.
  const key = `${configDir ?? ''}\0${cwd ?? ''}`
  const cached = defaultsCache.get(key)
  if (cached && Date.now() - cached.at < 5000) {
    // LRU: l'ultimo usato in coda.
    defaultsCache.delete(key)
    defaultsCache.set(key, cached)
    return cached.value
  }
  const value = loadClaudeDefaults(configDir, cwd)
  defaultsCache.delete(key)
  defaultsCache.set(key, { at: Date.now(), value })
  if (defaultsCache.size > 50) defaultsCache.delete(defaultsCache.keys().next().value!)
  return value
}

const defaultsCache = new Map<string, { at: number; value: ClaudeDefaults }>()

/** Alias e id risolto dello stesso modello (value <-> resolvedModel), dall'ultimo elenco visto: i settings possono usare l'uno o l'altro. */
const modelAliases = new Map<string, string>()
/** id risolto -> value dell'elenco. */
const resolvedToValue = new Map<string, string>()

/** L'id dell'elenco modelli (value) per un id wire come quello dell'init (claude-sonnet-5); invariato se non lo conosce. */
export function claudeListId(name: string): string {
  return resolvedToValue.get(name) ?? name
}

/** Il nome del modello e il suo equivalente (alias o id risolto), se noto. */
export function claudeModelNames(name: string): string[] {
  const other = modelAliases.get(name)
  return other ? [name, other] : [name]
}

function loadClaudeDefaults(configDir: string | null, cwd?: string | null): ClaudeDefaults {
  const files = [join(configDir ?? join(homedir(), '.claude'), 'settings.json')]
  if (cwd) files.push(join(cwd, '.claude/settings.json'), join(cwd, '.claude/settings.local.json'))
  const out: ClaudeDefaults = { model: null, effort: null, modelEffort: Object.create(null) }
  // Dal più generico al più specifico: l'ultimo che dice qualcosa vince.
  for (const file of files) {
    const text = readSmallFile(file)
    if (text === null) continue
    let data: { model?: unknown; effortLevel?: unknown; modelSettings?: unknown }
    try {
      data = JSON.parse(text)
    } catch {
      continue
    }
    if (!data || typeof data !== 'object') continue
    if (typeof data.model === 'string' && data.model) out.model = data.model
    const effort = asEffort(data.effortLevel)
    if (effort) out.effort = effort
    if (data.modelSettings && typeof data.modelSettings === 'object') {
      for (const [name, value] of Object.entries(data.modelSettings as Record<string, { effortLevel?: unknown } | null>)) {
        const level = asEffort(value?.effortLevel)
        if (level) out.modelEffort[name] = level
      }
    }
  }
  return out
}

type ClaudeModelInfo = { value: string; resolvedModel?: string; displayName: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }

/**
 * Elenco modelli per Ladder: la riga alias "default" non compare, e il modello che parte è marcato `isDefault`
 * (settings, poi il resolvedModel della riga alias). `defaultEffort` viene dai settings, per modello o globale.
 */
export function claudeModels(models: ClaudeModelInfo[], defaults: ClaudeDefaults): AgentStatus['models'] {
  const alias = models.find((m) => m.value === 'default')
  const rows = models.filter((m) => m !== alias)
  for (const m of rows) {
    if (!m.resolvedModel || m.resolvedModel === m.value) continue
    modelAliases.set(m.value, m.resolvedModel)
    modelAliases.set(m.resolvedModel, m.value)
    resolvedToValue.set(m.resolvedModel, m.value)
  }
  const matches = (m: ClaudeModelInfo, name: string) => m.value === name || m.resolvedModel === name
  const wanted = defaults.model && defaults.model !== 'default' ? defaults.model : null
  // Un modello configurato che non è nell'elenco (opusplan, id sconosciuto): nessun default, niente ripiego.
  let target = wanted ? rows.find((m) => matches(m, wanted)) : alias?.resolvedModel ? rows.find((m) => matches(m, alias.resolvedModel!)) : undefined
  // Alias che non coincide con nessuna riga: diventa la riga del modello che parte.
  if (!target && !wanted && alias?.resolvedModel) {
    target = { ...alias, value: alias.resolvedModel, displayName: alias.displayName.replace(/\s*\(recommended\)$/i, '') }
    rows.push(target)
  }
  return rows.map((m) => {
    const efforts = m.supportsEffort === false ? [] : (m.supportedEffortLevels as Effort[] | undefined)
    const defaultEffort = defaults.modelEffort[m.value] ?? (m.resolvedModel ? defaults.modelEffort[m.resolvedModel] : undefined) ?? defaults.effort
    return { id: m.value, label: m.displayName, ...(efforts ? { efforts } : {}), ...(m === target ? { isDefault: true } : {}), defaultEffort: defaultEffort ?? null }
  })
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
export async function probeClaude(cli: string, configDir: string | null = null): Promise<{ account: string | null; email: string | null; models: AgentStatus['models']; usage?: UsageWindow[]; usageAt?: number }> {
  const abort = new AbortController()
  const closed = new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }))
  // Input che non manda niente: resta aperto finché la risposta non è arrivata.
  async function* silent(): AsyncGenerator<SDKUserMessage> {
    await closed
  }
  const q = query({
    prompt: silent(),
    options: { cwd: homedir(), env: claudeEnv(configDir), abortController: abort, pathToClaudeCodeExecutable: cli, settingSources: [], settings: { disableClaudeAiConnectors: true } }
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
    return { account: claudeAccountLabel(info), email: info.email ?? null, models: claudeModels(models, readClaudeDefaults(configDir)), ...(usage ? { usage, usageAt: Date.now() } : {}) }
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
 * CLAUDE_CONFIG_DIR passa solo se la imposta Ladder: `configDir` è la cartella di un profilo non predefinito (LAD-23);
 * senza, la CLI usa la sua (~/.claude) e un CLAUDE_CONFIG_DIR ereditato non conta.
 */
export function claudeEnv(configDir: string | null = null): Record<string, string | undefined> {
  const env = cleanEnv()
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'ladder/0.0.0'
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1'
  env.DISABLE_AUTOUPDATER = '1'
  return env
}

/**
 * Predefiniti di Claude per un progetto: settings utente + progetto + locale. `model` è un id dell'elenco;
 * `known` false se i settings nominano un modello che l'elenco non ha (opusplan, id sconosciuto).
 */
export function claudeProjectDefaults(models: AgentStatus['models'], configDir: string | null, cwd: string | null): { model: string | null; effort: Effort | null; known: boolean } {
  const defaults = readClaudeDefaults(configDir, cwd)
  const wanted = defaults.model && defaults.model !== 'default' ? defaults.model : null
  const model = wanted ? models.find((m) => claudeModelNames(wanted).includes(m.id)) : models.find((m) => m.isDefault)
  if (wanted && !model) return { model: null, effort: null, known: false }
  const names = model ? claudeModelNames(model.id) : []
  const own = names.map((n) => defaults.modelEffort[n]).find(Boolean)
  return { model: model?.id ?? null, effort: own ?? defaults.effort ?? model?.defaultEffort ?? null, known: true }
}
