// Tools of the Ladder MCP server as they appear in chat: recognition, input and readable titles.
import { t } from '@shared/i18n'
import type { AgentId, AgentStatus } from '@shared/protocol'

export type LadderTool = 'delegate' | 'handoff' | 'list_agents' | 'report_result'

const TOOL_RE = /^(?:mcp__ladder__|ladder(?:\.|__|:))(delegate|handoff|list_agents|report_result)$/

/** The tool name (with the MCP prefix of the "ladder" server) if it is one of Ladder's. */
export function ladderToolOf(name: string): LadderTool | null {
  const match = TOOL_RE.exec(name)
  return match ? (match[1] as LadderTool) : null
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

/** Call input: the host gives it as JSON in the detail; plain text counts as the prompt. */
export function ladderToolInput(detail: string | null): { agent: string | null; prompt: string | null } {
  if (!detail) return { agent: null, prompt: null }
  if (detail.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(detail) as Record<string, unknown>
      return { agent: str(parsed.agent), prompt: str(parsed.prompt) ?? str(parsed.summary) }
    } catch {
      /* truncated or invalid JSON: recover the fields, never show the raw JSON */
      const field = (name: string) => new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(detail)?.[1]?.replace(/\\n/g, '\n').replace(/\\"/g, '"') ?? null
      return { agent: field('agent'), prompt: field('prompt') ?? field('summary') }
    }
  }
  return { agent: null, prompt: detail }
}

/** The first part of a text, on one line: for the delegation row title. */
export function firstChunk(text: string | null, max = 90): string | null {
  const line = text
    ?.split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return null
  const flat = line.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** Agent from an input value ("codex", "acp:gemini", "Codex"): by id or by name. */
export function resolveAgent(agents: AgentStatus[], value: string | null): AgentId | null {
  if (!value) return null
  const v = value.trim().toLowerCase()
  return agents.find((a) => a.agent.toLowerCase() === v || a.name.toLowerCase() === v)?.agent ?? null
}

/** Readable title; `agent` is the already resolved name (null if unknown) and `prompt` the delegation text. */
export function ladderToolTitle(tool: LadderTool, agent: string | null, prompt: string | null): string {
  switch (tool) {
    case 'delegate': {
      const who = agent ?? t('another agent')
      const task = firstChunk(prompt)
      return task ? t('Delegates to {agent}: {task}', { agent: who, task }) : t('Delegates to {agent}', { agent: who })
    }
    case 'handoff':
      return t('Hands off to {agent}', { agent: agent ?? t('another agent') })
    case 'list_agents':
      return t('Lists available agents')
    case 'report_result':
      return t('Reports the result')
  }
}
