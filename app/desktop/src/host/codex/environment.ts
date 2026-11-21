// Dove trovare Codex: la CLI dell'utente, poi quella dell'app Codex, poi quella delle estensioni per Cursor e VS Code.
// Il binario pesa circa 350 MB: Ladder non lo include, lo scarica nella cartella dati se manca (LAD-10).
// LADDER_CODEX lo indica per le prove.
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { t } from '@shared/i18n'
import type { AgentStatus, Effort, UsageWindow } from '@shared/protocol'
import { agentEnv, cleanEnv, readSmallFile, whichInShell } from '../agents/common'
import { toolDir } from '../downloads'
import { CodexRpc } from './rpc'

const run = promisify(execFile)

/** Estensioni per gli editor che includono Codex: la versione più recente vince. */
function extensionBinaries(): string[] {
  const found: { path: string; at: number }[] = []
  for (const root of [join(homedir(), '.cursor/extensions'), join(homedir(), '.vscode/extensions')]) {
    let names: string[] = []
    try {
      names = readdirSync(root).filter((n) => n.startsWith('openai.chatgpt-'))
    } catch {
      continue
    }
    for (const name of names) {
      for (const arch of ['macos-aarch64', 'macos-x86_64']) {
        const path = join(root, name, 'bin', arch, 'codex')
        if (existsSync(path)) found.push({ path, at: statSync(path).mtimeMs })
      }
    }
  }
  return found.sort((a, b) => b.at - a.at).map((f) => f.path)
}

/** Codex scaricato da Ladder: viene dopo tutti quelli dell'utente. */
export const downloadedCodexPath = () => join(toolDir('codex'), 'codex')

export async function findCodexCli(): Promise<string | null> {
  if (process.env.LADDER_CODEX) return existsSync(process.env.LADDER_CODEX) ? process.env.LADDER_CODEX : null
  const inShell = await whichInShell('codex')
  if (inShell) return inShell
  for (const path of ['/Applications/Codex.app/Contents/Resources/codex', join(homedir(), 'Applications/Codex.app/Contents/Resources/codex')]) {
    if (existsSync(path)) return path
  }
  const fromExtension = extensionBinaries()[0]
  if (fromExtension) return fromExtension
  return existsSync(downloadedCodexPath()) ? downloadedCodexPath() : null
}

export async function codexVersion(cli: string): Promise<string | null> {
  try {
    const { stdout } = await run(cli, ['--version'], { timeout: 10000, env: cleanEnv() })
    return stdout.trim().split(/\s+/).pop() ?? null
  } catch {
    return null
  }
}

/** Le chiavi API scavalcherebbero il login di ChatGPT: vale quello della CLI. */
export const CODEX_STRIP_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY']

/** Ambiente di Codex: CODEX_HOME solo per un profilo non predefinito (LAD-23); altrimenti vale quello dell'utente, se c'è. */
export function codexEnv(configDir: string | null = null): Promise<Record<string, string>> {
  return agentEnv(CODEX_STRIP_ENV, configDir ? { CODEX_HOME: configDir } : {})
}

const PLAN_NAMES: Record<string, string> = { plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free', go: 'Go' }

export function accountLabel(account: Record<string, unknown> | null | undefined): string | null {
  if (!account) return null
  if (account.type === 'chatgpt') {
    const plan = String(account.planType ?? '')
    return `ChatGPT ${PLAN_NAMES[plan] ?? plan}`.trim()
  }
  if (account.type === 'apiKey') return t('API key')
  return String(account.type ?? '') || null
}

export function accountEmail(account: Record<string, unknown> | null | undefined): string | null {
  return typeof account?.email === 'string' && account.email ? account.email : null
}

export interface CodexModel {
  id: string
  label: string
  efforts: string[]
  isDefault: boolean
  defaultEffort: string | null
}

export function parseModels(data: unknown): CodexModel[] {
  const list = ((data as { data?: unknown[] })?.data ?? []) as Record<string, unknown>[]
  return list
    .filter((m) => !m.hidden)
    .map((m) => ({
      id: String(m.id ?? m.model),
      label: String(m.displayName ?? m.id),
      efforts: ((m.supportedReasoningEfforts ?? []) as { reasoningEffort: string }[]).map((e) => e.reasoningEffort),
      isDefault: m.isDefault === true,
      defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : null
    }))
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export interface CodexConfig {
  model: string | null
  /** Come scritto in config.toml: Codex accetta anche livelli (minimal, none) che Ladder non ha. */
  effort: string | null
  /** `profile` nomina un profilo che non c'è in config.toml: non si sa cosa parte. */
  unresolved: boolean
}

/** Valore stringa TOML (basic con escape, o literal) all'inizio di `rest`; null se non è una stringa. */
function tomlString(rest: string): string | null {
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1)
    return end < 0 ? null : rest.slice(1, end)
  }
  if (!rest.startsWith('"') || rest.startsWith('"""')) return null
  let out = ''
  for (let i = 1; i < rest.length; i++) {
    const c = rest[i]
    if (c === '\\') {
      const n = rest[++i]
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n
    } else if (c === '"') return out
    else out += c
  }
  return null
}

