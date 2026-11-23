// "Pronto per il merge" (⌘⌥4): stato git in una riga, un pulsante principale che avanza (Commit, Push o Pubblica, Crea PR, Merge, Archivia),
// cose da fare con la loro azione, CI e commenti compatti. Ladder fa commit, push, merge e archivia SOLO su azione esplicita e confermata
// dell'utente (Commit dal suo campo, gli altri dopo un dialogo di conferma), mai su richiesta dell'agente. "Risolvi i conflitti", "Correggi la CI"
// e "Invia i commenti" restano prompt modificabili per l'agente. Il passo successivo lo calcola l'host (`MergeInfo.nextAction`): qui si mostra.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CircleDashed,
  CircleX,
  CloudOff,
  CloudUpload,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Info,
  MessageSquare,
  Minus,
  MoreHorizontal,
  RefreshCw,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'
import type { GitStatus, MergeBlock, MergeCheck, MergeInfo, NextAction, NextActionReason, SessionSummary } from '@shared/protocol'
import { PromptDialog, type PromptRequest } from '@/components/prompt-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { changesLabel, describeGit } from '@/lib/git-status'
import { request } from '@/lib/host-client'
import { relativeAge } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { plural, t } from '@shared/i18n'
import { PanelNote } from './changes-panel'
import { CommitBox } from './commit-box'
import { CreatePrDialog } from './create-pr-dialog'
import { BranchMap } from './branch-map'
import { ArchiveDialog, MergeDialog, PushDialog } from './merge-dialogs'

/** "updated 5 min ago", ma "updated just now" e "updated yesterday" dove "ago" non regge. */
function updatedAgo(at: number): string {
  const minutes = (Date.now() - at) / 60000
  if (minutes < 1) return t('updated just now')
  const age = relativeAge(at)
  return age === t('yesterday') ? t('updated yesterday') : t('updated {age} ago', { age })
}

const NO_ACTION: NextAction = { kind: 'none', blocked: true, reason: null }

/** Frase intera per il motivo di un pulsante disabilitato o di un passo che non c'è (visibile sotto il pulsante e nel tooltip). */
function reasonText(reason: NextActionReason, info: MergeInfo): string {
  const base = info.base ?? ''
  const blockCount = (kind: MergeBlock['kind']) => info.blocks.find((b) => b.kind === kind)?.count
  switch (reason) {
    case 'detached':
      return t('HEAD is detached, not on a branch. Check out a branch to continue.')
    case 'default_branch':
      return t('You’re on {branch}. A PR needs a branch, for example from a worktree.', { branch: info.branch ?? 'HEAD' })
    case 'no_remote':
      return t('This repository has no remote, so there is nowhere to push.')
    case 'no_commits':
      return t('No commits ahead of {base}.', { base })
    case 'github_missing':
      return t('GitHub isn’t connected. Connect it to open and merge PRs; commit and push work without it.')
    case 'github_unauthenticated':
      return t('GitHub needs you to sign in. Connect it to open and merge PRs; commit and push work without it.')
    case 'no_github_remote':
      return t('The repository has no GitHub remote, so PRs aren’t available. Commit and push still work.')
    case 'github_error':
      return t('gh isn’t responding: {error}', { error: info.ghError ?? '' })
    case 'pr_closed':
      return t('The previous PR was closed. Open a new one.')
    case 'behind_upstream':
      return plural(info.behindUpstream, 'The remote has {n} newer commit. Update the branch before pushing.', 'The remote has {n} newer commits. Update the branch before pushing.')
    case 'agent_busy':
      return t('The agent is working.')
    case 'dirty':
      return t('Commit your changes before archiving.')
    case 'unpushed':
      return t('Push your commits before archiving.')
    case 'draft':
      return t('The PR is a draft. Mark it ready for review on GitHub to merge it.')
    case 'conflicts':
      return t('The PR has conflicts with {base}.', { base })
    case 'ci_failing': {
      const n = blockCount('ci_failing') ?? info.checks.filter((c) => c.state === 'failing').length
      return plural(n, 'The PR has {n} failing check.', 'The PR has {n} failing checks.')
    }
    case 'ci_pending': {
      const n = blockCount('ci_pending') ?? info.checks.filter((c) => c.state === 'pending').length
      return plural(n, '{n} check is still running.', '{n} checks are still running.')
    }
    case 'changes_requested':
      return t('The review requests changes.')
    case 'review_required':
      return t('The PR needs a review before it can be merged.')
    case 'behind':
      return t('The branch is behind {base}. Update it first.', { base })
    case 'blocked':
      return t('GitHub is blocking the merge (branch rules).')
  }
}

