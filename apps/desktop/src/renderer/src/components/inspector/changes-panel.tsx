// Pannello Modifiche: ambito (turno, sessione, non committate), file con +/−, diff unificato o affiancato,
// commenti sulle righe inviati all'agente in un solo messaggio, ripristino di un file o di tutto con annullamento.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Columns2, ExternalLink, Eye, Rows3, ScanSearch, Send, Undo2, X } from 'lucide-react'
import type { AgentId, ChatItem, DiffResult, DiffScope, FileChange, FilePatch, ReviewState, SessionSummary } from '@shared/protocol'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { request, send } from '@/lib/host-client'
import { cn } from '@/lib/utils'
import { useApp, type InspectorRequest } from '@/store/app-store'
import { plural, t } from '@shared/i18n'
import { commentsMessage, useComments, type LineComment } from './comments'
import { DiffView } from './diff-view'
import { AgentMark } from '@/components/agent-mark'
import { useRestore } from './use-restore'
import { openInEditor } from './open-file'

const MODE_KEY = 'ladder.diff-mode'
const NO_COMMENTS: LineComment[] = []
/** Ambito scelto per cartella e sessione: resta quando cambi scheda e torni. */
const rememberedScope = new Map<string, DiffScope>()
/** Ultima richiesta esterna già applicata: rimontare il pannello non la riapplica. */
let handledNonce = 0

export function scopeKey(scope: DiffScope): string {
  switch (scope.kind) {
    case 'turn':
      return `turn:${scope.turnId}`
    case 'session':
      return `session:${scope.sessionId}`
    case 'uncommitted':
      return 'uncommitted'
    case 'commit':
      return `commit:${scope.sha}`
    case 'range':
      return `range:${scope.from}..${scope.to}`
  }
}

interface TurnOption {
  turnId: string
  label: string
  files: number
  index: number
}

