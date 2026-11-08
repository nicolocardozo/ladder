// Livelli di permesso del composer: sono comuni a tutti gli agenti, `native` dice a cosa corrispondono per ciascuno.
import type { AgentId, AgentStatus, PermissionLevel } from '@shared/protocol'

export type { PermissionLevel }

export const permissionLevels: { id: PermissionLevel; label: string; hint: string; native: Record<'claude-code' | 'codex' | 'acp', string> }[] = [
  { id: 'plan', label: 'Piano', hint: 'Legge e propone, non modifica', native: { 'claude-code': 'plan', codex: 'read-only · on-request', acp: 'modalità piano o sola lettura' } },
  { id: 'ask', label: 'Chiedi', hint: 'Chiede prima di ogni modifica o comando', native: { 'claude-code': 'default', codex: 'workspace-write · untrusted', acp: 'modalità predefinita' } },
  { id: 'edit', label: 'Modifica', hint: 'Modifica i file, chiede per i comandi', native: { 'claude-code': 'acceptEdits', codex: 'workspace-write · on-request', acp: 'modalità che accetta le modifiche' } },
  { id: 'full', label: 'Accesso completo', hint: 'Nessuna richiesta: usalo con attenzione', native: { 'claude-code': 'bypassPermissions', codex: 'danger-full-access · never', acp: 'accesso completo, se l’agente lo offre' } }
]

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

export const FALLBACK_AGENT: AgentStatus = { agent: 'claude-code', name: 'Claude Code', kind: 'native', available: false, version: null, account: null, models: [], error: null }
