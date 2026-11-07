// Checkpoint di Blue: fotografa cartella di lavoro e file non tracciati in un commit
// su un ref privato, senza toccare l'indice, il working tree o i branch dell'utente.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Blue',
  GIT_AUTHOR_EMAIL: 'blue@localhost',
  GIT_COMMITTER_NAME: 'Blue',
  GIT_COMMITTER_EMAIL: 'blue@localhost'
}

export function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-C', repo, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  }).trimEnd()
}

export type IndexSeed = 'copy-index' | 'read-tree'

/**
 * Crea un checkpoint e restituisce l'id del commit.
 * seed `copy-index` parte da una copia dell'indice dell'utente, così git riusa le informazioni
 * di stat e rilegge solo i file cambiati; `read-tree` parte da HEAD e deve rileggere tutto.
 */
export function createCheckpoint(repo: string, ref: string, message: string, seed: IndexSeed = 'copy-index'): string {
  const dir = mkdtempSync(join(tmpdir(), 'blue-idx-'))
  const tmpIndex = join(dir, 'index')
  const env = { GIT_INDEX_FILE: tmpIndex, ...IDENTITY }
  try {
    const gitDir = git(repo, ['rev-parse', '--absolute-git-dir'])
    const userIndex = join(gitDir, 'index')
    if (seed === 'copy-index' && existsSync(userIndex)) copyFileSync(userIndex, tmpIndex)
    else git(repo, ['read-tree', 'HEAD'], env)
    git(repo, ['add', '-A'], env) // rispetta .gitignore: node_modules, build ecc. restano fuori
    const tree = git(repo, ['write-tree'], env)
    const parent = git(repo, ['rev-parse', '--verify', '-q', 'HEAD'])
    const commit = git(repo, ['commit-tree', tree, '-p', parent, '-m', message], env)
    git(repo, ['update-ref', ref, commit])
    return commit
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Diff tra due checkpoint (o tra un commit e un checkpoint). */
export function diffBetween(repo: string, from: string, to: string, stat = true): string {
  return git(repo, ['diff', stat ? '--stat' : '--patch', from, to])
}

/**
 * Riporta il working tree allo stato di un checkpoint senza toccare l'indice dell'utente.
 * Prima salva lo stato attuale in un checkpoint di sicurezza, così nulla va perso.
 */
export function restoreCheckpoint(repo: string, target: string, safetyRef: string): { safety: string; removed: string[] } {
  const safety = createCheckpoint(repo, safetyRef, `blue: prima del ripristino a ${target}`)
  const dir = mkdtempSync(join(tmpdir(), 'blue-idx-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    git(repo, ['read-tree', target], env)
    git(repo, ['checkout-index', '-a', '-f'], env)
    // File presenti adesso ma non nel checkpoint: vanno tolti per tornare allo stato esatto.
    const added = git(repo, ['diff', '--name-only', '--diff-filter=A', target, safety]).split('\n').filter(Boolean)
    for (const file of added) {
      const full = join(repo, file)
      if (existsSync(full)) unlinkSync(full)
    }
    return { safety, removed: added }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Elenca i checkpoint di una sessione. */
export function listCheckpoints(repo: string, prefix: string): string[] {
  const out = git(repo, ['for-each-ref', '--format=%(refname)', prefix])
  return out ? out.split('\n') : []
}

/** Elimina i checkpoint di una sessione (per esempio quando la archivi). */
export function deleteCheckpoints(repo: string, prefix: string): number {
  const refs = listCheckpoints(repo, prefix)
  for (const ref of refs) git(repo, ['update-ref', '-d', ref])
  return refs.length
}
