// Plan as a commentable document: the markdown text with numbered lines, one comment per line (same interaction as the
// diff comments) and "Implement with…", which sends plan and comments to an agent. Opened from "Open plan" in chat: `planDocument` in the store.
import { ChevronDown, FileText, MessageSquare, MessageSquarePlus, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentStatus, PermissionLevel, Project } from '@shared/protocol'
import { plural, t } from '@shared/i18n'
import { AgentChoiceFields, Field, useAgentChoice } from '@/components/agent-fields'
import { CommentEditor, CommentNote } from '@/components/inspector/diff-view'
import { useComments, type LineComment } from '@/components/inspector/comments'
import { useProjectSettings } from '@/components/main-views'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { allowedLevels, levelHint, levelLabel, supportsEffort } from '@/lib/agents'
import { request } from '@/lib/host-client'
import { planLines, planScope } from '@/lib/plan'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

const NO_COMMENTS: LineComment[] = []
const GUTTER = 'grid-cols-[3.5rem_minmax(0,1fr)]'

type Kind = 'blank' | 'heading' | 'bullet' | 'quote' | 'code' | 'fence' | 'table' | 'text'
interface Row {
  kind: Kind
  /** Text to show (without the markdown marks the line already expresses). */
  text: string
  level: number
  marker?: string
}

