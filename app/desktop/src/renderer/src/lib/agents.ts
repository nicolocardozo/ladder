// Livelli di permesso del composer: sono comuni a tutti gli agenti, `native` dice a cosa corrispondono per ciascuno.
import type { AgentId, AgentStatus, Effort, PermissionLevel } from '@shared/protocol'
import { t } from '@shared/i18n'

export type { PermissionLevel }

// Etichette e spiegazioni in inglese: si traducono dove si mostrano, con t() o con levelLabel/levelHint/levelNative.
export const permissionLevels: { id: PermissionLevel; label: string; hint: string; native: Record<'claude-code' | 'codex' | 'acp', string> }[] = [
  { id: 'plan', label: 'Plan', hint: 'Reads and proposes, never edits', native: { 'claude-code': 'plan', codex: 'read-only · on-request', acp: 'plan or read-only mode' } },
  { id: 'ask', label: 'Ask', hint: 'Asks before every edit or command', native: { 'claude-code': 'default', codex: 'workspace-write · untrusted', acp: 'default mode' } },
  { id: 'edit', label: 'Edit', hint: 'Edits files, asks before commands', native: { 'claude-code': 'acceptEdits', codex: 'workspace-write · on-request', acp: 'mode that accepts edits' } },
  { id: 'full', label: 'Full access', hint: 'No prompts: use with care', native: { 'claude-code': 'bypassPermissions', codex: 'danger-full-access · never', acp: 'full access, if the agent offers it' } }
]

function levelInfo(level: PermissionLevel) {
  return permissionLevels.find((p) => p.id === level) ?? permissionLevels[2]
}

/** Nome del livello nella lingua corrente. */
export function levelLabel(level: PermissionLevel): string {
  return t(levelInfo(level).label)
}

/** Spiegazione breve del livello nella lingua corrente. */
export function levelHint(level: PermissionLevel): string {
  return t(levelInfo(level).hint)
}

/** A cosa corrisponde il livello per l'agente: i nomi dei nativi restano quelli del CLI, la descrizione ACP si traduce. */
export function levelNative(level: PermissionLevel, agent: AgentId): string {
  return t(levelInfo(level).native[nativeKey(agent)])
}

export const LEVEL_ORDER: PermissionLevel[] = ['plan', 'ask', 'edit', 'full']

/** Livelli ammessi dal progetto ([agents] permissions_max). */
export function allowedLevels(max: PermissionLevel | null | undefined): PermissionLevel[] {
  return max ? LEVEL_ORDER.slice(0, LEVEL_ORDER.indexOf(max) + 1) : LEVEL_ORDER
}

export function nativeKey(agent: AgentId): 'claude-code' | 'codex' | 'acp' {
  return agent === 'claude-code' || agent === 'codex' ? agent : 'acp'
}

/** Gli agenti ACP scelgono il ragionamento con le loro opzioni: il selettore di effort vale per i nativi. */
export function supportsEffort(agent: AgentId): boolean {
  return agent === 'claude-code' || agent === 'codex'
}

export const FALLBACK_AGENT: AgentStatus = { agent: 'claude-code', name: 'Claude', kind: 'native', available: false, version: null, account: null, models: [], error: null }

// Livelli di effort, dal più basso al più alto. Etichette in inglese: si traducono con t() dove si mostrano.
export const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' }
]
