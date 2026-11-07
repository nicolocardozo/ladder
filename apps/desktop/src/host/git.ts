// Git per l'host: informazioni sul repo e checkpoint con indice temporaneo (vedi spikes/git-checkpoint).
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { FileChange } from '@shared/protocol'

const run = promisify(execFile)

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ladder',
  GIT_AUTHOR_EMAIL: 'ladder@localhost',
  GIT_COMMITTER_NAME: 'Ladder',
  GIT_COMMITTER_EMAIL: 'ladder@localhost'
}

export async function git(repo: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, ...args], {
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024
  })
  return stdout.trimEnd()
}

export interface RepoInfo {
  isGit: boolean
  branch: string | null
  hasHead: boolean
}

export async function repoInfo(path: string): Promise<RepoInfo> {
  try {
    const inside = await git(path, ['rev-parse', '--is-inside-work-tree'])
    if (inside !== 'true') return { isGit: false, branch: null, hasHead: false }
  } catch {
    return { isGit: false, branch: null, hasHead: false }
  }
  let branch: string | null = null
  try {
    branch = (await git(path, ['symbolic-ref', '--short', '-q', 'HEAD'])) || null
  } catch {
    branch = null
  }
  let hasHead = true
  try {
    await git(path, ['rev-parse', '--verify', '-q', 'HEAD'])
  } catch {
    hasHead = false
  }
  return { isGit: true, branch, hasHead }
}

/** File del progetto: tracciati più non tracciati non ignorati, al massimo `limit`. */
export async function listFiles(path: string, limit = 20000): Promise<string[]> {
  const out = await git(path, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  const files = out.split('\0').filter(Boolean)
  return [...new Set(files)].slice(0, limit)
}

/** Fotografa working tree e file non tracciati in un commit su `ref`, senza toccare indice e branch. */
export async function createCheckpoint(repo: string, ref: string, message: string): Promise<string | null> {
  const info = await repoInfo(repo)
  if (!info.isGit || !info.hasHead) return null
  const dir = await mkdtemp(join(tmpdir(), 'ladder-idx-'))
  const tmpIndex = join(dir, 'index')
  const env = { GIT_INDEX_FILE: tmpIndex, ...IDENTITY }
  try {
    const gitDir = await git(repo, ['rev-parse', '--absolute-git-dir'])
    const userIndex = join(gitDir, 'index')
    if (existsSync(userIndex)) await copyFile(userIndex, tmpIndex)
    else await git(repo, ['read-tree', 'HEAD'], env)
    await git(repo, ['add', '-A'], env)
    const tree = await git(repo, ['write-tree'], env)
    const parent = await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'])
    const commit = await git(repo, ['commit-tree', tree, '-p', parent, '-m', message], env)
    await git(repo, ['update-ref', ref, commit])
    return commit
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** File cambiati tra due checkpoint, con righe aggiunte e tolte. */
export async function changedFiles(repo: string, from: string, to: string): Promise<FileChange[]> {
  const [numstat, nameStatus] = await Promise.all([
    git(repo, ['diff', '--numstat', '-M', from, to]),
    git(repo, ['diff', '--name-status', '-M', from, to])
  ])
  const statusByPath = new Map<string, FileChange['status']>()
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const parts = line.split('\t')
    const code = parts[0][0] as FileChange['status']
    statusByPath.set(parts[parts.length - 1], code === 'A' || code === 'D' || code === 'R' ? code : 'M')
  }
  return numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split('\t')
      // Con -M i file rinominati appaiono come "vecchio => nuovo" o "dir/{a => b}".
      const raw = rest.join('\t')
      const path = raw.includes(' => ') ? raw.replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/^.* => /, '') : raw
      return {
        path,
        added: added === '-' ? 0 : Number(added),
        removed: removed === '-' ? 0 : Number(removed),
        status: statusByPath.get(path) ?? 'M'
      }
    })
}
