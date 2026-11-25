// Local branches of the project and branch switching of the main checkout. Only `git switch` (never a file checkout) and, by explicit
// choice, `git stash push -u`. The protections (session at work, branch in a worktree, valid name) live here and in the caller,
// not in the UI. One operation at a time per repository (same lock as push and merge).
import { t } from '@shared/i18n'
import type { BranchSwitchResult, LocalBranch } from '@shared/protocol'
import { dirtyCount, gitRead, gitWrite, resolveCommit } from './git'
import { validBranchName, withRepoLock } from './git-push'

const LIST_TIMEOUT_MS = 10_000
/** Maximum local branches in the list: beyond that, the menu is no longer useful and search is in the terminal. */
const MAX_BRANCHES = 500

/** Branch checked out in the main checkout; null with a detached HEAD (or if git doesn't answer). */
export async function currentBranch(root: string): Promise<string | null> {
  try {
    return (await gitRead(root, ['symbolic-ref', '--short', '-q', 'HEAD'], LIST_TIMEOUT_MS)).trim() || null
  } catch {
    return null
  }
}

/** Branches checked out in the other worktrees: name → folder. The first block of `git worktree list` is the main checkout and is skipped. */
async function worktreeBranches(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let text: string
  try {
    text = await gitRead(root, ['worktree', 'list', '--porcelain'], LIST_TIMEOUT_MS)
  } catch {
    return out
  }
  for (const [index, block] of text.split(/\n\n+/).entries()) {
    if (index === 0) continue
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    const ref = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    if (path && ref) out.set(ref, path)
  }
  return out
}

/** Local branches, most recent commit first, with the current one and those already checked out in a worktree. */
export async function listLocalBranches(root: string): Promise<{ current: string | null; branches: LocalBranch[] }> {
  const [current, worktrees, text] = await Promise.all([
    currentBranch(root),
    worktreeBranches(root),
    // A git error here is a real error (unreadable repo, timeout), not "no branches".
    gitRead(root, ['for-each-ref', '--sort=-committerdate', `--count=${MAX_BRANCHES}`, '--format=%(refname)%1f%(committerdate:unix)%1f%(contents:subject)', 'refs/heads'], LIST_TIMEOUT_MS)
  ])
  const branches: LocalBranch[] = []
  for (const line of text.split('\n')) {
    const [ref, at, subject] = line.split('\x1f')
    if (!ref?.startsWith('refs/heads/')) continue
    const name = ref.slice('refs/heads/'.length)
    branches.push({ name, at: (Number(at) || 0) * 1000, subject: (subject ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200), current: name === current, worktree: worktrees.get(name) ?? null })
  }
  // The current branch must be there even if, because of the limit, it isn't among the most recent (or if the repo has no commits yet).
  if (current && !branches.some((b) => b.name === current)) branches.unshift({ name: current, at: 0, subject: '', current: true, worktree: null })
  return { current, branches }
}

/** The text of a git error for causes the user can fix; otherwise git's text as is. */
function switchFailure(message: string, branch: string, folder: string | null): string {
  if (/already (checked out|used by worktree)/i.test(message)) {
    return t('“{branch}” is already checked out in another worktree{folder}. Open that session, or remove the worktree, to use the branch here.', { branch, folder: folder ? ` (${folder})` : '' })
  }
  if (/would be overwritten|commit your changes or stash|local changes/i.test(message)) {
    return t('Git cannot carry your uncommitted changes onto “{branch}”: the same files differ there. Commit them or set them aside (stash), then switch.', { branch })
  }
  if (/cannot switch branch while|in the middle of|not possible because you have unmerged files|unresolved conflict/i.test(message)) {
    return t('Git is in the middle of another operation (rebase, merge or similar) in the project folder. Finish or abort it first.')
  }
  if (/invalid reference|not a valid|did not match any|unknown (branch|revision)/i.test(message)) {
    return t('The branch “{branch}” does not exist in this project.', { branch })
  }
  return message
}

interface SwitchOptions {
  /** What to do with uncommitted changes: bring them along (the normal switch) or set them aside with a stash. */
  dirty?: 'carry' | 'stash'
  /** Throws if a session is working in the main checkout: called before the lock and again inside, right before writing. */
  assertIdle: () => void
}

/** Name that can only be a branch: no control characters, spaces or wildcards, no `~ ^ :` (which would make it read as a revision) nor `..` or `@{`. */
function plainBranchName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith('-') && !/[\u0000-\u001f\u007f\s*?[\\~^:]/.test(name) && !name.includes('..') && !name.includes('@{')
}

/** Does the local branch exist? Git says so on the exact reference, not a limited list. */
async function branchExists(root: string, name: string): Promise<boolean> {
  return plainBranchName(name) && (await resolveCommit(root, `refs/heads/${name}`)) !== null
}