/** Turni con file modificati, dal più recente, con il messaggio che li ha avviati. */
function turnOptions(items: ChatItem[]): TurnOption[] {
  const prompts = new Map<string, string>()
  for (const item of items) if (item.kind === 'user' && !prompts.has(item.turnId)) prompts.set(item.turnId, item.text.split('\n')[0])
  const ends = items.filter((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')
  return ends
    .map((end, index) => ({ turnId: end.turnId, label: prompts.get(end.turnId) ?? t('Turn'), files: end.files.length, index: index + 1 }))
    .filter((turn) => turn.files > 0)
    .reverse()
}

function readMode(): 'unified' | 'split' {
  try {
    return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

interface ChangesPanelProps {
  projectId: string
  root: string
  isGit: boolean
  session: SessionSummary | null
  items: ChatItem[]
  request: InspectorRequest | null
}

export function ChangesPanel({ projectId, root, isGit, session, items, request: openRequest }: ChangesPanelProps) {
  const turns = useMemo(() => turnOptions(items), [items])
  const defaultScope = (): DiffScope =>
    session && turns[0] ? { kind: 'turn', sessionId: session.id, turnId: turns[0].turnId } : session ? { kind: 'session', sessionId: session.id } : { kind: 'uncommitted' }
  const memoKey = `${root}|${session?.id ?? ''}`
  const fresh = openRequest?.tab === 'changes' && openRequest.nonce > handledNonce ? openRequest : null
  const [scope, setScopeState] = useState<DiffScope>(() => {
    if (fresh) handledNonce = fresh.nonce
    return fresh?.scope ?? rememberedScope.get(memoKey) ?? defaultScope()
  })
  const setScope = (next: DiffScope) => {
    rememberedScope.set(memoKey, next)
    setScopeState(next)
  }
  const [focusPath, setFocusPath] = useState<string | null>(fresh?.path ?? null)
  const [mode, setMode] = useState(readMode)
  const [result, setResult] = useState<DiffResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const version = useApp((s) => s.fsVersion[root] ?? 0)
  const key = scopeKey(scope)
  const live = scope.kind === 'session' || scope.kind === 'uncommitted' || (scope.kind === 'turn' && session?.run !== 'idle')
  const commentScope = `${root}|${key}`
  const comments = useComments((s) => s.byScope[commentScope] ?? NO_COMMENTS)
  const { add, update, remove, clear } = useComments.getState()
  const { restore, busy, banner } = useRestore(root)
  const expandedFor = useRef<string | null>(null)

  // Richiesta dall'esterno (card del turno, Cronologia): nuovo ambito e file da mostrare.
  useEffect(() => {
    if (!openRequest || openRequest.nonce <= handledNonce || openRequest.tab !== 'changes') return
    handledNonce = openRequest.nonce
    if (openRequest.scope) setScope(openRequest.scope)
    setFocusPath(openRequest.path ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest])

  // Sessione cambiata: l'ambito torna quello predefinito per la nuova sessione.
  const sessionId = session?.id ?? null
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    setScopeState(rememberedScope.get(memoKey) ?? defaultScope())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    if (!isGit) return
    let cancelled = false
    setLoading(true)
    request<DiffResult>({ type: 'diff.files', root, scope })
      .then((data) => {
        if (cancelled) return
        setResult(data)
        setError(null)
        // Nuovo ambito: aperti tutti i file se sono pochi. Un aggiornamento dello stesso ambito non tocca ciò che hai aperto.
        if (expandedFor.current !== key) {
          expandedFor.current = key
          const next = new Set<string>()
          if (data.files.length <= 5) for (const f of data.files) next.add(f.path)
          if (focusPath) next.add(focusPath)
          setExpanded(next)
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message)
          setResult(null)
        }
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, key, isGit, live ? version : 0, live ? session?.run : null])

  // Il file richiesto si apre e scorre in vista.
  useEffect(() => {
    if (!focusPath || !result) return
    setExpanded((current) => new Set(current).add(focusPath))
    requestAnimationFrame(() => document.getElementById(`diff-file-${cssId(focusPath)}`)?.scrollIntoView({ block: 'start' }))
  }, [focusPath, result])

  const changeMode = (next: 'unified' | 'split') => {
    setMode(next)
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {
      // Preferenza solo di questa finestra.
    }
  }

  if (!isGit) return <PanelNote>{t('This project isn’t a git repository. Changes show up here once the folder uses git.')}</PanelNote>

  const running = session ? session.run === 'running' || session.run === 'waiting' || session.run === 'starting' : false
  const scopeLabel = (() => {
    if (scope.kind === 'turn') {
      const turn = turns.find((x) => x.turnId === scope.turnId)
      return turn ? t('Turn {index} · {label}', { index: turn.index, label: turn.label }) : t('Turn')
    }
    if (scope.kind === 'session') return t('Whole session')
    if (scope.kind === 'uncommitted') return t('Uncommitted')
    if (scope.kind === 'commit') return t('Commit {sha}', { sha: scope.sha.slice(0, 7) })
    return scope.label
  })()
  const restoreLabel =
    scope.kind === 'turn'
      ? t('Restored to before the turn')
      : scope.kind === 'session'
        ? t('Restored to before the session')
        : scope.kind === 'uncommitted'
          ? t('Discarded uncommitted changes')
          : t('Restored to the previous state')
  const files = result?.files ?? []
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  const canComment = Boolean(session)

  const sendComments = () => {
    if (!session || comments.length === 0) return
    const text = commentsMessage(comments)
    if (session.mode === 'terminal') {
      // Nella TUI dell'agente il testo arriva come incolla: resta nel prompt, lo invii tu.
      if (session.terminalId) send({ type: 'terminal.input', id: session.terminalId, data: `\x1b[200~${text}\x1b[201~` })
    } else {
      void request({ type: 'session.send', sessionId: session.id, text })
    }
    clear(commentScope)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent">
            <span className="truncate">{scopeLabel}</span>
            <ChevronDown className="size-3 shrink-0 text-faint" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-80" align="start">
            {session && turns.length > 0 && (
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('Session turns')}</DropdownMenuLabel>
                {turns.slice(0, 20).map((turn) => (
                  <DropdownMenuItem key={turn.turnId} onClick={() => setScope({ kind: 'turn', sessionId: session.id, turnId: turn.turnId })}>
                    <Check className={cn('size-3.5', key === `turn:${turn.turnId}` ? '' : 'opacity-0')} />
                    <span className="min-w-0 flex-1 truncate">{t('Turn {index} · {label}', { index: turn.index, label: turn.label })}</span>
                    <span className="text-xs text-faint">{plural(turn.files, '{n} file', '{n} files')}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            )}
            {session && turns.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              {session && (
                <DropdownMenuItem onClick={() => setScope({ kind: 'session', sessionId: session.id })}>
                  <Check className={cn('size-3.5', scope.kind === 'session' ? '' : 'opacity-0')} />
                  {t('Whole session')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setScope({ kind: 'uncommitted' })}>
                <Check className={cn('size-3.5', scope.kind === 'uncommitted' ? '' : 'opacity-0')} />
                {t('Uncommitted (vs HEAD)')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {session && files.length > 0 && <ReviewMenu session={session} scope={scope} />}
          <ToolbarButton label={t('Unified view')} active={mode === 'unified'} onClick={() => changeMode('unified')}>
            <Rows3 className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton label={t('Split view')} active={mode === 'split'} onClick={() => changeMode('split')}>
            <Columns2 className="size-3.5" />
          </ToolbarButton>
        </div>
      </div>

      {session && <ReviewBar session={session} scope={scope} commentScope={commentScope} />}

      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
        <span>
          {loading && !result ? t('Computing diff…') : plural(files.length, '{n} file', '{n} files')}
          {files.length > 0 && (
            <span className="ml-2 font-mono">
              <span className="text-diff-added">+{added}</span> <span className="text-diff-removed">−{removed}</span>
            </span>
          )}
          {result?.live && <span className="ml-2 text-faint">· {t('so far')}</span>}
        </span>
        {files.length > 0 && result && (
          <button
            type="button"
            disabled={running || busy}
            title={running ? t('The session is working. Stop it before restoring.') : t('Restore all these files to their starting state. You can undo.')}
            onClick={() => void restore(result.from, files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])), restoreLabel)}
            className="ml-auto inline-flex h-6 items-center whitespace-nowrap gap-1 rounded-md px-1.5 text-xs outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            <Undo2 className="size-3.5" />
            {t('Restore all')}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <PanelNote tone="error">{error}</PanelNote>}
        {result && files.length === 0 && !error && <PanelNote>{t('No changes in this scope.')}</PanelNote>}
        {result &&
          files.map((file) => (
            <FileSection
              key={`${key}:${file.path}`}
              projectId={projectId}
              root={root}
              file={file}
              from={result.from}
              to={result.to}
              mode={mode}
              open={expanded.has(file.path)}
              onToggle={() =>
                setExpanded((current) => {
                  const next = new Set(current)
                  if (next.has(file.path)) next.delete(file.path)
                  else next.add(file.path)
                  return next
                })
              }
              comments={comments.filter((c) => c.path === file.path)}
              onAddComment={
                canComment
                  ? (line, text) =>
                      add(commentScope, {
                        path: file.path,
                        side: line.kind === 'del' ? 'old' : 'new',
                        line: (line.kind === 'del' ? line.oldNo : line.newNo) ?? 0,
                        code: line.text,
                        text
                      })
                  : undefined
              }
              onUpdateComment={(id, text) => update(commentScope, id, text)}
              onDeleteComment={(id) => remove(commentScope, id)}
              restoreDisabled={running || busy}
              onRestore={() => void restore(result.from, file.oldPath ? [file.oldPath, file.path] : [file.path], `${restoreLabel} · ${baseName(file.path)}`)}
            />
          ))}
      </div>

      {comments.length > 0 && session && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/60 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">{plural(comments.length, '{n} comment', '{n} comments')}</span>
          <button type="button" onClick={() => clear(commentScope)} className="h-7 rounded-md px-2 text-muted-foreground outline-none hover:bg-accent">
            {t('Discard')}
          </button>
          <button
            type="button"
            onClick={sendComments}
            className="inline-flex h-7 items-center whitespace-nowrap gap-1.5 rounded-md bg-primary px-2.5 font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Send className="size-3.5" />
            {session.mode === 'terminal' ? t('Write to terminal') : t('Send to agent')}
          </button>
        </div>
      )}
      {banner}
    </div>
  )
}

function cssId(path: string): string {
  return path.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

const STATUS: Record<FileChange['status'], string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed' }
const patchCache = new Map<string, FilePatch>()

interface FileSectionProps {
  projectId: string
  root: string
  file: FileChange
  from: string
  to: string
  mode: 'unified' | 'split'
  open: boolean
  onToggle: () => void
  comments: LineComment[]
  onAddComment?: Parameters<typeof DiffView>[0]['onAddComment']
  onUpdateComment: (id: string, text: string) => void
  onDeleteComment: (id: string) => void
  restoreDisabled: boolean
  onRestore: () => void
}

function FileSection(props: FileSectionProps) {
  const { projectId, root, file, from, to, mode, open, onToggle, comments, restoreDisabled, onRestore } = props
  const cacheKey = `${root}|${from}..${to}|${file.path}`
  const [patch, setPatch] = useState<FilePatch | null>(() => patchCache.get(cacheKey) ?? null)
  const [error, setError] = useState<string | null>(null)
  const openInspector = useApp((s) => s.openInspector)

  useEffect(() => {
    if (!open) return
    const cached = patchCache.get(cacheKey)
    if (cached) {
      setPatch(cached)
      return
    }
    let cancelled = false
    request<FilePatch>({ type: 'diff.file', root, from, to, path: file.path, oldPath: file.oldPath ?? null })
      .then((data) => {
        patchCache.set(cacheKey, data)
        if (patchCache.size > 200) patchCache.delete(patchCache.keys().next().value as string)
        if (!cancelled) setPatch(data)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [open, cacheKey, root, from, to, file.path, file.oldPath])

  const slash = file.path.lastIndexOf('/')
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ''
  const base = file.path.slice(slash + 1)

  return (
    <section id={`diff-file-${cssId(file.path)}`} className="border-b border-border">
      <div className="sticky top-0 z-[1] flex h-8 items-center gap-1 bg-background/95 pr-1 pl-1.5 backdrop-blur">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          {open ? <ChevronDown className="size-3.5 shrink-0 text-faint" /> : <ChevronRight className="size-3.5 shrink-0 text-faint" />}
          <span aria-label={t(STATUS[file.status])} title={t(STATUS[file.status])} className="w-3 shrink-0 font-mono text-xs text-faint">
            {file.status}
          </span>
          <span className="flex min-w-0 font-mono text-xs" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
            {dir && <span className="min-w-0 truncate text-muted-foreground">{dir}</span>}
            <span className="shrink-0">{base}</span>
          </span>
          <span className="ml-auto flex shrink-0 gap-1.5 pl-2 font-mono text-xs tabular-nums">
            {file.binary ? <span className="text-faint">{t('binary')}</span> : null}
            {file.added > 0 && <span className="text-diff-added">+{file.added}</span>}
            {file.removed > 0 && <span className="text-diff-removed">−{file.removed}</span>}
          </span>
        </button>
        {file.status !== 'D' && (
          <ToolbarButton label={t('Open in viewer')} onClick={() => openInspector(projectId, 'files', { path: file.path })}>
            <Eye className="size-3.5" />
          </ToolbarButton>
        )}
        {file.status !== 'D' && (
          <ToolbarButton label={t('Open in editor')} onClick={() => openInEditor(projectId, `${root}/${file.path}`)}>
            <ExternalLink className="size-3.5" />
          </ToolbarButton>
        )}
        <ToolbarButton label={restoreDisabled ? t('The session is working') : t('Restore this file')} disabled={restoreDisabled} onClick={onRestore}>
          <Undo2 className="size-3.5" />
        </ToolbarButton>
      </div>
      {open &&
        (error ? (
          <PanelNote tone="error">{error}</PanelNote>
        ) : patch ? (
          <DiffView
            patch={patch}
            mode={mode}
            comments={comments}
            onAddComment={props.onAddComment}
            onUpdateComment={props.onUpdateComment}
            onDeleteComment={props.onDeleteComment}
          />
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">{t('Loading diff…')}</p>
        ))}
    </section>
  )
}

export function ToolbarButton({
  label,
  active,
  disabled,
  onClick,
  children
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40',
        active && 'bg-accent text-foreground'
      )}
    >
      {children}
    </button>
  )
}

export function PanelNote({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return <p className={cn('px-3 py-3 text-sm', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{children}</p>
}

// ── Chiedi una review a… ─────────────────────────────────────────────────────

const sameScope = (a: DiffScope, b: DiffScope) => JSON.stringify(a) === JSON.stringify(b)
/** Review già trasformate in commenti: non si aggiungono due volte. */
const appliedReviews = new Set<string>()

/** Un altro agente legge le modifiche in sola lettura e risponde con commenti sulle righe. */
function ReviewMenu({ session, scope }: { session: SessionSummary; scope: DiffScope }) {
  const agents = useApp((s) => s.agents)
  const running = useApp((s) => Object.values(s.reviews).some((r) => r.sessionId === session.id && r.state === 'running'))
  const [error, setError] = useState<string | null>(null)
  const start = async (agent: AgentId) => {
    setError(null)
    try {
      await request<ReviewState>({ type: 'review.start', sessionId: session.id, agent, scope })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={running}
        title={error ?? t('Another agent reviews these changes, read-only')}
        className="mr-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 data-[popup-open]:bg-accent"
      >
        <ScanSearch className="size-3.5 shrink-0" />
        {t('Ask for a review from…')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('Read-only, with the project’s review prompt')}</DropdownMenuLabel>
          {agents.map((agent) => (
            <DropdownMenuItem key={agent.agent} disabled={!agent.available} onClick={() => void start(agent.agent)} className="items-start">
              <AgentMark agent={agent.agent} size={14} className="mt-0.5" />
              <span className="flex flex-col">
                {agent.name}
                <span className="text-xs text-muted-foreground">
                  {!agent.available ? (agent.error ?? t('Unavailable')) : agent.agent === session.agent ? t('Same agent as the session') : agent.kind === 'acp' ? 'ACP' : t('A second opinion')}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {error && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-xs text-destructive">{error}</p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Stato della review per questo ambito; a review finita i commenti entrano nel diff, pronti da inviare. */
function ReviewBar({ session, scope, commentScope }: { session: SessionSummary; scope: DiffScope; commentScope: string }) {
  const review = useApp((s) =>
    Object.values(s.reviews)
      .filter((r) => r.sessionId === session.id && sameScope(r.scope, scope))
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
  )
  const [hidden, setHidden] = useState<string | null>(null)
  useEffect(() => {
    if (!review || review.state !== 'done' || appliedReviews.has(review.id)) return
    appliedReviews.add(review.id)
    const { add } = useComments.getState()
    for (const c of review.comments) add(commentScope, { path: c.path, side: 'new', line: c.line, code: '', text: c.body, author: review.agentName })
  }, [review, commentScope])
  if (!review || hidden === review.id) return null
  const tone = review.state === 'error' ? 'text-destructive' : 'text-muted-foreground'
  return (
    <div role="status" className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/40 px-3 py-2 text-sm">
      <ScanSearch aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className={cn('min-w-0 flex-1', tone)}>
        {review.state === 'running' && t('{agent} is reviewing the changes…', { agent: review.agentName })}
        {review.state === 'done' && (
          <>
            <span className="font-medium text-foreground">{t('Review by {agent}:', { agent: review.agentName })}</span> {review.summary ?? t('no verdict')} ·{' '}
            {review.comments.length === 0 ? t('no comments') : plural(review.comments.length, '{n} comment in the diff', '{n} comments in the diff')}
          </>
        )}
        {review.state === 'error' && t('Review by {agent} failed: {error}', { agent: review.agentName, error: review.error ?? '' })}
        {review.state === 'cancelled' && t('Review by {agent} cancelled.', { agent: review.agentName })}
      </span>
      {review.state === 'running' ? (
        <button type="button" onClick={() => void request({ type: 'review.cancel', reviewId: review.id })} className="h-6 shrink-0 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
          {t('Cancel')}
        </button>
      ) : (
        <button type="button" aria-label={t('Hide')} onClick={() => setHidden(review.id)} className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50">
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}
