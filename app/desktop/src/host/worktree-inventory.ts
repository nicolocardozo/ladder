// Worktrees left on disk: the list `git worktree list --porcelain` gives for a project and the space each one takes.
// No path aliases: scripts/cli.test.mts imports it directly.
import { execFile } from 'node:child_process'
import { sep } from 'node:path'

export interface PorcelainWorktree {
  path: string
  /** Short branch name; null with a detached HEAD. */
  branch: string | null
  /** Git marks it prunable: its folder is gone. */
  prunable: boolean
}

/** Parses `git worktree list --porcelain`. The first entry is always the main checkout. */
export function parseWorktreeList(text: string): PorcelainWorktree[] {
  const out: PorcelainWorktree[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    if (!path) continue
    const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? null
    out.push({ path, branch: ref ? ref.replace(/^refs\/heads\//, '') : null, prunable: lines.some((l) => l === 'prunable' || l.startsWith('prunable ')) })
  }
  return out
}

/** `child` is `root` or inside it (compared as paths, so /a/bc is not inside /a/b). */
export function isInside(child: string, root: string): boolean {
  const base = root.endsWith(sep) ? root : root + sep
  return child === root || child.startsWith(base)
}

/** Bytes a folder takes on disk (`du -sk`), or null if it cannot be measured in time (very large folders, permissions). */
export function folderBytes(path: string, timeoutMs = 20_000): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('du', ['-sk', path], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (_error, stdout) => {
      const text = String(stdout).trim()
      const kb = Number(text.split(/\s+/)[0])
      // du exits with 1 when some subfolder is unreadable but still prints the total: keep it whenever it is a number.
      resolve(text && Number.isFinite(kb) ? kb * 1024 : null)
    })
  })
}
