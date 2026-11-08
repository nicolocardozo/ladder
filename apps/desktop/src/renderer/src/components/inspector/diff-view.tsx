// Diff di un file: vista unificata o affiancata, evidenziazione del tema, commenti sulle righe.
// Le righe aggiunte e tolte hanno sempre anche il segno + o −: si distinguono senza colore (temi Mono).
import { Fragment, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { MessageSquarePlus, Pencil, Trash2 } from 'lucide-react'
import type { FilePatch } from '@shared/protocol'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { CodeText, useFileTokens } from './code-lines'
import { lineKey, parsePatch, splitRows, type DiffLine } from './diff-parse'
import type { LineComment } from './comments'

const ROW_LIMIT = 1500

interface DiffViewProps {
  patch: FilePatch
  mode: 'unified' | 'split'
  comments: LineComment[]
  /** Senza callback i commenti sono spenti (sessione terminale o nessuna sessione). */
  onAddComment?: (line: DiffLine, text: string) => void
  onUpdateComment: (id: string, text: string) => void
  onDeleteComment: (id: string) => void
}

const ADD_BG = 'bg-[color-mix(in_oklab,var(--ladder-success)_13%,transparent)]'
const DEL_BG = 'bg-[color-mix(in_oklab,var(--ladder-error)_13%,transparent)]'

export function DiffView({ patch, mode, comments, onAddComment, onUpdateComment, onDeleteComment }: DiffViewProps) {
  const hunks = useMemo(() => parsePatch(patch.patch), [patch.patch])
  const oldTokens = useFileTokens(patch.oldText, patch.oldPath ?? patch.path)
  const newTokens = useFileTokens(patch.newText, patch.path)
  const [editing, setEditing] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const byLine = useMemo(() => {
    const map = new Map<string, LineComment[]>()
    for (const c of comments) {
      const key = `${c.side === 'old' ? 'o' : 'n'}${c.line}`
      map.set(key, [...(map.get(key) ?? []), c])
    }
    return map
  }, [comments])

  if (patch.binary) return <Empty>{t('Binary file. Its contents can’t be compared here.')}</Empty>
  if (patch.tooLarge) return <Empty>{t('File too large to diff. Open it in the editor.')}</Empty>
  if (hunks.length === 0) return <Empty>{t('No content differences (only the name or permissions changed).')}</Empty>

  const tokensFor = (line: DiffLine) => (line.kind === 'del' ? oldTokens?.[(line.oldNo ?? 1) - 1] : newTokens?.[(line.newNo ?? 1) - 1])

  let rows = 0
  const truncated = () => !showAll && rows >= ROW_LIMIT

  const thread = (line: DiffLine, colSpan: number) => {
    const key = lineKey(line)
    const list = byLine.get(key) ?? []
    const open = editing === key
    if (list.length === 0 && !open) return null
    return (
      <tr>
        <td colSpan={colSpan} className="border-y border-border bg-muted/60 px-3 py-2">
          <div className="flex flex-col gap-2 font-sans">
            {list.map((c) => (
              <CommentNote key={c.id} comment={c} onUpdate={(text) => onUpdateComment(c.id, text)} onDelete={() => onDeleteComment(c.id)} />
            ))}
            {open && onAddComment && (
              <CommentEditor
                initial=""
                onSave={(text) => {
                  onAddComment(line, text)
                  setEditing(null)
                }}
                onCancel={() => setEditing(null)}
              />
            )}
          </div>
        </td>
      </tr>
    )
  }

  const addButton = (line: DiffLine) =>
    onAddComment ? (
      <button
        type="button"
        aria-label={t('Comment on line {line}', { line: (line.kind === 'del' ? line.oldNo : line.newNo) ?? '' })}
        onClick={() => setEditing(lineKey(line))}
        className="absolute top-0 -left-0.5 grid size-[19px] place-items-center rounded bg-primary text-primary-foreground opacity-0 outline-none group-hover:opacity-100 focus-visible:opacity-100"
      >
        <MessageSquarePlus className="size-3" />
      </button>
    ) : null

  const sign = (line: DiffLine) => (line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ')
  const bg = (line: DiffLine | null) => (line?.kind === 'add' ? ADD_BG : line?.kind === 'del' ? DEL_BG : '')
  const num = 'w-[1%] min-w-9 select-none px-1.5 text-right align-top text-faint tabular-nums'

  const body: ReactNode[] = []
  hunks.forEach((hunk, h) => {
    if (truncated()) return
    body.push(
      <tr key={`h${h}`}>
        <td colSpan={mode === 'split' ? 4 : 3} className="bg-muted/70 px-3 py-1 font-mono text-xs text-muted-foreground">
          {hunk.header.replace(/@@(.*)@@.*/, '@@$1@@')}
          {hunk.section && <span className="ml-2 text-faint">{hunk.section}</span>}
        </td>
      </tr>
    )
    if (mode === 'unified') {
      for (const line of hunk.lines) {
        if (truncated()) break
        rows++
        body.push(
          <Fragment key={`${h}:${lineKey(line)}:${line.kind}`}>
            <tr className={cn('group', bg(line))}>
              <td className={num}>{line.oldNo ?? ''}</td>
              <td className={cn(num, 'relative')}>
                {addButton(line)}
                {line.newNo ?? ''}
              </td>
              <td className="py-0 pr-3 pl-1 whitespace-pre">
                <span aria-hidden className={cn('mr-2 inline-block w-2 select-none', line.kind === 'add' ? 'text-success' : 'text-destructive')}>
                  {sign(line)}
                </span>
                <span className="sr-only">{line.kind === 'add' ? `${t('added:')} ` : line.kind === 'del' ? `${t('removed:')} ` : ''}</span>
                <CodeText text={line.text} tokens={tokensFor(line)} />
              </td>
            </tr>
            {thread(line, 3)}
          </Fragment>
        )
      }
    } else {
      for (const row of splitRows(hunk.lines)) {
        if (truncated()) break
        rows++
        const side = (line: DiffLine | null, which: 'left' | 'right') => (
          <>
            <td className={cn(num, 'relative', bg(line))}>
              {/* Commento: righe tolte a sinistra, tutte le altre a destra. */}
              {line && (line.kind === 'del' || which === 'right') ? addButton(line) : null}
              {line ? (which === 'left' ? line.oldNo : line.newNo) : ''}
            </td>
            <td className={cn('w-1/2 py-0 pr-2 pl-1 whitespace-pre', bg(line), which === 'left' && 'border-r border-border')}>
              {line && (
                <>
                  <span aria-hidden className={cn('mr-1.5 inline-block w-2 select-none', line.kind === 'add' ? 'text-success' : 'text-destructive')}>
                    {line.kind === 'context' ? ' ' : sign(line)}
                  </span>
                  <CodeText text={line.text} tokens={tokensFor(line)} />
                </>
              )}
            </td>
          </>
        )
        const { left, right } = row
        const key = `${h}:${left ? lineKey(left) : '-'}:${right ? lineKey(right) : '-'}`
        body.push(
          <Fragment key={key}>
            <tr className="group">
              {side(left, 'left')}
              {side(right, 'right')}
            </tr>
            {left && left.kind === 'del' && thread(left, 4)}
            {right && thread(right, 4)}
          </Fragment>
        )
      }
    }
  })

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-xs leading-[19px]">
        <tbody>{body}</tbody>
      </table>
      {!showAll && rows >= ROW_LIMIT && (
        <button type="button" onClick={() => setShowAll(true)} className="w-full border-t border-border py-2 text-xs text-primary hover:bg-accent">
          {t('Show the rest of the diff')}
        </button>
      )}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-3 text-sm text-muted-foreground">{children}</p>
}

function CommentEditor({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  const save = () => text.trim() && onSave(text.trim())
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && event.metaKey) {
      event.preventDefault()
      save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        ref={ref}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        aria-label={t('Line comment')}
        placeholder={t('What should change here?')}
        className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!text.trim()}
          className="h-6 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {t('Add')}
        </button>
        <button type="button" onClick={onCancel} className="h-6 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent">
          {t('Cancel')}
        </button>
        <span className="ml-auto font-mono text-xs text-faint">{t('⌘↵ to add')}</span>
      </div>
    </div>
  )
}

function CommentNote({ comment, onUpdate, onDelete }: { comment: LineComment; onUpdate: (text: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false)
  if (editing)
    return (
      <CommentEditor
        initial={comment.text}
        onSave={(text) => {
          onUpdate(text)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  return (
    <div className="group/c flex items-start gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm">
      <span className="min-w-0 flex-1 whitespace-pre-wrap">
        {comment.author && <span className="mr-1.5 rounded-[4px] border border-input px-1 text-xs font-semibold text-muted-foreground">{comment.author}</span>}
        {comment.text}
      </span>
      <button type="button" aria-label={t('Edit comment')} onClick={() => setEditing(true)} className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent">
        <Pencil className="size-3" />
      </button>
      <button type="button" aria-label={t('Delete comment')} onClick={onDelete} className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent">
        <Trash2 className="size-3" />
      </button>
    </div>
  )
}