const PRIMARY: Record<Exclude<NextAction['kind'], 'none'>, { label: string; Icon: LucideIcon }> = {
  commit: { label: 'Commit', Icon: GitCommitHorizontal },
  push: { label: 'Push…', Icon: ArrowUp },
  publish: { label: 'Publish branch…', Icon: CloudUpload },
  create_pr: { label: 'Create PR…', Icon: GitPullRequest },
  merge: { label: 'Merge…', Icon: GitMerge },
  archive: { label: 'Archive…', Icon: Archive }
}

const CHECK_ICON: Record<MergeCheck['state'], { Icon: LucideIcon; label: string; className: string }> = {
  passing: { Icon: Check, label: 'Check passed', className: 'size-3.5 text-success' },
  failing: { Icon: CircleX, label: 'Check failed', className: 'size-3.5 text-destructive' },
  pending: { Icon: CircleDashed, label: 'Check running', className: 'size-3.5 text-muted-foreground' },
  skipped: { Icon: Minus, label: 'Check skipped', className: 'size-3.5 text-faint' }
}

function CheckIcon({ state }: { state: MergeCheck['state'] }) {
  const { Icon, label, className } = CHECK_ICON[state]
  return <Icon aria-label={t(label)} className={className} />
}

const actionButton =
  'inline-flex h-7 items-center whitespace-nowrap gap-1.5 rounded-md border border-input px-2.5 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50'
const primaryButton =
  'inline-flex h-7 items-center whitespace-nowrap gap-1.5 rounded-md bg-primary px-2.5 text-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:opacity-50'

/** Lo stesso stato dell'intestazione se è osservato; altrimenti lo stesso contenuto ricostruito dalla lettura del pannello. */
function statusOf(info: MergeInfo, stored: GitStatus | null): GitStatus {
  return (
    stored ?? {
      root: info.root,
      branch: info.branch,
      upstream: info.upstream ?? null,
      hasUpstream: info.hasUpstream,
      ahead: info.unpushed ?? 0,
      behind: info.behindUpstream ?? 0,
      dirty: info.dirty,
      added: info.added ?? 0,
      removed: info.removed ?? 0,
      isWorktree: false
    }
  )
}

type Dialogs = 'push' | 'merge' | 'archive' | null

