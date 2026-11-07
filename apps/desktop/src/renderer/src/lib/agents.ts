// Agenti e livelli di permesso mostrati nel composer.
// I livelli sono comuni a tutti gli agenti; `native` dice a cosa corrispondono per ciascuno.

export type AgentId = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'terminal'
export type AgentSource = 'nativo' | 'ACP' | 'PTY'

export interface AgentInfo {
  id: AgentId
  name: string
  source: AgentSource
  detail: string
  defaultModel?: string
}

export const agents: AgentInfo[] = [
  { id: 'claude-code', name: 'Claude Code', source: 'nativo', detail: 'Abbonamento Max', defaultModel: 'Opus 5.5' },
  { id: 'codex', name: 'Codex', source: 'nativo', detail: 'ChatGPT Plus', defaultModel: 'GPT‑6.1 Sol' },
  { id: 'gemini', name: 'Gemini CLI', source: 'ACP', detail: 'Account Google' },
  { id: 'opencode', name: 'OpenCode', source: 'ACP', detail: 'Provider configurati in OpenCode' },
  { id: 'terminal', name: 'Terminale', source: 'PTY', detail: 'Qualunque CLI nella cartella della sessione' }
]

export type PermissionLevel = 'plan' | 'ask' | 'edit' | 'full'

export const permissionLevels: { id: PermissionLevel; label: string; hint: string; native: Partial<Record<AgentId, string>> }[] = [
  { id: 'plan', label: 'Piano', hint: 'Legge e propone, non modifica', native: { 'claude-code': 'plan', codex: 'read-only' } },
  { id: 'ask', label: 'Chiedi', hint: 'Chiede prima di ogni modifica o comando', native: { 'claude-code': 'default', codex: 'read-only + on-request' } },
  { id: 'edit', label: 'Modifica', hint: 'Modifica i file, chiede per i comandi', native: { 'claude-code': 'acceptEdits', codex: 'workspace-write + on-request' } },
  { id: 'full', label: 'Accesso completo', hint: 'Nessuna richiesta: usalo con attenzione', native: { 'claude-code': 'bypassPermissions', codex: 'danger-full-access' } }
]

export function agentById(id: AgentId): AgentInfo {
  return agents.find((a) => a.id === id) ?? agents[0]
}
