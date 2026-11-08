// "Pronto per il merge" (⌘⌥4): stato git del branch, PR, CI, commenti di review e cose ancora da fare.
// I pulsanti mandano all'agente un prompt modificabile; Ladder non fa push né merge da solo.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleDashed, CircleX, ExternalLink, GitBranch, GitMerge, GitPullRequest, MessageSquare, Minus, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { MergeCheck, MergeInfo, SessionSummary } from '@shared/protocol'
import { PromptDialog, type PromptRequest } from '@/components/prompt-dialog'
import { request } from '@/lib/host-client'
import { relativeAge } from '@/lib/session-state'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { plural, t } from '@shared/i18n'
import { PanelNote } from './changes-panel'

/** "updated 5 min ago", ma "updated just now" e "updated yesterday" dove "ago" non regge. */
function updatedAgo(at: number): string {
  const minutes = (Date.now() - at) / 60000
  if (minutes < 1) return t('updated just now')
  const age = relativeAge(at)
  return age === t('yesterday') ? t('updated yesterday') : t('updated {age} ago', { age })
}

interface Todo {
  text: string
  tone: 'attention' | 'error' | 'muted'
}

/** Cosa manca prima del merge, in ordine: commit, pubblicazione, PR, conflitti, CI, review. */
function todos(info: MergeInfo): Todo[] {
  const list: Todo[] = []
  if (info.isDefaultBranch) return [{ text: t('You’re on {branch}. A PR needs a branch, for example from a worktree.', { branch: info.branch ?? 'HEAD' }), tone: 'muted' }]
  if (info.dirty > 0) list.push({ text: plural(info.dirty, 'Commit {n} changed file', 'Commit {n} changed files'), tone: 'attention' })
  if (!info.hasUpstream && info.ahead > 0) list.push({ text: t('Publish the branch to origin'), tone: 'attention' })
  else if (info.unpushed) list.push({ text: plural(info.unpushed, 'Push {n} commit', 'Push {n} commits'), tone: 'attention' })
  if (info.gh === 'ok' && !info.pr && info.ahead > 0) list.push({ text: t('Open the PR'), tone: 'attention' })
  if (info.conflicts.length)
    list.push({ text: plural(info.conflicts.length, 'Resolve conflicts with {base} in {n} file', 'Resolve conflicts with {base} in {n} files', { base: info.base ?? '' }), tone: 'error' })
  else if (info.pr?.mergeable === 'conflicts') list.push({ text: t('Resolve conflicts with {base}', { base: info.base ?? '' }), tone: 'error' })
  const failing = info.checks.filter((c) => c.state === 'failing').length
  if (failing) list.push({ text: plural(failing, 'Fix {n} failing check', 'Fix {n} failing checks'), tone: 'error' })
  const pending = info.checks.filter((c) => c.state === 'pending').length
  if (pending) list.push({ text: plural(pending, 'Wait for {n} running check', 'Wait for {n} running checks'), tone: 'muted' })
  if (info.pr?.review === 'changes') list.push({ text: t('The review requests changes'), tone: 'error' })
  else if (info.pr?.review === 'pending') list.push({ text: t('Needs a review'), tone: 'muted' })
  return list
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
  'inline-flex h-7 items-center whitespace-nowrap gap-1.5 rounded-md bg-primary px-2.5 text-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50'

export function MergePanel({ projectId, root, isGit, session }: { projectId: string; root: string; isGit: boolean; session: SessionSummary | null }) {
  const [info, setInfo] = useState<MergeInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const version = useApp((s) => s.fsVersion[root] ?? 0)
  const prKey = session?.pr ? `${session.pr.number}:${session.pr.state}:${session.pr.checks}:${session.pr.mergeable}` : ''
  const latest = useRef(0)

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
  }, [isGit, load, version, prKey])

  if (!isGit) return <PanelNote>{t('This project isn’t a git repository.')}</PanelNote>
  if (error && !info) return <PanelNote tone="error">{error}</PanelNote>
  if (!info) return <PanelNote>{t('Reading branch status…')}</PanelNote>

  const list = todos(info)
  const ready = !info.isDefaultBranch && info.pr?.state === 'open' && list.filter((todo) => todo.tone !== 'muted').length === 0 && info.pr.review !== 'pending'
  const failing = info.checks.filter((c) => c.state === 'failing')
  const prRef = info.pr ? `#${info.pr.number}` : ''
  const ask = (name: string, title: string, vars: Record<string, string>) => setPrompt({ name, title, vars })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-sm">
        <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-xs">{info.branch ?? t('Detached HEAD')}</span>
        {!info.isDefaultBranch && info.base && (
          <span className="shrink-0 text-muted-foreground">
            → <span className="font-mono text-xs">{info.base}</span>
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Block title={ready ? t('Ready to merge') : t('To do')}>
          {ready ? (
            <p className="flex items-center gap-2 text-sm text-success">
              <Check aria-hidden className="size-3.5" />
              {t('PR open, checks passing, no conflicts.')}
            </p>
          ) : list.length === 0 ? (
            <p className="text-sm text-muted-foreground">{info.ahead === 0 ? t('No commits ahead of {base}.', { base: info.base ?? '' }) : t('Nothing to report.')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {list.map((todo) => (
                <li key={todo.text} className="flex items-start gap-2 text-sm">
                  <span aria-hidden className={cn('mt-[6px] size-1.5 shrink-0 rounded-full', todo.tone === 'error' ? 'bg-destructive' : todo.tone === 'attention' ? 'bg-attention' : 'bg-muted-foreground/60')} />
                  <span className={cn(todo.tone === 'muted' && 'text-muted-foreground')}>{todo.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block title={t('Branch')}>
          <Row label={t('Changes')} value={info.dirty ? t('{n} uncommitted', { n: info.dirty }) : t('all committed')} tone={info.dirty ? 'attention' : undefined} />
          {!info.isDefaultBranch && <Row label={t('Compared to {base}', { base: info.base ?? '' })} value={t('{ahead} ahead · {behind} behind', { ahead: info.ahead, behind: info.behind })} />}
          <Row
            label={t('Origin')}
            value={info.hasUpstream ? (info.unpushed ? t('{n} to push', { n: info.unpushed }) : t('published')) : t('not published')}
            tone={info.hasUpstream && !info.unpushed ? undefined : 'attention'}
          />
          {info.conflicts.length > 0 ? (
            <div className="flex flex-col gap-1">
              <Row label={t('Conflicts')} value={plural(info.conflicts.length, '{n} file with {base}', '{n} files with {base}', { base: info.base ?? '' })} tone="error" />
              <ul className="ml-[104px] flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
                {info.conflicts.slice(0, 8).map((file) => (
                  <li key={file} className="truncate">
                    {file}
                  </li>
                ))}
              </ul>
              <div className="ml-[104px]">
                <button
                  type="button"
                  onClick={() => ask('conflicts', t('Resolve conflicts'), { branch: info.branch ?? '', base: info.base ?? 'main', conflicts: info.conflicts.map((f) => `- ${f}`).join('\n') })}
                  className={actionButton}
                >
                  {t('Resolve conflicts…')}
                </button>
              </div>
            </div>
          ) : (
            !info.isDefaultBranch && info.behind > 0 && <Row label={t('Conflicts')} value={t('none with {base}', { base: info.base ?? '' })} />
          )}
        </Block>

        <Block title={t('Pull request')}>
          {info.gh !== 'ok' ? (
            <p className="text-sm text-muted-foreground">
              {info.gh === 'missing'
                ? t('PRs and CI need the gh CLI: brew install gh, then gh auth login.')
                : info.gh === 'unauthenticated'
                  ? t('gh isn’t signed in. Run gh auth login in the terminal.')
                  : info.gh === 'no-remote'
                    ? t('The repository has no GitHub remote.')
                    : t('gh isn’t responding: {error}', { error: info.ghError ?? '' })}
            </p>
          ) : info.pr ? (
            <div className="flex flex-col gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {info.pr.state === 'merged' ? <GitMerge aria-hidden className="size-4 shrink-0 text-success" /> : <GitPullRequest aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
                <button type="button" onClick={() => void window.ladder?.openExternal(info.pr!.url)} className="min-w-0 truncate text-left text-sm font-medium outline-none hover:underline focus-visible:underline">
                  #{info.pr.number} {info.pr.title}
                </button>
                <ExternalLink aria-hidden className="size-3 shrink-0 text-faint" />
              </div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <Tag tone={info.pr.state === 'merged' ? 'success' : info.pr.state === 'closed' ? 'error' : undefined}>
                  {t({ open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' }[info.pr.state])}
                </Tag>
                {info.pr.review && <Tag tone={info.pr.review === 'approved' ? 'success' : info.pr.review === 'changes' ? 'error' : undefined}>{t({ approved: 'approved', changes: 'changes requested', pending: 'review pending' }[info.pr.review])}</Tag>}
                {info.pr.mergeable === 'conflicts' && <Tag tone="error">{t('conflicts')}</Tag>}
                <span className="self-center text-faint">{updatedAgo(info.pr.updatedAt)}</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted-foreground">{info.isDefaultBranch ? t('No PR from the default branch.') : t('This branch doesn’t have a PR yet.')}</p>
              {!info.isDefaultBranch && (
                <button
                  type="button"
                  onClick={() =>
                    ask('create_pr', t('Create pull request'), {
                      branch: info.branch ?? '',
                      base: info.base ?? 'main',
                      source: session?.source?.url ? t('In the description, link {ref}: {url}', { ref: session.source.ref, url: session.source.url }) : ''
                    })
                  }
                  className={primaryButton}
                >
                  <GitPullRequest aria-hidden className="size-3.5" />
                  {t('Create PR…')}
                </button>
              )}
            </div>
          )}
        </Block>

        {info.checks.length > 0 && (
          <Block title={`CI · ${info.checks.length}`}>
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
            {failing.length > 0 && (
              <button
                type="button"
                onClick={() => ask('fix', t('Fix CI'), { pr: prRef, checks: failing.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`).join('\n') })}
                className={cn(actionButton, 'mt-2 self-start')}
              >
                <TriangleAlert aria-hidden className="size-3.5 text-destructive" />
                {t('Fix CI…')}
              </button>
            )}
          </Block>
        )}

        {info.comments.length > 0 && (
          <Block title={t('Comments · {n}', { n: info.comments.length })}>
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
            <button
              type="button"
              onClick={() =>
                ask('comments', t('Reply to comments'), {
                  pr: prRef,
                  comments: info.comments
                    .map((c) => `- ${c.author}${c.path ? ` ${t('on {path}', { path: `${c.path}${c.line ? `:${c.line}` : ''}` })}` : ''}: ${c.body.replace(/\s+/g, ' ').trim()}`)
                    .join('\n')
                })
              }
              className={cn(actionButton, 'mt-2 self-start')}
            >
              <MessageSquare aria-hidden className="size-3.5" />
              {t('Send comments to agent…')}
            </button>
          </Block>
        )}
      </div>

      <PromptDialog projectId={projectId} session={session} prompt={prompt} onClose={() => setPrompt(null)} />
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

function Row({ label, value, tone }: { label: string; value: string; tone?: 'attention' | 'error' }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-sm">
      <span className="w-[96px] shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate', tone === 'attention' && 'font-medium text-attention', tone === 'error' && 'font-medium text-destructive')}>{value}</span>
    </div>
  )
}

function Tag({ tone, children }: { tone?: 'success' | 'error'; children: ReactNode }) {
  return (
    <span className={cn('rounded-[5px] border px-1.5 py-px', tone === 'success' ? 'border-success/50 text-success' : tone === 'error' ? 'border-destructive/50 text-destructive' : 'border-input text-muted-foreground')}>
      {children}
    </span>
  )
}
