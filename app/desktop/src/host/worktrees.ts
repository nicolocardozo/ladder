// Worktree delle sessioni e porte per cartella di lavoro.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { t } from '@shared/i18n'
import type { Project, WorktreeInfo } from '@shared/protocol'
import type { Db } from './db'
import { addWorktree, addWorktreeForBranch, fetchRef, resolveCommit } from './git'
import { insideRoot } from './files'

/** ~/Developer/.ladder/worktrees se esiste ~/Developer (come nel piano), altrimenti ~/.ladder/worktrees. LADDER_WORKTREES per le prove. */
export function worktreesRoot(): string {
  if (process.env.LADDER_WORKTREES) return process.env.LADDER_WORKTREES
  const developer = join(homedir(), 'Developer')
  return existsSync(developer) ? join(developer, '.ladder', 'worktrees') : join(homedir(), '.ladder', 'worktrees')
}

export function slugify(text: string): string {
  const base = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-')
  return `${base || t('session')}-${randomBytes(2).toString('hex')}`
}

export interface WorktreeBranch {
  name: string
  /** Vero: il branch esiste già (in locale, su origin o come PR) e si estrae. Falso: nuovo branch da HEAD. */
  existing: boolean
  pr?: number
}

/**
 * Crea un worktree e copia i file non tracciati indicati. Senza `wanted` il branch è `ladder/<slug>` dal commit attuale;
 * con un branch esistente (una PR, un branch scelto) il worktree lo estrae, dopo averlo letto da origin.
 */
export async function createWorktree(
  project: Project,
  title: string,
  copy: string[],
  wanted?: WorktreeBranch | null
): Promise<{ info: WorktreeInfo; copied: string[]; missing: string[] }> {
  const head = await resolveCommit(project.path, 'HEAD')
  if (!head) throw new Error(t('The project has no commits yet: a worktree starts from a commit.'))
  const slug = slugify(wanted?.name.replace(/^ladder\//, '') ?? title)
  const path = join(worktreesRoot(), project.name, slug)
  let branch = wanted?.name ?? `ladder/${slug}`
  // Un branch "nuovo" che esiste già (una seconda sessione sulla stessa issue) si estrae invece di ricrearlo.
  const existing = wanted?.existing || (wanted ? Boolean(await resolveCommit(project.path, `refs/heads/${wanted.name}`)) : false)
  if (wanted && existing) {
    // Il branch aggiornato da origin; se la PR viene da un fork, il suo ref pull/N/head in un branch locale.
    await fetchRef(project.path, wanted.name).catch(() => undefined)
    try {
      await addWorktreeForBranch(project.path, path, wanted.name)
    } catch (error) {
      if (!wanted.pr) throw error
      branch = `ladder/pr-${wanted.pr}`
      await fetchRef(project.path, `pull/${wanted.pr}/head:${branch}`)
      await addWorktreeForBranch(project.path, path, branch)
    }
  } else {
    await addWorktree(project.path, path, branch, head)
  }
  const base = (await resolveCommit(path, 'HEAD')) ?? head
  const copied: string[] = []
  const missing: string[] = []
  for (const rel of copy) {
    try {
      const from = insideRoot(project.path, rel)
      if (!existsSync(from)) {
        missing.push(rel)
        continue
      }
      await cp(from, insideRoot(path, rel), { recursive: true, force: false, errorOnExist: false })
      copied.push(rel)
    } catch {
      missing.push(rel)
    }
  }
  return { info: { path, branch, base }, copied, missing }
}

const PORT_BASE = 4100
const PORT_BLOCK = 100

/**
 * Un blocco di porte per cartella di lavoro: LADDER_PORT è il primo. Il checkout principale ha 4100,
 * ogni worktree il blocco successivo libero, così due dev server girano insieme.
 */
export class Ports {
  constructor(private readonly db: Db) {}

  private load(): Record<string, number> {
    const row = this.db.prepare(`select value from kv where key = 'ports'`).get() as { value: string } | undefined
    return row ? (JSON.parse(row.value) as Record<string, number>) : {}
  }

  allocate(cwd: string): number {
    const slots = this.load()
    if (slots[cwd] === undefined) {
      const used = new Set(Object.values(slots))
      let slot = 0
      while (used.has(slot)) slot++
      slots[cwd] = slot
      this.db
        .prepare(`insert into kv (key, value) values ('ports', ?) on conflict(key) do update set value = excluded.value`)
        .run(JSON.stringify(slots))
    }
    return PORT_BASE + slots[cwd] * PORT_BLOCK
  }
}
