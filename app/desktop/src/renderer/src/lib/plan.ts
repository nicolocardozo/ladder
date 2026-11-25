// Commentable plan: when a chat item is a plan and how comment lines are numbered.
import type { ChatItem } from '@shared/protocol'

type ToolChatItem = Extract<ChatItem, { kind: 'tool' }>

/** Plan text of a 'tool' row (Claude's ExitPlanMode): tool 'plan' and non-empty detail. Null for other rows. */
export function planOfTool(item: Pick<ToolChatItem, 'tool' | 'detail'>): string | null {
  return item.tool === 'plan' && item.detail && item.detail.trim() ? item.detail : null
}

/** Stable plan key for its comments: they survive closing the document as long as the text does not change. */
export function planScope(sessionId: string, text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `plan:${sessionId}:${(hash >>> 0).toString(36)}`
}

/** Plan lines, numbered from 1 like the session.implement comments. */
export function planLines(text: string): string[] {
  return text.replace(/\s+$/, '').split(/\r\n?|\n/)
}