/** Profondità delle parentesi quadre dopo `text` (fuori dalle stringhe e dai commenti), partendo da `depth`. */
function bracketDepth(text: string, depth: number): number {
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#') break
    else if (c === '[') depth++
    else if (c === ']') depth--
  }
  return depth
}

/**
 * Modello ed effort scelti dall'utente in config.toml: `model` e `model_reasoning_effort` di primo livello, e quelli del
 * profilo nominato da `profile` ([profiles.<nome>]). Il resto del file non si tiene. Array e stringhe su più righe si saltano.
 * `configDir` è il CODEX_HOME del profilo di Ladder, altrimenti ~/.codex.
 */
export function readCodexDefaults(configDir: string | null): CodexConfig {
  // Come per Claude: cache per percorso, 5 secondi, al più 50 voci (LRU).
  const key = configDir ?? ''
  const cached = codexConfigCache.get(key)
  if (cached && Date.now() - cached.at < 5000) {
    codexConfigCache.delete(key)
    codexConfigCache.set(key, cached)
    return cached.value
  }
  const value = loadCodexDefaults(configDir)
  codexConfigCache.delete(key)
  codexConfigCache.set(key, { at: Date.now(), value })
  if (codexConfigCache.size > 50) codexConfigCache.delete(codexConfigCache.keys().next().value!)
  return value
}

const codexConfigCache = new Map<string, { at: number; value: CodexConfig }>()

function loadCodexDefaults(configDir: string | null): CodexConfig {
  const text = readSmallFile(join(configDir ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'))
  if (text === null) return { model: null, effort: null, unresolved: false }
  const top = { model: null as string | null, effort: null as string | null, profile: null as string | null }
  const profiles = new Map<string, { model: string | null; effort: string | null }>()
  let table: string | null = null // null = primo livello; '' = tabella che non ci interessa
  let depth = 0
  let multiline: string | null = null
  for (const raw of text.split('\n')) {
    if (multiline) {
      if (raw.includes(multiline)) multiline = null
      continue
    }
    const line = raw.trim()
    if (depth > 0) {
      depth = bracketDepth(line, depth)
      continue
    }
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)
      const name = header ? /^profiles\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))$/.exec(header[1]) : null
      const profile = name && !line.startsWith('[[') ? (name[1] ?? name[2] ?? name[3]) : null
      table = profile ?? ''
      if (profile && !profiles.has(profile)) profiles.set(profile, { model: null, effort: null })
      continue
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, rest] = kv
    if (rest.startsWith('[')) {
      depth = bracketDepth(rest, 0)
      continue
    }
    for (const q of ['"""', "'''"]) if (rest.startsWith(q) && !rest.slice(3).includes(q)) multiline = q
    if (multiline) continue
    const target = table === null ? top : table ? profiles.get(table) : undefined
    if (!target || !(key === 'model' || key === 'model_reasoning_effort' || (key === 'profile' && table === null))) continue
    const value = tomlString(rest)
    if (value === null) continue
    if (key === 'model') target.model = value || null
    else if (key === 'model_reasoning_effort') target.effort = value || null
    else top.profile = value || null
  }
  const chosen = top.profile ? profiles.get(top.profile) : undefined
  if (top.profile && !chosen) return { model: top.model, effort: top.effort, unresolved: true }
  return { model: chosen?.model ?? top.model, effort: chosen?.effort ?? top.effort, unresolved: false }
}

/**
 * Elenco modelli per Ladder: `isDefault` da config.toml se nomina un modello dell'elenco, altrimenti dal flag di Codex.
 * Se il config nomina un modello sconosciuto o un profilo che non c'è, nessun default. `model_reasoning_effort` vale per ogni
 * modello che lo supporta; un livello che Ladder non ha (minimal, none) dà `null`.
 */
