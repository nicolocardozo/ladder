import { useEffect, useRef, useState } from 'react'
import { BranchSwitcherPanel } from '@/components/branch-switcher'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ArrowDown, ArrowUp, CloudOff, GitBranch, GitFork } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { changesLabel, describeGit, type GitStatusView } from '@/lib/git-status'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { plural, t } from '@shared/i18n'
import type { GitStatus } from '@shared/protocol'

/**
 * Subscribes the session to git updates while the header shows it; unsubscribes when it leaves.
 * Returns the state of its folder (null before the response, without a host or outside a repository).
 */
export function useGitStatus(sessionId: string | null): GitStatus | null {
  const watchGit = useApp((s) => s.watchGit)
  const unwatchGit = useApp((s) => s.unwatchGit)
  useEffect(() => {
    if (!sessionId) return
    watchGit(sessionId)
    return () => unwatchGit(sessionId)
  }, [sessionId, watchGit, unwatchGit])
  return useApp((s) => (sessionId ? (s.gitStatus[s.gitRoot[sessionId] ?? ''] ?? null) : null))
}

const zone =
  'no-drag inline-flex h-full min-w-0 cursor-pointer items-center gap-1.5 px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50'

/**
 * Git block of the bar: a bordered group with two clickable zones separated by a thin rule.
 * The branch (with ↑ ↓, worktree, crossed-out cloud) opens Merge, or, in the main checkout (`switcherProjectId`), the menu to switch branch (Merge is in the menu); the `+N −M` numbers open Changes and don't appear without changes.
 * The branch name is truncated, the numbers are not. Without `status` it shows only the name (before the host responds, or without a host).
 */
export function GitBlock({
  status,
  fallbackBranch,
  title,
  mergeActive,
  changesActive,
  flash,
  switcherProjectId,
  onOpenMerge,
  onOpenChanges
}: {
  status: GitStatus | null
  fallbackBranch: string | null
  title?: string
  mergeActive: boolean
  changesActive: boolean
  flash: boolean
  /** With a project, the branch is a menu to switch the main checkout's branch; without one (worktree session) it opens Merge. */
  switcherProjectId?: string | null
  onOpenMerge: () => void
  onOpenChanges: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const view = status ? describeGit(status) : null
  const name = view?.label ?? fallbackBranch
  if (!name) return null
  const aria = view ? view.aria : t('Branch {branch}', { branch: name })
  const showNumbers = view !== null && view.dirty > 0
  // Only changes without lines (binaries, empty files, renames, permissions): the zone stays and shows the files.
  const hasLines = view !== null && view.added + view.removed > 0
  const changes = showNumbers ? changesLabel(view) : ''
  const branchLabel = (
    <>
      <GitBranch aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className={cn('truncate', view?.detached && 'italic')}>{name}</span>
      {view && <GitMarks view={view} dot={view.dirty > 0 && !showNumbers} />}
    </>
  )
  const branchTip = (hint: string | null) => (
    <TooltipContent side="bottom" className="max-w-xs">
      {view ? (
        <div className="flex flex-col gap-0.5">
          {view.lines.map((line) => (
            <span key={line} className="break-words">{line}</span>
          ))}
          {hint && <span className="text-faint">{hint}</span>}
        </div>
      ) : (
        <span className="break-all">{title ?? name}</span>
      )}
    </TooltipContent>
  )
  return (
    <div role="group" aria-label={t('Git')} className={cn('mr-1 flex h-7 min-w-0 shrink items-stretch overflow-hidden rounded-md border border-border')}>
      {switcherProjectId ? (
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <Tooltip>
            <TooltipTrigger
              render={<PopoverTrigger aria-label={aria} />}
              className={cn(zone, 'max-w-[240px] shrink', menuOpen && 'bg-accent text-foreground')}
            >
              {branchLabel}
            </TooltipTrigger>
            {!menuOpen && branchTip(t('Click to change branch'))}
          </Tooltip>
          <PopoverContent align="start" className="w-80 gap-0 p-0">
            <BranchSwitcherPanel projectId={switcherProjectId} onDone={() => setMenuOpen(false)} onOpenMerge={onOpenMerge} />
          </PopoverContent>
        </Popover>
      ) : (
        <Tooltip>
          <TooltipTrigger aria-label={aria} aria-pressed={mergeActive} onClick={onOpenMerge} className={cn(zone, 'max-w-[240px] shrink', mergeActive && 'bg-accent text-foreground')}>
            {branchLabel}
          </TooltipTrigger>
          {branchTip(null)}
        </Tooltip>
      )}
      {showNumbers && (
        <Tooltip>
          <TooltipTrigger
            aria-label={changes}
            aria-pressed={changesActive}
            onClick={onOpenChanges}
            className={cn(zone, 'shrink-0 gap-1 border-l border-border tabular-nums', changesActive && 'bg-accent text-foreground', flash && 'git-pill-flash')}
          >
            {hasLines ? (
              <>
                <span aria-hidden className="text-diff-added">+{view.added}</span>
                <span aria-hidden className="text-diff-removed">−{view.removed}</span>
              </>
            ) : (
              <span aria-hidden>{plural(view.dirty, '{n} file', '{n} files')}</span>
            )}
          </TooltipTrigger>
          <TooltipContent side="bottom">{changes}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/** Marks inside the chip: only shapes and numbers, color alone carries no information. */
function GitMarks({ view, dot }: { view: GitStatusView; dot: boolean }) {
  const marks = view.worktree || view.ahead > 0 || view.behind > 0 || view.unpublished || dot
  if (!marks) return null
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-1.5 tabular-nums animate-in fade-in-0 duration-150 motion-reduce:animate-none">
      {view.worktree && <GitFork className="size-3 text-faint" strokeWidth={1.75} />}
      {view.ahead > 0 && (
        <span className="inline-flex items-center">
          <ArrowUp className="size-3" strokeWidth={2} />
          {view.ahead}
        </span>
      )}
      {view.behind > 0 && (
        <span className="inline-flex items-center">
          <ArrowDown className="size-3" strokeWidth={2} />
          {view.behind}
        </span>
      )}
      {view.unpublished && <CloudOff className="size-3" strokeWidth={1.75} />}
      {dot && <span className="size-1.5 rounded-full bg-attention" />}
    </span>
  )
}

/** True for a moment when the modified files go from 0 to more than 0 (after the first state read). */
export function useFirstChangeFlash(status: GitStatus | null): boolean {
  const prev = useRef<number | null>(null)
  const [flash, setFlash] = useState(false)
  const dirty = status?.dirty ?? null
  useEffect(() => {
    if (dirty === null) return
    if (prev.current === 0 && dirty > 0) {
      setFlash(true)
      const id = window.setTimeout(() => setFlash(false), 900)
      prev.current = dirty
      return () => window.clearTimeout(id)
    }
    prev.current = dirty
  }, [dirty])
  return flash
}
