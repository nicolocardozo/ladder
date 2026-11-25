// Presentation of a folder's git status: same source for the header chip and, later, for the merge panel.
import type { GitStatus } from '@shared/protocol'
import { plural, t } from '@shared/i18n'

export interface GitStatusView {
  /** Name to show in the chip: the branch, or "detached" with a detached HEAD. */
  label: string
  /** Full name for the tooltip (the branch, or the explanation of the detached state). */
  fullName: string
  detached: boolean
  ahead: number
  behind: number
  /** Branch without upstream: commits are not counted, but it is not published. */
  unpublished: boolean
  dirty: number
  added: number
  removed: number
  worktree: boolean
  /** One line for each thing to know, for the tooltip. */
  lines: string[]
  /** Complete sentence for screen readers. */
  aria: string
}

/** Describes the state; `fallbackBranch` is used before the state arrives from the host (or without a host). */
export function describeGit(status: GitStatus): GitStatusView {
  const detached = status.branch === null
  const unpublished = !detached && !status.hasUpstream
  const upstream = status.upstream ?? ''
  const ahead = status.hasUpstream ? status.ahead : 0
  const behind = status.hasUpstream ? status.behind : 0
  const lines: string[] = []
  const parts: string[] = []
  const push = (line: string, part = line) => {
    lines.push(line)
    parts.push(part)
  }
  const fullName = detached ? t('HEAD detached, not on a branch') : status.branch!
  lines.push(detached ? fullName : t('Branch {branch}', { branch: fullName }))
  parts.push(detached ? fullName : t('Branch {branch}', { branch: fullName }))
  if (status.isWorktree) push(t('Worktree of this session'), t('worktree'))
  if (ahead > 0) push(plural(ahead, '{n} commit to push to {upstream}', '{n} commits to push to {upstream}', { upstream }), plural(ahead, '{n} commit to push', '{n} commits to push'))
  if (behind > 0) push(plural(behind, '{n} commit to pull from {upstream}', '{n} commits to pull from {upstream}', { upstream }), plural(behind, '{n} commit to pull', '{n} commits to pull'))
  if (unpublished) push(t('Not published: this branch has no upstream yet'), t('not published'))
  if (status.hasUpstream && ahead === 0 && behind === 0) push(t('Up to date with {upstream}', { upstream }), t('up to date'))
  if (status.dirty > 0) push(plural(status.dirty, '{n} file with uncommitted changes', '{n} files with uncommitted changes'), plural(status.dirty, '{n} file changed', '{n} files changed'))
  return {
    label: detached ? t('detached') : status.branch!,
    fullName,
    detached,
    ahead,
    behind,
    unpublished,
    dirty: status.dirty,
    added: status.added,
    removed: status.removed,
    worktree: status.isWorktree,
    lines,
    aria: parts.join(', ')
  }
}

/** Label of the changes pill: screen readers and tooltip. */
export function changesLabel(view: Pick<GitStatusView, 'dirty' | 'added' | 'removed'>): string {
  const files = plural(view.dirty, '{n} file changed', '{n} files changed')
  // Without lines (binaries, empty files, renames, permissions) only the files.
  return view.added + view.removed > 0 ? `${files}, ${t('{added} lines added, {removed} removed', { added: view.added, removed: view.removed })}` : files
}