export function MergePanel({ projectId, root, isGit, session }: { projectId: string; root: string; isGit: boolean; session: SessionSummary | null }) {
  const [info, setInfo] = useState<MergeInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const [creatingPr, setCreatingPr] = useState(false)
  const [dialog, setDialog] = useState<Dialogs>(null)
  const version = useApp((s) => s.fsVersion[root] ?? 0)
  // GitHub appena collegato o scollegato: si rilegge senza riaprire il pannello.
  const githubVersion = useApp((s) => s.githubVersion)
  const stored = useApp((s) => (session ? (s.gitStatus[s.gitRoot[session.id] ?? ''] ?? null) : null))
  const prKey = session?.pr ? `${session.pr.number}:${session.pr.state}:${session.pr.checks}:${session.pr.mergeable}` : ''
  // L'agente che parte o si ferma cambia `agentBusy`: una lettura per cambio di stato, niente polling.
  const runKey = session?.run ?? ''
  const latest = useRef(0)
  const commitRef = useRef<HTMLDivElement>(null)

  const load = useCallback(
    (fetch: boolean) => {
      const id = ++latest.current
      setLoading(true)
      request<MergeInfo>({ type: 'merge.info', root, fetch })
        .then((data) => {
          if (id !== latest.current) return
          setInfo(data)
          setError(null)
        })
        .catch((e: Error) => id === latest.current && setError(e.message))
        .finally(() => id === latest.current && setLoading(false))
    },
    [root]
  )

  // Si rilegge quando cambiano i file o lo stato della PR; "Aggiorna" legge anche i branch da origin.
  useEffect(() => {
    if (!isGit) return
    const timer = window.setTimeout(() => load(false), version === 0 ? 0 : 600)
    return () => window.clearTimeout(timer)
  }, [isGit, load, version, prKey, githubVersion, runKey])

  if (!isGit) return <PanelNote>{t('This project isn’t a git repository.')}</PanelNote>
  if (error && !info) return <PanelNote tone="error">{error}</PanelNote>
  if (!info) return <PanelNote>{t('Reading branch status…')}</PanelNote>

  const view = describeGit(statusOf(info, stored))
  const blocks = info.blocks ?? []
  const na = info.nextAction ?? NO_ACTION
  const pr = info.pr
  const prRef = pr ? `#${pr.number}` : ''
  const failing = info.checks.filter((c) => c.state === 'failing')
  const pending = info.checks.filter((c) => c.state === 'pending')
  const ask = (name: string, title: string, vars: Record<string, string>) => setPrompt({ name, title, vars })
  const hasBlock = (kind: MergeBlock['kind']) => blocks.some((b) => b.kind === kind)

  const askConflicts = () => ask('conflicts', t('Resolve conflicts'), { branch: info.branch ?? '', base: info.base ?? 'main', conflicts: info.conflicts.map((f) => `- ${f}`).join('\n') })
  const askCi = () => ask('fix', t('Fix CI'), { pr: prRef, checks: failing.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`).join('\n') })
  const askComments = () =>
    ask('comments', t('Reply to comments'), {
      pr: prRef,
      comments: info.comments
        .map((c) => `- ${c.author}${c.path ? ` ${t('on {path}', { path: `${c.path}${c.line ? `:${c.line}` : ''}` })}` : ''}: ${c.body.replace(/\s+/g, ' ').trim()}`)
        .join('\n')
    })

  // "Commit" porta al campo del messaggio; il commit parte solo dal suo pulsante.
  const focusCommit = () => {
    const box = commitRef.current
    box?.scrollIntoView({ block: 'nearest' })
    box?.querySelector<HTMLElement>('input')?.focus()
  }

  const needsSession = (kind: NextAction['kind']) => kind === 'push' || kind === 'publish' || kind === 'merge' || kind === 'archive'
  const run = (kind: NextAction['kind']) => {
    if (kind === 'commit') focusCommit()
    else if (kind === 'push' || kind === 'publish') setDialog('push')
    else if (kind === 'create_pr') setCreatingPr(true)
    else if (kind === 'merge') setDialog('merge')
    else if (kind === 'archive') setDialog('archive')
  }

  const noSession = !session && needsSession(na.kind)
  const primaryBlocked = na.blocked || noSession
  const primaryReason = noSession ? t('Open a session on this branch to push, merge or archive.') : na.reason ? reasonText(na.reason, info) : null
  const primary = na.kind === 'none' ? null : PRIMARY[na.kind]
  const reasonId = 'merge-next-reason'
  const needsGithub = na.reason === 'github_missing' || na.reason === 'github_unauthenticated'

  // Le altre azioni, nel menu accanto. I motivi vengono dall'host (`agentBusy`, `blocks`, `nextAction.reason`): qui non si rifanno le sue regole.
  // Cosa si può inviare o archiviare lo controllano l'anteprima del dialogo e l'host al momento della conferma.
  const unpushed = info.unpushed ?? 0
  const canPush = info.hasRemote && info.branch !== null && ((!info.hasUpstream && info.ahead > 0) || unpushed > 0)
  const pushWhy = !session ? t('Open a session on this branch to push, merge or archive.') : info.agentBusy ? reasonText('agent_busy', info) : na.reason === 'behind_upstream' ? reasonText('behind_upstream', info) : null
  const canCreatePr = info.gh === 'ok' && !info.isDefaultBranch && info.branch !== null && info.ahead > 0 && (!pr || pr.state === 'closed')
  const canMerge = Boolean(pr) && (pr!.state === 'open' || pr!.state === 'draft')
  const mergeWhy = !session ? t('Open a session on this branch to push, merge or archive.') : info.agentBusy ? reasonText('agent_busy', info) : blocks.length > 0 ? reasonText(blocks[0].kind, info) : null
  const canArchive = pr?.state === 'merged'
  const archiveWhy = !session ? t('Open a session on this branch to push, merge or archive.') : info.agentBusy ? reasonText('agent_busy', info) : null
  const menu: { key: string; label: string; Icon: LucideIcon; why: string | null; onSelect: () => void }[] = []
  if (info.dirty > 0 && na.kind !== 'commit') menu.push({ key: 'commit', label: t('Commit'), Icon: GitCommitHorizontal, why: null, onSelect: focusCommit })
  if (canPush && na.kind !== 'push' && na.kind !== 'publish')
    menu.push({ key: 'push', label: info.hasUpstream ? t('Push…') : t('Publish branch…'), Icon: info.hasUpstream ? ArrowUp : CloudUpload, why: pushWhy, onSelect: () => setDialog('push') })
  if (canCreatePr && na.kind !== 'create_pr') menu.push({ key: 'pr', label: t('Create PR…'), Icon: GitPullRequest, why: null, onSelect: () => setCreatingPr(true) })
  if (canMerge && na.kind !== 'merge') menu.push({ key: 'merge', label: t('Merge…'), Icon: GitMerge, why: mergeWhy, onSelect: () => setDialog('merge') })
  if (canArchive && na.kind !== 'archive') menu.push({ key: 'archive', label: t('Archive…'), Icon: Archive, why: archiveWhy, onSelect: () => setDialog('archive') })
  if (pr) menu.push({ key: 'open', label: t('Open PR on GitHub'), Icon: ExternalLink, why: null, onSelect: () => void window.ladder?.openExternal(pr.url) })

  // Cose da fare: una riga per blocco, ognuna con la sua azione quando c'è qualcosa che l'agente può fare.
  interface Todo {
    key: string
    text: string
    tone: 'error' | 'muted'
    action?: { label: string; Icon: LucideIcon; onClick: () => void }
    files?: string[]
  }
  const todos: Todo[] = []
  const conflictCount = blocks.find((b) => b.kind === 'conflicts')?.count ?? info.conflicts.length
  const conflictText = conflictCount
    ? plural(conflictCount, 'Resolve conflicts with {base} in {n} file', 'Resolve conflicts with {base} in {n} files', { base: info.base ?? '' })
    : t('Resolve conflicts with {base}', { base: info.base ?? '' })
  const conflictAction = { label: t('Resolve conflicts…'), Icon: TriangleAlert, onClick: askConflicts }
  if (info.conflicts.length > 0 || hasBlock('conflicts')) todos.push({ key: 'conflicts', text: conflictText, tone: 'error', action: conflictAction, files: info.conflicts })
  for (const block of blocks) {
    if (block.kind === 'conflicts') continue
    if (block.kind === 'ci_failing') todos.push({ key: block.kind, text: plural(block.count ?? failing.length, 'Fix {n} failing check', 'Fix {n} failing checks'), tone: 'error', action: { label: t('Fix CI…'), Icon: TriangleAlert, onClick: askCi } })
    else if (block.kind === 'ci_pending') todos.push({ key: block.kind, text: plural(block.count ?? pending.length, 'Wait for {n} running check', 'Wait for {n} running checks'), tone: 'muted' })
    else if (block.kind === 'changes_requested')
      todos.push({ key: block.kind, text: t('The review requests changes'), tone: 'error', action: info.comments.length > 0 ? { label: t('Send comments to agent…'), Icon: MessageSquare, onClick: askComments } : undefined })
    else if (block.kind === 'review_required') todos.push({ key: block.kind, text: t('Needs a review'), tone: 'muted' })
    else if (block.kind === 'draft') todos.push({ key: block.kind, text: t('The PR is a draft'), tone: 'muted' })
    else if (block.kind === 'behind') todos.push({ key: block.kind, text: t('The branch is behind {base}', { base: info.base ?? '' }), tone: 'muted' })
    else todos.push({ key: block.kind, text: t('GitHub is blocking the merge'), tone: 'muted' })
  }
  const showReady = na.kind === 'merge' && !na.blocked && blocks.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2 text-sm">
        <div className="flex items-center gap-1.5">
          <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn('min-w-0 truncate font-mono text-xs', view.detached && 'italic')}>{info.branch ?? t('Detached HEAD')}</span>
          {!info.isDefaultBranch && info.base && (
            <span className="shrink-0 text-muted-foreground">
              <span aria-hidden>→</span>
              <span className="sr-only">{t('to')}</span> <span className="font-mono text-xs">{info.base}</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => load(true)}
            disabled={loading}
            title={t('Refresh, also fetching branches from origin')}
            aria-label={t('Refresh')}
            className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin motion-reduce:animate-none')} />
          </button>
        </div>
        <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="sr-only">{view.aria}</span>
          {view.ahead > 0 && (
            <span aria-hidden className="inline-flex items-center tabular-nums" title={plural(view.ahead, '{n} commit to push', '{n} commits to push')}>
              <ArrowUp className="size-3" strokeWidth={2} />
              {view.ahead}
            </span>
          )}
          {view.behind > 0 && (
            <span aria-hidden className="inline-flex items-center tabular-nums" title={plural(view.behind, '{n} commit to pull', '{n} commits to pull')}>
              <ArrowDown className="size-3" strokeWidth={2} />
              {view.behind}
            </span>
          )}
          {view.unpublished && (
            <span aria-hidden className="inline-flex items-center gap-1">
              <CloudOff className="size-3" strokeWidth={1.75} />
              {t('not published')}
            </span>
          )}
          {view.dirty > 0 && (
            <span aria-hidden className="inline-flex items-center gap-1 tabular-nums" title={changesLabel(view)}>
              <span className="text-diff-added">+{view.added}</span>
              <span className="text-diff-removed">−{view.removed}</span>
            </span>
          )}
          {view.dirty === 0 && view.ahead === 0 && view.behind === 0 && !view.unpublished && !view.detached && (
            <span aria-hidden>{t('up to date')}</span>
          )}
          {pr && <PrChip pr={pr} />}
        </div>
      </div>
      {/* LAD-80: distanza da main, versione ridotta della mappa dei branch */}
      {session && <BranchMap projectId={projectId} currentSessionId={session.id} variant="compact" />}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Block title={t('Next step')}>
          <div className="flex items-center gap-1.5">
            {primary && (
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  aria-disabled={primaryBlocked || undefined}
                  aria-describedby={primaryBlocked && primaryReason ? reasonId : undefined}
                  onClick={() => !primaryBlocked && run(na.kind)}
                  className={primaryButton}
                >
                  <primary.Icon aria-hidden className="size-3.5" />
                  {t(primary.label)}
                </TooltipTrigger>
                {primaryBlocked && primaryReason && (
                  <TooltipContent side="bottom" className="max-w-xs">
                    {primaryReason}
                  </TooltipContent>
                )}
              </Tooltip>
            )}
            {needsGithub && (
              <button type="button" onClick={() => useApp.getState().focusConnection('github')} className={actionButton}>
                {t('Connect GitHub')}
              </button>
            )}
            {menu.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger aria-label={t('More actions')} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-accent aria-expanded:text-foreground">
                  <MoreHorizontal aria-hidden className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-48">
                  {menu.map((item) => (
                    <DropdownMenuItem key={item.key} disabled={item.why !== null} title={item.why ?? undefined} onClick={item.onSelect}>
                      <item.Icon aria-hidden />
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {primaryReason && (primaryBlocked || na.kind === 'none' || na.kind === 'create_pr') && (
            <p id={reasonId} className="flex items-start gap-1.5 text-sm text-muted-foreground">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{primaryReason}</span>
            </p>
          )}
          {showReady && (
            <p className="flex items-center gap-1.5 text-sm text-success">
              <Check aria-hidden className="size-3.5" />
              {t('Nothing blocks the merge.')}
            </p>
          )}
        </Block>

        {todos.length > 0 && (
          <Block title={t('To do')}>
            <ul className="flex flex-col gap-2">
              {todos.map((todo) => (
                <li key={todo.key} className="flex flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    {todo.tone === 'error' ? <CircleX aria-hidden className="size-3.5 shrink-0 text-destructive" /> : <CircleDashed aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className={cn('min-w-0 flex-1 break-words', todo.tone === 'muted' && 'text-muted-foreground')}>{todo.text}</span>
                    {todo.action && (
                      <button type="button" onClick={todo.action.onClick} className={cn(actionButton, 'shrink-0')}>
                        <todo.action.Icon aria-hidden className="size-3.5" />
                        {todo.action.label}
                      </button>
                    )}
                  </div>
                  {todo.files && todo.files.length > 0 && (
                    <ul className="ml-[22px] flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
                      {todo.files.slice(0, 8).map((file) => (
                        <li key={file} className="truncate">
                          {file}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </Block>
        )}

        <Block title={t('Commit')}>
          <div ref={commitRef}>
            <CommitBox projectId={projectId} session={session} dirty={info.dirty} />
          </div>
        </Block>

        {pr && (
          <Block title={t('Pull request')}>
            <div className="flex flex-col gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {pr.state === 'merged' ? <GitMerge aria-hidden className="size-4 shrink-0 text-success" /> : <GitPullRequest aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
                <button type="button" onClick={() => void window.ladder?.openExternal(pr.url)} className="min-w-0 truncate text-left text-sm font-medium outline-none hover:underline focus-visible:underline">
                  #{pr.number} {pr.title}
                </button>
                <ExternalLink aria-hidden className="size-3 shrink-0 text-faint" />
              </div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <Tag tone={pr.state === 'merged' ? 'success' : pr.state === 'closed' ? 'error' : undefined}>{t({ open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' }[pr.state])}</Tag>
                {pr.review && <Tag tone={pr.review === 'approved' ? 'success' : pr.review === 'changes' ? 'error' : undefined}>{t({ approved: 'approved', changes: 'changes requested', pending: 'review pending' }[pr.review])}</Tag>}
                {pr.mergeable === 'conflicts' && <Tag tone="error">{t('conflicts')}</Tag>}
                <span className="self-center text-faint">{updatedAgo(pr.updatedAt)}</span>
              </div>
            </div>
          </Block>
        )}

        {info.checks.length > 0 && (
          <Block title={t('CI')}>
            <Disclosure
              id="merge-ci"
              summary={checksSummary(info.checks)}
              icon={failing.length > 0 ? <CircleX aria-hidden className="size-3.5 text-destructive" /> : pending.length > 0 ? <CircleDashed aria-hidden className="size-3.5 text-muted-foreground" /> : <Check aria-hidden className="size-3.5 text-success" />}
            >
              <ul className="flex flex-col gap-1">
                {info.checks.map((check) => (
                  <li key={check.name} className="flex min-w-0 items-center gap-2 text-sm">
                    <CheckIcon state={check.state} />
                    {check.url ? (
                      <button type="button" onClick={() => void window.ladder?.openExternal(check.url!)} className="min-w-0 truncate text-left outline-none hover:underline focus-visible:underline">
                        {check.name}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate">{check.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            </Disclosure>
          </Block>
        )}

        {info.comments.length > 0 && (
          <Block title={t('Comments')}>
            <Disclosure
              id="merge-comments"
              summary={plural(info.comments.length, '{n} comment', '{n} comments')}
              icon={<MessageSquare aria-hidden className="size-3.5 text-muted-foreground" />}
              action={
                // Con "La review chiede modifiche" il pulsante sta già in "Da fare": qui non si ripete.
                hasBlock('changes_requested') ? null : (
                  <button type="button" onClick={askComments} className={actionButton}>
                    <MessageSquare aria-hidden className="size-3.5" />
                    {t('Send comments to agent…')}
                  </button>
                )
              }
            >
              <ul className="flex flex-col gap-2">
                {info.comments.slice(-12).map((comment, index) => (
                  <li key={`${comment.at}:${index}`} className="flex flex-col gap-0.5 text-sm">
                    <span className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{comment.author}</span>
                      {comment.path && (
                        <span className="font-mono">
                          {' '}
                          · {comment.path}
                          {comment.line ? `:${comment.line}` : ''}
                        </span>
                      )}
                      {comment.at ? ` · ${relativeAge(comment.at)}` : ''}
                    </span>
                    <span className="line-clamp-3 whitespace-pre-wrap">{comment.body}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          </Block>
        )}
      </div>

      {creatingPr && <CreatePrDialog projectId={projectId} session={session} branch={info.branch ?? ''} base={info.base ?? 'main'} onClose={() => setCreatingPr(false)} />}
      {dialog === 'push' && session && <PushDialog session={session} onClose={() => setDialog(null)} onDone={() => load(false)} />}
      {dialog === 'merge' && session && pr && <MergeDialog projectId={projectId} session={session} pr={pr} headOid={info.prHeadOid} base={info.base ?? pr.base} onClose={() => setDialog(null)} onDone={() => load(false)} />}
      {dialog === 'archive' && session && <ArchiveDialog session={session} onClose={() => setDialog(null)} />}
      <PromptDialog projectId={projectId} session={session} prompt={prompt} onClose={() => setPrompt(null)} />
    </div>
  )
}

/** "3 checks, 1 failed": conta i check e dice cosa non va. */
function checksSummary(checks: MergeCheck[]): string {
  const failing = checks.filter((c) => c.state === 'failing').length
  const pending = checks.filter((c) => c.state === 'pending').length
  const parts = [plural(checks.length, '{n} check', '{n} checks')]
  if (failing) parts.push(plural(failing, '{n} failed', '{n} failed'))
  if (pending) parts.push(plural(pending, '{n} running', '{n} running'))
  if (!failing && !pending) parts.push(t('all passed'))
  return parts.join(', ')
}

/** Chip della PR nella riga di stato: numero, stato in parole e CI con la sua forma (il colore non basta). */
function PrChip({ pr }: { pr: NonNullable<MergeInfo['pr']> }) {
  const live = pr.state === 'open' || pr.state === 'draft'
  const ci = live
    ? ({
        passing: { Icon: Check, text: t('CI passing'), className: 'text-success' },
        failing: { Icon: CircleX, text: t('CI failing'), className: 'text-destructive' },
        pending: { Icon: CircleDashed, text: t('CI running'), className: 'text-muted-foreground' },
        none: null
      } as const)[pr.checks]
    : null
  const state = t({ open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' }[pr.state])
  const label = `${t('Pull request')} #${pr.number}, ${state}${ci ? `, ${ci.text}` : ''}`
  return (
    <button
      type="button"
      onClick={() => void window.ladder?.openExternal(pr.url)}
      aria-label={label}
      title={`${label}: ${pr.title}`}
      className="inline-flex h-5 items-center gap-1 rounded-[5px] border border-input px-1.5 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {pr.state === 'merged' ? <GitMerge aria-hidden className="size-3 text-success" /> : <GitPullRequest aria-hidden className={cn('size-3', pr.state === 'draft' && 'text-faint')} />}
      <span aria-hidden className="tabular-nums">
        #{pr.number}
      </span>
      <span aria-hidden>{state}</span>
      {ci && (
        <span aria-hidden className={cn('inline-flex items-center gap-0.5', ci.className)}>
          <ci.Icon className="size-3" />
          {ci.text}
        </span>
      )}
    </button>
  )
}

/** Riepilogo in una riga che si apre sul dettaglio: il pulsante porta `aria-expanded` e `aria-controls`. */
function Disclosure({ id, summary, icon, action, children }: { id: string; summary: string; icon: ReactNode; action?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className="-mx-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight aria-hidden className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
          {icon}
          <span className="min-w-0 truncate">{summary}</span>
        </button>
        {action}
      </div>
      <div id={id} hidden={!open}>
        {open && children}
      </div>
    </div>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-b border-border px-3 py-3" aria-label={title}>
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function Tag({ tone, children }: { tone?: 'success' | 'error'; children: ReactNode }) {
  return (
    <span className={cn('rounded-[5px] border px-1.5 py-px', tone === 'success' ? 'border-success/50 text-success' : tone === 'error' ? 'border-destructive/50 text-destructive' : 'border-input text-muted-foreground')}>
      {children}
    </span>
  )
}
