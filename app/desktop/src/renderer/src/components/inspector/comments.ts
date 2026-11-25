// Comments on diff lines: collected per scope and sent together as a single message to the agent.
import { create } from 'zustand'
import { t } from '@shared/i18n'

export interface LineComment {
  id: string
  path: string
  /** Line in the new file, or in the old one for removed lines. */
  side: 'new' | 'old'
  line: number
  /** Code of the line, to give context to the agent. */
  code: string
  text: string
  /** Who wrote it, if not you: the review agent ("Codex"). */
  author?: string
}

interface CommentsState {
  byScope: Record<string, LineComment[]>
  add: (scope: string, comment: Omit<LineComment, 'id'>) => void
  update: (scope: string, id: string, text: string) => void
  remove: (scope: string, id: string) => void
  clear: (scope: string) => void
}

let counter = 0

export const useComments = create<CommentsState>((set) => ({
  byScope: {},
  add: (scope, comment) =>
    set((s) => ({ byScope: { ...s.byScope, [scope]: [...(s.byScope[scope] ?? []), { ...comment, id: `c${++counter}` }] } })),
  update: (scope, id, text) =>
    set((s) => ({ byScope: { ...s.byScope, [scope]: (s.byScope[scope] ?? []).map((c) => (c.id === id ? { ...c, text } : c)) } })),
  remove: (scope, id) => set((s) => ({ byScope: { ...s.byScope, [scope]: (s.byScope[scope] ?? []).filter((c) => c.id !== id) } })),
  clear: (scope) =>
    set((s) => {
      const byScope = { ...s.byScope }
      delete byScope[scope]
      return { byScope }
    })
}))

/** Message for the agent: each comment with file, line and quoted code. */
export function commentsMessage(comments: LineComment[]): string {
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  const blocks = sorted.map((c, i) => {
    const where = `${c.path}:${c.line}${c.side === 'old' ? ` ${t('(removed line)')}` : ''}`
    const code = c.code.trim() ? `\n   > ${c.code.trim()}` : ''
    const by = c.author ? ` ${t('(from {author})', { author: c.author })}` : ''
    return `${i + 1}. \`${where}\`${by}${code}\n   ${c.text.trim().replace(/\n/g, '\n   ')}`
  })
  return `${t('I commented on the changes. Reply to each point:')}\n\n${blocks.join('\n\n')}`
}