/** Classifies each plan line: numbering stays that of the text, rendering is read-only. */
function classify(lines: string[]): Row[] {
  let fenced = false
  return lines.map((line): Row => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      return { kind: 'fence', text: line.trim().replace(/^```/, ''), level: 0 }
    }
    if (fenced) return { kind: 'code', text: line, level: 0 }
    if (!line.trim()) return { kind: 'blank', text: '', level: 0 }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) return { kind: 'heading', text: heading[2], level: heading[1].length }
    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bullet) return { kind: 'bullet', text: bullet[3], level: Math.floor(bullet[1].replace(/\t/g, '  ').length / 2), marker: /\d/.test(bullet[2]) ? bullet[2] : '•' }
    if (/^\s*>/.test(line)) return { kind: 'quote', text: line.replace(/^\s*>\s?/, ''), level: 0 }
    if (/^\s*\|/.test(line)) return { kind: 'table', text: line, level: 0 }
    return { kind: 'text', text: line, level: 0 }
  })
}

/** **bold** and `code` inside a line; the rest stays text. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i} className="rounded-[4px] bg-muted px-1 font-mono text-xs text-foreground/90">{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
    return <Fragment key={i}>{part}</Fragment>
  })
}

function RowContent({ row }: { row: Row }) {
  switch (row.kind) {
    case 'heading':
      return <p className={cn('font-semibold break-words text-foreground', row.level === 1 ? 'pt-2 text-lg leading-7' : row.level === 2 ? 'pt-1.5 text-base leading-6' : 'pt-1 text-sm leading-6')}>{inline(row.text)}</p>
    case 'bullet':
      return (
        <p className="flex gap-2 text-base leading-6 break-words text-foreground" style={{ paddingLeft: row.level * 16 }}>
          <span aria-hidden className="w-4 shrink-0 text-right text-muted-foreground tabular-nums">{row.marker}</span>
          <span className="min-w-0">{inline(row.text)}</span>
        </p>
      )
    case 'quote':
      return <p className="pl-3 text-base leading-6 break-words text-muted-foreground italic">{inline(row.text)}</p>
    case 'fence':
      return <p className="font-mono text-xs leading-6 text-faint">{row.text ? `\`\`\` ${row.text}` : '```'}</p>
    case 'code':
    case 'table':
      return <p className="font-mono text-xs leading-6 break-words whitespace-pre-wrap text-foreground/85">{row.text || ' '}</p>
    default:
      return <p className="text-base leading-6 break-words text-foreground">{inline(row.text)}</p>
  }
}

/** Mounted once in App: the content stays during the close animation. */
export function PlanDialog() {
  const doc = useApp((s) => s.planDocument)
  const setDoc = useApp((s) => s.setPlanDocument)
  const shown = useRef(doc)
  if (doc) shown.current = doc
  const bodyRef = useRef<HTMLDivElement>(null)
  return (
    <Dialog open={doc !== null} onOpenChange={(open) => !open && setDoc(null)}>
      <DialogContent showCloseButton={false} initialFocus={bodyRef} aria-describedby={undefined} className="flex max-h-[min(88vh,820px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[820px]">
        {doc && shown.current && <PlanBody key={planScope(shown.current.sessionId, shown.current.text)} bodyRef={bodyRef} sessionId={shown.current.sessionId} text={shown.current.text} onClose={() => setDoc(null)} />}
      </DialogContent>
    </Dialog>
  )
}

function PlanBody({ bodyRef, sessionId, text, onClose }: { bodyRef: React.RefObject<HTMLDivElement | null>; sessionId: string; text: string; onClose: () => void }) {
  const session = useApp((s) => s.sessions[sessionId])
  const scope = planScope(sessionId, text)
  const comments = useComments((s) => s.byScope[scope] ?? NO_COMMENTS)
  const lines = useMemo(() => planLines(text), [text])
  const rows = useMemo(() => classify(lines), [lines])
  const byLine = useMemo(() => {
    const map = new Map<number, LineComment[]>()
    for (const c of comments) map.set(c.line, [...(map.get(c.line) ?? []), c])
    return map
  }, [comments])
  const [editing, setEditing] = useState<number | null>(null)
  const [implementing, setImplementing] = useState(false)

  const startEdit = (n: number) => setEditing(n)
  // When the field closes (Esc, Cancel or Add) focus returns to the line number that opened it.
  const closeEditor = (n: number) => {
    setEditing(null)
    window.requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>(`[data-plan-line="${n}"]`)?.focus())
  }
  const onRowClick = (n: number) => {
    // Selecting text to copy does not open the field.
    if (window.getSelection()?.toString()) return
    startEdit(n)
  }

  return (
    <>
      <div className="flex items-start gap-3 px-5 pt-4 pb-3">
        <FileText aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" strokeWidth={1.9} />
        <div className="min-w-0 flex-1">
          <DialogTitle className="text-lg leading-snug font-semibold">{t('Plan')}</DialogTitle>
          <DialogDescription className="mt-0.5 text-xs">
            {session?.title ? `${session.title} · ` : ''}
            {comments.length > 0 ? plural(comments.length, '{n} comment', '{n} comments') : t('Click a line to comment on it. Comments go with the plan.')}
          </DialogDescription>
        </div>
        <div className="-mt-1 -mr-2 flex shrink-0 items-center gap-1">
          <Button id="plan-implement-trigger" type="button" variant="secondary" size="sm" aria-expanded={implementing} aria-controls="plan-implement" onClick={() => setImplementing((v) => !v)} className="h-7 text-sm font-medium">
            {t('Implement with…')}
            <ChevronDown aria-hidden className={cn('transition-transform motion-reduce:transition-none', implementing && 'rotate-180')} />
          </Button>
          <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label={t('Close')} />}>
            <X aria-hidden />
          </DialogClose>
        </div>
      </div>

      <div
        ref={bodyRef}
        tabIndex={0}
        role="region"
        aria-label={t('Plan text')}
        className="min-h-0 flex-1 overflow-y-auto border-t border-border px-2 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        {rows.map((row, i) => {
          const n = i + 1
          const list = byLine.get(n) ?? []
          if (row.kind === 'blank') return <div key={i} aria-hidden className="h-2" />
          return (
            <Fragment key={i}>
              <div className={cn('group grid rounded-md', GUTTER, list.length > 0 ? 'bg-accent/40' : 'hover:bg-accent/40', row.kind === 'code' && 'bg-[var(--chat-code-bg)]')}>
                <div className="flex items-start justify-end gap-1 pt-[1px] pr-2.5">
                  {list.length > 0 && (
                    <span className="mt-[5px] flex items-center text-muted-foreground" title={plural(list.length, '{n} comment', '{n} comments')}>
                      <MessageSquare aria-hidden className="size-3" strokeWidth={2.2} />
                      <span className="sr-only">{plural(list.length, '{n} comment', '{n} comments')}</span>
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={t('Comment on line {line}', { line: n })}
                    title={t('Comment on line {line}', { line: n })}
                    data-plan-line={n}
                    onClick={() => startEdit(n)}
                    className="relative h-6 min-w-6 rounded-[4px] px-1 text-right font-mono text-xs text-faint tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <span className="group-hover:invisible group-focus-within:invisible">{n}</span>
                    <MessageSquarePlus aria-hidden className="absolute inset-0 m-auto size-3.5 text-primary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" />
                  </button>
                </div>
                <div onClick={() => onRowClick(n)} className="min-w-0 cursor-text py-[1px] pr-3">
                  <RowContent row={row} />
                </div>
              </div>
              {(list.length > 0 || editing === n) && (
                <div className={cn('grid pb-1.5', GUTTER)}>
                  <div className="col-start-2 flex min-w-0 flex-col gap-2 pr-3 font-sans">
                    {list.map((c) => (
                      <CommentNote key={c.id} comment={c} onUpdate={(value) => useComments.getState().update(scope, c.id, value)} onDelete={() => useComments.getState().remove(scope, c.id)} />
                    ))}
                    {editing === n && (
                      <CommentEditor
                        initial=""
                        onSave={(value) => {
                          useComments.getState().add(scope, { path: 'plan.md', side: 'new', line: n, code: lines[i], text: value })
                          closeEditor(n)
                        }}
                        onCancel={() => closeEditor(n)}
                      />
                    )}
                  </div>
                </div>
              )}
            </Fragment>
          )
        })}
      </div>

      {implementing && <ImplementPanel sessionId={sessionId} plan={text} comments={comments} scope={scope} onCancel={() => {
        setImplementing(false)
        window.requestAnimationFrame(() => document.getElementById('plan-implement-trigger')?.focus())
      }} onDone={onClose} />}
    </>
  )
}

