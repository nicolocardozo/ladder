// Permission levels of the composer: they are common to all agents, `native` says what they correspond to for each.
import type { AgentId, AgentStatus, Effort, PermissionLevel } from '@shared/protocol'
import { t } from '@shared/i18n'

export type { PermissionLevel }

// Labels and explanations in English: they are translated where shown, with t() or with levelLabel/levelHint/levelNative.
export const permissionLevels: { id: PermissionLevel; label: string; hint: string; native: Record<'claude-code' | 'codex' | 'acp', string> }[] = [
  { id: 'plan', label: 'Plan', hint: 'Reads and proposes, never edits', native: { 'claude-code': 'plan', codex: 'read-only · on-request', acp: 'plan or read-only mode' } },
  { id: 'ask', label: 'Ask', hint: 'Asks before every edit or command', native: { 'claude-code': 'default', codex: 'workspace-write · untrusted', acp: 'default mode' } },
  { id: 'edit', label: 'Edit', hint: 'Edits files, asks before commands', native: { 'claude-code': 'acceptEdits', codex: 'workspace-write · on-request', acp: 'mode that accepts edits' } },
  { id: 'full', label: 'Full access', hint: 'No prompts: use with care', native: { 'claude-code': 'bypassPermissions', codex: 'danger-full-access · never', acp: 'full access, if the agent offers it' } }
]

function levelInfo(level: PermissionLevel) {
  return permissionLevels.find((p) => p.id === level) ?? permissionLevels[2]
}

/** Name of the level in the current language. */
export function levelLabel(level: PermissionLevel): string {
  return t(levelInfo(level).label)
}

/** Short explanation of the level in the current language. */
export function levelHint(level: PermissionLevel): string {
  return t(levelInfo(level).hint)
}

/** What the level corresponds to for the agent: native names stay those of the CLI, the ACP description is translated. */
export function levelNative(level: PermissionLevel, agent: AgentId): string {
  return t(levelInfo(level).native[nativeKey(agent)])
}

export const LEVEL_ORDER: PermissionLevel[] = ['plan', 'ask', 'edit', 'full']

/** Levels allowed by the project ([agents] permissions_max). */
export function allowedLevels(max: PermissionLevel | null | undefined): PermissionLevel[] {
  return max ? LEVEL_ORDER.slice(0, LEVEL_ORDER.indexOf(max) + 1) : LEVEL_ORDER
}

export function nativeKey(agent: AgentId): 'claude-code' | 'codex' | 'acp' {
  return agent === 'claude-code' || agent === 'codex' ? agent : 'acp'
}

/** ACP agents choose reasoning with their own options: the effort selector applies to native ones. */
export function supportsEffort(agent: AgentId): boolean {
  return agent === 'claude-code' || agent === 'codex'
}

export const FALLBACK_AGENT: AgentStatus = { agent: 'claude-code', name: 'Claude', kind: 'native', available: false, version: null, account: null, models: [], error: null }

// Effort levels, from lowest to highest. Labels in English: they are translated with t() where shown.
export const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' }
]
