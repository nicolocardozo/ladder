// Dove trovare Codex: la CLI dell'utente, poi quella dell'app Codex, poi quella delle estensioni per Cursor e VS Code.
// Il binario pesa circa 350 MB: Ladder non ne porta una copia sua (LADDER_CODEX lo indica per le prove).
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { t } from '@shared/i18n'
import type { AgentStatus } from '@shared/protocol'
import { agentEnv, whichInShell } from '../agents/common'
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

export async function findCodexCli(): Promise<string | null> {
  if (process.env.LADDER_CODEX) return existsSync(process.env.LADDER_CODEX) ? process.env.LADDER_CODEX : null
  const inShell = await whichInShell('codex')
  if (inShell) return inShell
  for (const path of ['/Applications/Codex.app/Contents/Resources/codex', join(homedir(), 'Applications/Codex.app/Contents/Resources/codex')]) {
    if (existsSync(path)) return path
  }
  return extensionBinaries()[0] ?? null
}

export async function codexVersion(cli: string): Promise<string | null> {
  try {
    const { stdout } = await run(cli, ['--version'], { timeout: 10000 })
    return stdout.trim().split(/\s+/).pop() ?? null
  } catch {
    return null
  }
}

/** Le chiavi API scavalcherebbero il login di ChatGPT: vale quello della CLI. */
export const CODEX_STRIP_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY']

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
}

export function parseModels(data: unknown): CodexModel[] {
  const list = ((data as { data?: unknown[] })?.data ?? []) as Record<string, unknown>[]
  return list
    .filter((m) => !m.hidden)
    .map((m) => ({
      id: String(m.id ?? m.model),
      label: String(m.displayName ?? m.id),
      efforts: ((m.supportedReasoningEfforts ?? []) as { reasoningEffort: string }[]).map((e) => e.reasoningEffort),
      isDefault: m.isDefault === true
    }))
}

/** Account e modelli, con un app-server di breve durata: non consuma quota (nessun turno). */
export async function probeCodex(cli: string, version: string): Promise<Pick<AgentStatus, 'account' | 'email' | 'models' | 'limits'>> {
  const rpc = new CodexRpc(cli, await agentEnv(CODEX_STRIP_ENV), () => undefined, async () => ({ error: { code: -32601, message: t('unexpected') } }))
  try {
    await rpc.initialize(version)
    const account = await rpc.request<{ account: Record<string, unknown> | null }>('account/read', { refreshToken: false }, 15000)
    const models = parseModels(await rpc.request('model/list', {}, 15000))
    let limits: string | null = null
    try {
      limits = describeLimits(await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }, 15000))
    } catch {
      limits = null
    }
    return { account: accountLabel(account.account), email: accountEmail(account.account), models: models.map((m) => ({ id: m.id, label: m.label })), limits }
  } finally {
    rpc.kill()
  }
}

/** "14% della finestra di 5 h · 11% settimanale" dai limiti d'uso di Codex. */
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