export function codexModels(models: CodexModel[], configDir: string | null): AgentStatus['models'] {
  const config = readCodexDefaults(configDir)
  const chosen = config.unresolved ? undefined : config.model ? models.find((m) => m.id === config.model) : models.find((m) => m.isDefault)
  return models.map((m) => {
    const configured = config.effort && (m.efforts.length === 0 || m.efforts.includes(config.effort))
    const effort = configured ? config.effort : m.defaultEffort
    return {
      id: m.id,
      label: m.label,
      efforts: m.efforts as Effort[],
      ...(m === chosen ? { isDefault: true } : {}),
      defaultEffort: effort && EFFORTS.includes(effort) ? (effort as Effort) : null
    }
  })
}

/** Predefiniti di Codex per `agents.defaults`: dall'elenco già calcolato; `known` false se il config non si risolve. */
export function codexDefaults(models: AgentStatus['models'], configDir: string | null): { model: string | null; effort: Effort | null; known: boolean } {
  const config = readCodexDefaults(configDir)
  if (config.unresolved || (config.model && !models.some((m) => m.id === config.model))) return { model: null, effort: null, known: false }
  const model = models.find((m) => m.isDefault)
  return { model: model?.id ?? null, effort: model?.defaultEffort ?? null, known: true }
}

/** Account e modelli, con un app-server di breve durata: non consuma quota (nessun turno). */
export async function probeCodex(cli: string, version: string, configDir: string | null = null): Promise<Pick<AgentStatus, 'account' | 'email' | 'models' | 'limits' | 'usage' | 'usageAt'>> {
  const rpc = new CodexRpc(cli, await codexEnv(configDir), () => undefined, async () => ({ error: { code: -32601, message: t('unexpected') } }))
  try {
    await rpc.initialize(version)
    const account = await rpc.request<{ account: Record<string, unknown> | null }>('account/read', { refreshToken: false }, 15000)
    const models = parseModels(await rpc.request('model/list', {}, 15000))
    let limits: string | null = null
    let usage: UsageWindow[] | undefined
    try {
      const data = await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }, 15000)
      limits = describeLimits(data)
      usage = describeUsage(data)
    } catch {
      limits = null
    }
    return { ...(usage ? { usage, usageAt: Date.now() } : {}), account: accountLabel(account.account), email: accountEmail(account.account), models: codexModels(models, configDir), limits }
  } finally {
    rpc.kill()
  }
}

/** "14% della finestra di 5 h · 11% settimanale" dai limiti d'uso di Codex. */
/** Limiti di Codex come finestre di Ladder. */
export function describeUsage(data: unknown): UsageWindow[] {
  const root = data as { rateLimits?: Record<string, unknown>; rateLimitsByLimitId?: Record<string, Record<string, unknown>> } | null
  const limits = root?.rateLimits ?? Object.values(root?.rateLimitsByLimitId ?? {})[0]
  if (!limits) return []
  const out: UsageWindow[] = []
  for (const key of ['primary', 'secondary'] as const) {
    const window = limits[key] as { usedPercent?: number; windowDurationMins?: number; resetsAt?: number | null } | null | undefined
    if (!window || typeof window.usedPercent !== 'number') continue
    out.push({ key, minutes: window.windowDurationMins ?? 0, model: null, percent: window.usedPercent, resetsAt: window.resetsAt ?? null, state: window.usedPercent >= 100 ? 'limited' : 'ok' })
  }
  return out
}

export function describeLimits(data: unknown): string | null {
  const root = data as { rateLimits?: Record<string, unknown>; rateLimitsByLimitId?: Record<string, Record<string, unknown>> } | null
  const limits = root?.rateLimits ?? Object.values(root?.rateLimitsByLimitId ?? {})[0]
  if (!limits) return null
  const parts: string[] = []
  for (const key of ['primary', 'secondary'] as const) {
    const window = limits[key] as { usedPercent?: number; windowDurationMins?: number } | null | undefined
    if (!window || typeof window.usedPercent !== 'number') continue
    const minutes = window.windowDurationMins ?? 0
    const percent = Math.round(window.usedPercent)
    parts.push(
      minutes >= 7 * 24 * 60
        ? t('{percent}% weekly', { percent })
        : minutes >= 60
          ? t('{percent}% of the {hours} h window', { percent, hours: Math.round(minutes / 60) })
          : t('{percent}% of the {minutes} min window', { percent, minutes })
    )
  }
  return parts.length ? parts.join(' · ') : null
}