function ImplementPanel({ sessionId, plan, comments, scope, onCancel, onDone }: { sessionId: string; plan: string; comments: LineComment[]; scope: string; onCancel: () => void; onDone: () => void }) {
  const session = useApp((s) => s.sessions[sessionId])
  const project = useApp((s) => s.projects.find((p) => p.id === session?.projectId) ?? null) as Project | null
  const agents = useApp((s) => s.agents)
  const settings = useProjectSettings(project)
  const allowed = settings?.agents?.allowed ?? []
  // The session agent too: it keeps the context. Default.
  const targets = useMemo<AgentStatus[]>(() => agents.filter((a) => a.available && (allowed.length === 0 || allowed.includes(a.agent))), [agents, allowed])
  const choice = useAgentChoice(targets, session?.agent ?? null)
  const levels = allowedLevels(settings?.agents?.permissionsMax ?? null)
  const [permission, setPermission] = useState<PermissionLevel>('edit')
  const effectivePermission = levels.includes(permission) ? permission : levels[levels.length - 1]
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const panel = useRef<HTMLFormElement>(null)
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('button')?.focus()
  }, [])

  const problem = !session ? t('This session no longer exists.') : targets.length === 0 ? t('No agent is available here. Check Settings or the project’s allowed agents.') : null

  const submit = async () => {
    if (!session || !choice.agent || busy || problem) return
    setBusy(true)
    setError(null)
    try {
      const sorted = [...comments].sort((a, b) => a.line - b.line)
      const id = await request<string | null>({
        type: 'session.implement',
        sessionId: session.id,
        plan,
        comments: sorted.map((c) => ({ line: c.line, text: c.text })),
        agent: choice.agent,
        model: choice.model,
        effort: supportsEffort(choice.agent) ? choice.effort : null,
        permission: effectivePermission
      })
      useComments.getState().clear(scope)
      onDone()
      // With another agent the implementing session is a different one: it opens. With the same agent the work restarts here.
      if (id && id !== session.id) {
        const state = useApp.getState()
        if (!state.openSessionAt(id, null)) state.select({ kind: 'session', projectId: session.projectId, sessionId: id })
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      id="plan-implement"
      ref={panel}
      className="grid shrink-0 gap-3 border-t border-border px-5 py-3"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <AgentChoiceFields choice={choice} targets={targets} />
        <Field label={t('Permission')}>
          <Select value={effectivePermission} onValueChange={(value) => setPermission(String(value) as PermissionLevel)}>
            <SelectTrigger aria-label={t('Permission')} className="w-full">
              <SelectValue>{(value: string) => levelLabel(value as PermissionLevel)}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              {levels.map((level) => (
                <SelectItem key={level} value={level}>
                  {levelLabel(level)}
                  <span className="ml-2 text-xs text-muted-foreground">{levelHint(level)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        {comments.length > 0
          ? plural(comments.length, 'The plan and {n} comment go to the agent.', 'The plan and {n} comments go to the agent.')
          : t('The plan goes to the agent, with no comments.')}
      </p>
      {(problem || error) && (
        <p role="alert" className="text-xs text-destructive">
          {error ?? problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button type="submit" disabled={busy || Boolean(problem) || !choice.agent} aria-busy={busy}>
          {busy ? t('Starting…') : t('Implement')}
        </Button>
      </div>
    </form>
  )
}
