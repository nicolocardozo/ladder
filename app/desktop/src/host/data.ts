// Dati dell'app (LAD-22): informazioni sul database, copia coerente e backup nella cartella dati.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { t } from '@shared/i18n'
import type { DataInfo } from '@shared/protocol'
import type { Db } from './db'

const BACKUPS = 'backups'
/** Le copie automatiche non esistono: si tengono tutte quelle fatte a mano, ma l'elenco ne mostra le ultime. */
const LISTED = 20

const two = (n: number) => String(n).padStart(2, '0')

export async function dataInfo(dbPath: string): Promise<DataInfo> {
  const dir = dirname(dbPath)
  const dbBytes = await stat(dbPath).then((s) => s.size, () => 0)
  const folder = join(dir, BACKUPS)
  const names = await readdir(folder).catch(() => [] as string[])
  const backups = (
    await Promise.all(
      names
        .filter((name) => name.endsWith('.db'))
        .map(async (name) => {
          const info = await stat(join(folder, name)).catch(() => null)
          return info ? { path: join(folder, name), bytes: info.size, at: info.mtimeMs } : null
        })
    )
  )
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, LISTED)
  return { dir, dbPath, dbBytes, backups }
}

/** Percorso reale (symlink risolti) anche se il file o parte delle cartelle non esistono ancora: si risolve l'antenato esistente e si riattacca il resto. */
async function realTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    return join(await realTarget(parent), basename(path))
  }
}

const sameFile = (a: { ino: number; dev: number } | null, b: { ino: number; dev: number } | null) => a !== null && b !== null && a.ino === b.ino && a.dev === b.dev

/** Vero se `dir` (una cartella che esiste) è `target` o uno dei suoi antenati. Si confrontano i file, non le stringhe: su APFS "Data" e "data" sono la stessa cartella. */
async function isAncestor(dir: string, target: string): Promise<boolean> {
  const info = await stat(dir).catch(() => null)
  if (!info) return false
  for (let path = target; ; path = dirname(path)) {
    if (sameFile(await stat(path).catch(() => null), info)) return true
    if (dirname(path) === path) return false
  }
}

/**
 * Vero se scrivere in `target` toccherebbe il database o altro nella cartella dati: il database e i suoi -wal e -shm
 * (anche via symlink, hard link o maiuscole diverse: si confronta l'inode del file reale) e qualunque file
 * della cartella dati fuori da `backups`.
 */
async function overwritesData(target: string, dbPath: string): Promise<boolean> {
  const real = await realTarget(target)
  const dataDir = dirname(dbPath)
  // La cartella delle copie deve esistere per riconoscerla per inode (è comunque la sola in cui scriviamo di nostro).
  await mkdir(join(dataDir, BACKUPS), { recursive: true }).catch(() => undefined)
  if ((await isAncestor(dataDir, real)) && !(await isAncestor(join(dataDir, BACKUPS), real))) return true
  const info = await stat(target).catch(() => null)
  for (const suffix of ['', '-wal', '-shm']) if (sameFile(info, await stat(`${dbPath}${suffix}`).catch(() => null))) return true
  return false
}

/**
 * Copia coerente del database con VACUUM INTO, scritta in un file temporaneo e poi spostata: una copia a metà non
 * prende mai il posto di quella buona. Senza `to` va in `backups` nella cartella dati.
 */
export async function backupDatabase(db: Db, dbPath: string, to?: string): Promise<{ path: string; bytes: number }> {
  let target = to
  if (target === undefined) {
    const now = new Date()
    const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
    target = join(dirname(dbPath), BACKUPS, `ladder-${stamp}.db`)
  }
  if (!isAbsolute(target) || (await overwritesData(target, dbPath))) throw new Error(t('Choose a different file to save the database copy.'))
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${randomBytes(3).toString('hex')}.tmp`
  try {
    db.prepare('vacuum into ?').run(temp)
    await rename(temp, target)
  } catch (error) {
    if (existsSync(temp)) await rm(temp, { force: true })
    throw new Error(t('Could not save the database copy: {message}', { message: error instanceof Error ? error.message : String(error) }))
  }
  return { path: target, bytes: (await stat(target)).size }
}