/** Switches the main checkout's branch. See `project.branch.switch` in the protocol for the rules. */
export async function switchBranch(root: string, branch: string, options: SwitchOptions): Promise<BranchSwitchResult> {
  options.assertIdle()
  // Names that aren't existing local branches don't reach git (and one starting with `-` would be an option).
  if (!(await branchExists(root, branch))) throw new Error(t('The branch “{branch}” does not exist in this project.', { branch }))
  return withRepoLock(root, async () => {
    options.assertIdle()
    if ((await currentBranch(root)) === branch) return { branch, stash: null }
    const folder = (await worktreeBranches(root)).get(branch)
    if (folder) throw new Error(switchFailure('already checked out', branch, folder))
    let stash: StashRef | null = null
    if (options.dirty === 'stash' && (await dirtyCount(root)) > 0) stash = await stashChanges(root, branch)
    try {
      await gitWrite(root, ['switch', '--no-guess', branch])
    } catch (error) {
      const reason = switchFailure((error as Error).message, branch, null)
      // The stash was made for this switch: if it didn't succeed, the changes go back where they were.
      if (stash) throw new Error(await restoreStash(root, stash, reason))
      throw new Error(reason)
    }
    return { branch, stash: stash?.message ?? null }
  })
}

/** Creates `name` from the current commit and checks it out (`git switch -c`): uncommitted changes are left untouched. */
export async function createBranch(root: string, name: string, options: Pick<SwitchOptions, 'assertIdle'>): Promise<BranchSwitchResult> {
  options.assertIdle()
  if (!validBranchName(name)) throw new Error(t('“{name}” is not a valid branch name: use letters, digits and . _ / @ + -, and no spaces.', { name }))
  return withRepoLock(root, async () => {
    options.assertIdle()
    if (await branchExists(root, name)) throw new Error(t('A branch named “{name}” already exists.', { name }))
    try {
      await gitWrite(root, ['switch', '-c', name])
    } catch (error) {
      throw new Error(switchFailure((error as Error).message, name, null))
    }
    return { branch: name, stash: null }
  })
}

/** A stash: the sha never changes, the position `stash@{n}` does (the stash belongs to the repository, shared with the worktrees). */
interface StashRef {
  sha: string
  message: string
}

/** The repository's stashes, most recent first. */
async function stashEntries(root: string): Promise<{ sha: string; subject: string }[]> {
  const out = await gitRead(root, ['stash', 'list', '--format=%H%x1f%gs'], LIST_TIMEOUT_MS).catch(() => '')
  return out
    .split('\n')
    .map((line) => line.split('\x1f'))
    .filter(([sha]) => /^[0-9a-f]{40,64}$/.test(sha ?? ''))
    .map(([sha, subject]) => ({ sha, subject: subject ?? '' }))
}

/** The stash created by `stash push` here: the new one (wasn't there before) that carries our message, even if another worktree created one in the meantime. */
async function newStash(root: string, before: Set<string>, message: string): Promise<StashRef | null> {
  const found = (await stashEntries(root)).find((e) => !before.has(e.sha) && e.subject.endsWith(message))
  return found ? { sha: found.sha, message } : null
}

async function stashChanges(root: string, branch: string): Promise<StashRef> {
  const message = `ladder: before switching to ${branch}`
  const before = new Set((await stashEntries(root)).map((e) => e.sha))
  try {
    await gitWrite(root, ['stash', 'push', '-u', '-m', message])
  } catch (error) {
    // The stash may have been created before the error (for example during file cleanup): in that case the changes are there.
    const created = await newStash(root, before, message)
    if (created) throw new Error(t('Git set the changes aside but then reported an error: {output} Your changes are in the stash {sha} (“{message}”). Restore them with git stash apply {sha}.', { output: (error as Error).message, sha: created.sha, message }))
    throw new Error(t('Could not set the changes aside: {output}', { output: (error as Error).message }))
  }
  const created = await newStash(root, before, message)
  // No new stash (git found only ignored or already clean files): nothing to restore.
  if (!created) throw new Error(t('Could not set the changes aside: git saved nothing.'))
  return created
}

/**
 * The switch failed after the stash: THAT stash is restored (by sha, never `stash pop`, which takes the top, maybe an agent's in a worktree):
 * `stash apply <sha>` and, only if it succeeds, `stash drop` of its current position. Returns the message to show (with the precise reference if it fails).
 */
async function restoreStash(root: string, stash: StashRef, reason: string): Promise<string> {
  const left = () => t('{reason} Your changes are in the stash {sha} (“{message}”). Restore them with git stash apply {sha}.', { reason, sha: stash.sha, message: stash.message })
  try {
    await gitWrite(root, ['stash', 'apply', stash.sha])
  } catch {
    return left()
  }
  // Applied: the stash is removed, but the position is reread now (another worktree may have added one) and must still have our sha.
  const index = (await stashEntries(root)).findIndex((e) => e.sha === stash.sha)
  if (index >= 0) await gitWrite(root, ['stash', 'drop', `stash@{${index}}`]).catch(() => undefined)
  return reason
}
