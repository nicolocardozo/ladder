// Commenti sulle righe del diff: si raccolgono per ambito e partono insieme come un solo messaggio all'agente.
import { create } from 'zustand'

export interface LineComment {
  id: string
  path: string
  /** Riga nel file nuovo, oppure nel vecchio per le righe tolte. */
  side: 'new' | 'old'
  line: number
  /** Codice della riga, per dare contesto all'agente. */
  code: string
  text: string
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

/** Messaggio per l'agente: ogni commento con file, riga e codice citato. */
export function commentsMessage(comments: LineComment[]): string {
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  const blocks = sorted.map((c, i) => {
    const where = `${c.path}:${c.line}${c.side === 'old' ? ' (riga tolta)' : ''}`
    const code = c.code.trim() ? `\n   > ${c.code.trim()}` : ''
    return `${i + 1}. \`${where}\`${code}\n   ${c.text.trim().replace(/\n/g, '\n   ')}`
  })
  return `Ho commentato le modifiche. Rispondi a ogni punto:\n\n${blocks.join('\n\n')}`
}
