// Worktree delle sessioni e porte per cartella di lavoro.
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { cp, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { t } from '@shared/i18n'
import type { Project, WorktreeFiles, WorktreeInfo } from '@shared/protocol'
import { DEFAULT_BRANCH_PREFIX } from '@shared/worktree-prefs'
import type { Db } from './db'
import { cleanEnv, shellPath } from './agents/common'
import { addWorktree, addWorktreeForBranch, fetchRef, gitFailure, gitRemoveWorktree, ignoredAmong, matchingUntracked, resolveCommit } from './git'
import { insideRoot } from './files'
import { loadProjectSettings } from './project-settings'

/** La cartella scelta nelle preferenze, altrimenti ~/Developer/.ladder/worktrees se esiste ~/Developer (come nel piano), altrimenti ~/.ladder/worktrees. LADDER_WORKTREES per le prove vince su tutto. */
export function worktreesRoot(custom?: string | null): string {
  if (process.env.LADDER_WORKTREES) return process.env.LADDER_WORKTREES
  if (custom) return custom
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

/** Preferenze dei worktree (AppPrefs.worktreesDir e branchPrefix). */
export interface WorktreeOptions {
  dir?: string | null
  branchPrefix?: string
}

const INCLUDE_FILE = '.worktreeinclude'
const DEFAULT_INCLUDE = ['.env*']

/**
 * I file ignorati da copiare in un worktree nuovo (LAD-58): quelli che `.worktreeinclude` (sintassi .gitignore) indica
 * e che git ignora; senza il file, `.env*`. Si usa il motore di git per i pattern, quindi `!`, `**` e le cartelle
 * funzionano come in .gitignore. Non si entra in `node_modules`.
 */
export async function worktreeIncludeFiles(root: string): Promise<WorktreeFiles> {
  const file = join(root, INCLUDE_FILE)
  const raw = existsSync(file) ? await readFile(file, 'utf8').catch(() => null) : null
  const patterns = raw === null ? DEFAULT_INCLUDE : raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const source = raw === null ? 'default' : 'file'
  if (patterns.length === 0) return { source, patterns, files: [] }
  const candidates = await matchingUntracked(root, raw === null ? ['--exclude=.env*'] : [`--exclude-from=${file}`]).catch(() => [])
  const files = (await ignoredAmong(root, candidates.filter((p) => !p.split('/').includes('node_modules')))).sort()
  return { source, patterns, files }
}

/**
 * Crea un worktree e copia i file non tracciati: quelli di `copy` (percorsi espliciti) e quelli di `.worktreeinclude`.
 * Senza `wanted` il branch è `<prefisso><slug>` (predefinito `ladder/`) dal commit attuale;
 * con un branch esistente (una PR, un branch scelto) il worktree lo estrae, dopo averlo letto da origin.
 * La copia non sovrascrive; i symlink restano symlink e si saltano se puntano fuori dal progetto.
 */
export async function createWorktree(
  project: Project,
  title: string,
  copy: string[],
  wanted?: WorktreeBranch | null,
  options: WorktreeOptions = {}
): Promise<{ info: WorktreeInfo; copied: string[]; missing: string[] }> {
  const head = await resolveCommit(project.path, 'HEAD')
  if (!head) throw new Error(t('The project has no commits yet: a worktree starts from a commit.'))
  const prefix = options.branchPrefix ?? DEFAULT_BRANCH_PREFIX
  const slug = slugify((wanted?.name.startsWith(prefix) && prefix ? wanted.name.slice(prefix.length) : wanted?.name.replace(/^ladder\//, '')) ?? title)
  const path = join(worktreesRoot(options.dir), project.name, slug)
  let branch = wanted?.name ?? `${prefix}${slug}`
  // Un branch "nuovo" che esiste già (una seconda sessione sulla stessa issue) si estrae invece di ricrearlo.
  const existing = wanted?.existing || (wanted ? Boolean(await resolveCommit(project.path, `refs/heads/${wanted.name}`)) : false)
  if (wanted && existing) {
    // Il branch aggiornato da origin; se la PR viene da un fork, il suo ref pull/N/head in un branch locale.
    await fetchRef(project.path, wanted.name).catch(() => undefined)
    try {
      await addWorktreeForBranch(project.path, path, wanted.name)
    } catch (error) {
      if (!wanted.pr) throw error
      branch = `${prefix}pr-${wanted.pr}`
      await fetchRef(project.path, `pull/${wanted.pr}/head:${branch}`)
      await addWorktreeForBranch(project.path, path, branch)
    }
  } else {
    await addWorktree(project.path, path, branch, head)
  }
  const base = (await resolveCommit(path, 'HEAD')) ?? head
  const copied: string[] = []
  const missing: string[] = []
  const copyOne = async (rel: string): Promise<boolean> => {
    try {
      const from = insideRoot(project.path, rel)
      if (!(await lstat(from).then(() => true, () => false))) return false
      const to = insideRoot(path, rel)
      // Niente uscite dalle radici: cartelle di origine e destinazione (anche via symlink) e origine che non punta fuori.
      const [rootReal, wtReal] = await Promise.all([realpath(project.path), realpath(path)])
      const under = (child: string, parent: string) => child === parent || child.startsWith(parent + sep)
      if (!under(await realpath(dirname(from)), rootReal)) return false
      // Anche un symlink si copia solo se il suo bersaglio sta dentro il progetto (uno che punta fuori o è rotto si salta).
      if (!under(await realpath(from), rootReal)) return false
      await mkdir(dirname(to), { recursive: true })
      if (!under(await realpath(dirname(to)), wtReal)) return false
      await cp(from, to, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true })
      return true
    } catch {
      return false
    }
  }
  for (const rel of copy) (await copyOne(rel)) ? copied.push(rel) : missing.push(rel)
  // File ignorati: un errore su uno non ferma gli altri e non è un "mancante" (il file c'era, non si è potuto copiare).
  const include = await worktreeIncludeFiles(project.path).catch(() => null)
  for (const rel of include?.files ?? []) if (!copied.includes(rel) && (await copyOne(rel))) copied.push(rel)
  return { info: { path, branch, base }, copied, missing }
}

/** Quanto può durare lo script di pulizia prima che lo si fermi e si proceda comunque. */
export const CLEANUP_TIMEOUT_MS = 60_000

export interface CleanupResult {
  /** Codice d'uscita; null se è scaduto o è stato ucciso da un segnale. */
  code: number | null
  timedOut: boolean
  /** Coda dell'output (stdout e stderr insieme). */
  output: string
}

/**
 * Esegue lo script di pulizia (`[worktree] archive`) nella cartella del worktree, in questo processo e non in un
 * terminale della sessione: si aspetta la fine (o il timeout) e l'output si cattura. Non lancia mai.
 */
export async function runCleanupScript(cwd: string, script: string, port: number | null, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<CleanupResult> {
  const env: Record<string, string | undefined> = { ...cleanEnv(), PATH: await shellPath().catch(() => process.env.PATH) }
  for (const key of Object.keys(env)) if (/^(ELECTRON_|LADDER_)/.test(key) || key === 'NODE_OPTIONS') delete env[key]
  if (port !== null) env.LADDER_PORT = String(port)
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    let done = false
    // Gruppo di processi a sé: allo scadere si ferma anche quello che lo script ha avviato.
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', script], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4000)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      // Un processo in background può tenere aperti i pipe: si chiudono, l'output già letto resta.
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({ code, timedOut, output: output.trim() })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      finish(null)
    }, timeoutMs)
    child.on('error', (error) => {
      output += error.message
      finish(null)
    })
    // Si finisce all'uscita dello script, non alla chiusura dei pipe; una breve attesa lascia arrivare l'ultimo output.
    child.on('exit', (code) => {
      const wait = setTimeout(() => finish(code), 200)
      child.once('close', () => {
        clearTimeout(wait)
        finish(code)
      })
    })
  })
}

/**
 * L'unico modo in cui Ladder toglie un worktree: prima si fermano i servizi, poi lo script di pulizia (se c'è), poi `git worktree remove`.
 * Se lo script fallisce o scade si procede lo stesso; il chiamante riceve l'esito per lasciare una nota.
 * Git rifiuta se ci sono modifiche o file non tracciati: `removed` è falso e il worktree resta.
 */
export async function removeWorktree(
  project: Project,
  path: string,
  options: { port?: number | null; skipCleanup?: boolean; stopServices?: () => Promise<void> } = {}
): Promise<{ removed: boolean; cleanup: CleanupResult | null; /** Perché git non l'ha tolto (stderr ripulito); null se è stato tolto o la cartella non c'era. */ error: string | null }> {
  if (!existsSync(path)) return { removed: false, cleanup: null, error: null }
  // I servizi del worktree (LAD-66) si fermano per primi: lo script di pulizia, per esempio `docker compose down`, li trova già spenti e le porte libere.
  await options.stopServices?.().catch(() => undefined)
  const script = options.skipCleanup ? null : (await loadProjectSettings(project.path)).worktree.archive
  const cleanup = script ? await runCleanupScript(path, script, options.port ?? null) : null
  let error: string | null = null
  const removed = await gitRemoveWorktree(project.path, path).then(
    () => true,
    (failure) => {
      error = gitFailure(failure)
      return false
    }
  )
  return { removed, cleanup, error }
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

  /** Libera lo slot di una cartella di lavoro tolta: il blocco torna disponibile per un worktree nuovo. */
  release(cwd: string): void {
    const slots = this.load()
    if (slots[cwd] === undefined) return
    delete slots[cwd]
    this.db.prepare(`insert into kv (key, value) values ('ports', ?) on conflict(key) do update set value = excluded.value`).run(JSON.stringify(slots))
  }

  /**
   * Come allocate per un worktree nuovo, ma salta gli slot la cui porta base risulta occupata (bind di prova): setup, shell e [[run]]
   * ricevono la base senza altri controlli. Lo slot già assegnato resta.
   */
  async reserve(cwd: string): Promise<number> {
    if (this.load()[cwd] !== undefined) return this.allocate(cwd)
    for (let slot = 0; slot < 400; slot++) {
      if (Object.values(this.load()).includes(slot) || !(await portIsFree(PORT_BASE + slot * PORT_BLOCK))) continue
      const slots = this.load()
      // L'attesa può aver dato lo slot a un altro: si ricontrolla e si scrive subito, senza altri await.
      if (Object.values(slots).includes(slot)) continue
      slots[cwd] = slot
      this.db.prepare(`insert into kv (key, value) values ('ports', ?) on conflict(key) do update set value = excluded.value`).run(JSON.stringify(slots))
      return PORT_BASE + slot * PORT_BLOCK
    }
    return this.allocate(cwd)
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

/** Prova ad aprire la porta su `host`: false se è occupata. Un indirizzo che il computer non ha (niente IPv6) non conta come occupato. */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT'))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/** Vero se nessuno ascolta la porta, né su loopback IPv4 e IPv6 né su tutte le interfacce: un dev server può legarsi a ognuno dei tre. */
export async function portIsFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1', '0.0.0.0']) if (!(await canBind(port, host))) return false
  return true
}

/**
 * La prima porta libera tra le `count` che partono da `base` e non sono in `taken`, o null. Si parte sempre da `base`:
 * a parità di condizioni un worktree ha la stessa porta a ogni avvio, e i blocchi di worktree diversi non si sovrappongono.
 */
export async function freePort(base: number, count: number, taken: ReadonlySet<number>): Promise<number | null> {
  for (let port = base; port < base + count && port <= 65535; port++) if (!taken.has(port) && (await portIsFree(port))) return port
  return null
}
