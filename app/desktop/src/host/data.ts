// App data: database information, consistent copy and backup in the data folder.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { t } from '@shared/i18n'
import type { DataInfo } from '@shared/protocol'
import type { Db } from './db'

const BACKUPS = 'backups'
/** There are no automatic copies: all manual ones are kept, but the list shows the latest. */
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

/** Real path (symlinks resolved) even if the file or some folders do not exist yet: resolve the existing ancestor and reattach the rest. */
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

/** True if `dir` (an existing folder) is `target` or one of its ancestors. Files are compared, not strings: on APFS "Data" and "data" are the same folder. */
async function isAncestor(dir: string, target: string): Promise<boolean> {
  const info = await stat(dir).catch(() => null)
  if (!info) return false
  for (let path = target; ; path = dirname(path)) {
    if (sameFile(await stat(path).catch(() => null), info)) return true
    if (dirname(path) === path) return false
  }
}

/**
 * True if writing to `target` would touch the database or anything else in the data folder: the database and its -wal and -shm
 * (also via symlink, hard link or different case: the real file's inode is compared) and any file
 * in the data folder outside `backups`.
 */
async function overwritesData(target: string, dbPath: string): Promise<boolean> {
  const real = await realTarget(target)
  const dataDir = dirname(dbPath)
  // The copies folder must exist to be recognized by inode (it is anyway the only one we write to ourselves).
  await mkdir(join(dataDir, BACKUPS), { recursive: true }).catch(() => undefined)
  if ((await isAncestor(dataDir, real)) && !(await isAncestor(join(dataDir, BACKUPS), real))) return true
  const info = await stat(target).catch(() => null)
  for (const suffix of ['', '-wal', '-shm']) if (sameFile(info, await stat(`${dbPath}${suffix}`).catch(() => null))) return true
  return false
}

/**
 * Consistent copy of the database with VACUUM INTO, written to a temporary file and then moved: a half-written copy
 * never replaces the good one. Without `to` it goes to `backups` in the data folder.
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
