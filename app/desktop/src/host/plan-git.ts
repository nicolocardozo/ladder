// Git for executable plans: brings into the plan folder the changes of a task that worked in a separate worktree.
// No path aliases and no translation: scripts/plan-runner.test.mts tests it on a real repository.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface Exec {
  code: number
  stdout: string
  stderr: string
}

/** git without processing the output (the host's git() trims trailing whitespace: a patch would lose it). Never throws because of the exit code. */
export function rawGit(repo: string, args: string[]): Promise<Exec> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(ANTHROPIC_|CLAUDE|ELECTRON_|LADDER_|GIT_)/.test(key)) env[key] = value
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, '--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], { env, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr })
      const code = (error as { code?: unknown }).code
      if (typeof code === 'number') return resolve({ code, stdout, stderr })
      reject(error)
    })
  })
}

export type ApplyResult = { ok: true } | { ok: false; conflicts: string[]; detail: string }

/**
 * Brings into the `workspace` folder the changes made in the separate worktree between `base` (the checkpoint it started from) and `end`
 * (its final state). `current` is a checkpoint of the folder right now: a snapshot of it, and the final patch starts from there,
 * so it applies without touching the index and without requiring the files to be in git already. The three-way merge is done by
 * `git merge-tree`: a conflict leaves the folder as it is. With a git version without `--write-tree` it falls back to a plain `git apply`.
 */
export async function applySideChanges(workspace: string, current: string, base: string, end: string): Promise<ApplyResult> {
  const merged = await rawGit(workspace, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${base}`, current, end])
  if (merged.code === 0) {
    const tree = merged.stdout.split('\n')[0]?.trim() ?? ''
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return { ok: false, conflicts: [], detail: merged.stderr.trim() || merged.stdout.trim() }
    const patch = await rawGit(workspace, ['diff', '--binary', '--no-ext-diff', current, tree])
    if (patch.code !== 0) return { ok: false, conflicts: [], detail: patch.stderr.trim() }
    if (!patch.stdout) return { ok: true }
    return apply(workspace, patch.stdout, ['apply', '--whitespace=nowarn'])
  }
  if (merged.code === 1) {
    // Conflict: after the tree (first line) and an empty line, the conflicting files, one per line.
    const [, ...rest] = merged.stdout.split('\n')
    const conflicts = [...new Set(rest.map((l) => l.trim()).filter((l) => l && !/^[0-9a-f]{40,64}$/.test(l)))]
    return { ok: false, conflicts, detail: merged.stderr.trim() }
  }
  if (merged.code !== 129) return { ok: false, conflicts: [], detail: merged.stderr.trim() || merged.stdout.trim() }
  // Git too old for `merge-tree --write-tree` (129: unknown option): patch from the separate worktree and a plain `git apply`,
  // after a `--check` that writes nothing. No `--3way` (it implies the index and can leave markers): if it does not apply, it is a conflict.
  const patch = await rawGit(workspace, ['diff', '--binary', '--no-ext-diff', base, end])
  if (patch.code !== 0) return { ok: false, conflicts: [], detail: patch.stderr.trim() }
  if (!patch.stdout) return { ok: true }
  return apply(workspace, patch.stdout, ['apply', '--whitespace=nowarn'])
}

async function apply(workspace: string, patch: string, args: string[]): Promise<ApplyResult> {
  const dir = await mkdtemp(join(tmpdir(), 'ladder-plan-'))
  try {
    const file = join(dir, 'changes.patch')
    await writeFile(file, patch)
    // Dry run first: `git apply` without `--check` can leave conflict markers (with --3way) and index entries.
    const check = await rawGit(workspace, [...args, '--check', file])
    const out = check.code === 0 ? await rawGit(workspace, [...args, file]) : check
    if (out.code === 0) return { ok: true }
    const conflicts = [...out.stderr.matchAll(/^(?:error: )?(?:patch failed: |Applied patch to '|CONFLICT[^:]*: )?'?([^':\n]+?)'? (?:with conflicts|cleanly)/gm)].map((m) => m[1])
    return { ok: false, conflicts: [...new Set(conflicts)], detail: out.stderr.trim() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
