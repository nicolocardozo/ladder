// Working folder files: tree with git status, reading for the viewer and change watching.
import { spawn } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { t } from '@shared/i18n'
import { cleanEnv } from '@shared/env'
import { fileUrl, imageSize, isKnownRev, isTextExtension, SNIFF_BYTES, sniffType } from '@shared/file-type'
import type { FileContent, FileMedia, FileTree, FileWriteResult } from '@shared/protocol'
import { git, isBinary, listFiles, MAX_TEXT_BYTES, repoInfo, statusMap } from './git'

const MAX_FILES = 20000
/** Folders skipped in folders without git, where there is no .gitignore to follow. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', '.cache', '.venv', '__pycache__', 'DerivedData'])

/** Absolute path of `rel` inside `root`. Rejects anything that leaves the folder. */
export function insideRoot(root: string, rel: string): string {
  // Empty root (session of a removed project): resolve('', '/x') would accept any path.
  if (!root) throw new Error(t('Folder unknown to Ladder.'))
  const absolute = resolve(root, rel)
  if (absolute !== root && !absolute.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new Error(t('Path outside the session folder.'))
  }
  return absolute
}

export async function listTree(root: string): Promise<FileTree> {
  const info = await repoInfo(root)
  if (info.isGit) {
    const [files, status] = await Promise.all([listFiles(root, MAX_FILES + 1), statusMap(root).catch(() => ({}))])
    return { root, isGit: true, files: files.slice(0, MAX_FILES), status, truncated: files.length > MAX_FILES }
  }
  const files: string[] = []
  const queue = [root]
  while (queue.length > 0 && files.length <= MAX_FILES) {
    const dir = queue.shift()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(absolute)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relative(root, absolute))
      }
    }
  }
  return { root, isGit: false, files: files.slice(0, MAX_FILES), status: {}, truncated: files.length > MAX_FILES }
}

/** Metadata of a non-text file (or SVG) from its first bytes; `rootId` null: no URL. */
function mediaFrom(head: Buffer, rel: string, size: number, mtimeMs: number | null, rootId: string | null, rev: string | null): FileMedia {
  const type = sniffType(head, rel)
  if (!type) return { kind: 'other', mime: 'application/octet-stream', size, width: null, height: null, mtimeMs, url: null }
  const dims = type.kind === 'image' ? imageSize(head, type.mime) : null
  return { kind: type.kind, mime: type.mime, size, width: dims?.width ?? null, height: dims?.height ?? null, mtimeMs, url: rootId ? fileUrl(rootId, rel, rev) : null }
}

/** `rootId`: ladder-file id of the root; without it, a binary file is described without a URL. */
export async function readText(root: string, rel: string, rootId: string | null = null): Promise<FileContent> {
  const absolute = insideRoot(root, rel)
  const info = await stat(absolute)
  if (!info.isFile()) throw new Error(t('Not a file.'))
  const handle = await open(absolute, 'r')
  try {
    // Header only first: a 500 MB video or a zip is not read in full.
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, info.size))
    if (head.length) await handle.read(head, 0, head.length, 0)
    const type = sniffType(head, rel)
    const media = () => mediaFrom(head, rel, info.size, info.mtimeMs, rootId, null)
    // A file with a text extension and no NUL is text even if its first bytes look like a format (a .md that quotes `%PDF-1.7`).
    const textLike = isTextExtension(rel) && !isBinary(head)
    if ((type && type.kind !== 'svg' && !textLike) || (info.size > MAX_TEXT_BYTES && isBinary(head))) return { path: rel, size: info.size, binary: true, tooLarge: false, text: null, mtimeMs: info.mtimeMs, media: media() }
    if (info.size > MAX_TEXT_BYTES) return { path: rel, size: info.size, binary: false, tooLarge: true, text: null, mtimeMs: info.mtimeMs, media: type ? media() : null }
    const buffer = await handle.readFile()
    if (isBinary(buffer)) return { path: rel, size: info.size, binary: true, tooLarge: false, text: null, mtimeMs: info.mtimeMs, media: media() }
    // SVG is also text: the viewer shows the preview (with <img>) and the code.
    return { path: rel, size: info.size, binary: false, tooLarge: false, text: buffer.toString('utf8'), mtimeMs: info.mtimeMs, media: type && !textLike ? media() : null }
  } finally {
    await handle.close()
  }
}

/** First bytes of a git blob, without reading all of it. */
function blobHead(root: string, spec: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, '--no-optional-locks', 'cat-file', 'blob', spec], { env: cleanEnv(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']), stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let length = 0
    let done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true
      child.kill()
      if (error) reject(error)
      else resolve(Buffer.concat(chunks).subarray(0, SNIFF_BYTES))
    }
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      length += chunk.length
      if (length >= SNIFF_BYTES) finish()
    })
    child.on('error', finish)
    child.on('close', () => finish())
  })
}

/** Describes a file of the root, on disk or at a git revision (HEAD or a full sha: nothing else, the rev goes to git as an argument). */
export async function mediaInfo(root: string, rel: string, rootId: string, rev: string | null): Promise<FileMedia> {
  const absolute = insideRoot(root, rel)
  if (rev === null) {
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error(t('Not a file.'))
    const handle = await open(absolute, 'r')
    try {
      const head = Buffer.alloc(Math.min(SNIFF_BYTES, info.size))
      if (head.length) await handle.read(head, 0, head.length, 0)
      return mediaFrom(head, rel, info.size, info.mtimeMs, rootId, null)
    } finally {
      await handle.close()
    }
  }
  if (!isKnownRev(rev)) throw new Error(t('Unknown revision.'))
  const spec = `${rev}:./${rel}`
  const [kind, size] = await Promise.all([git(root, ['cat-file', '-t', spec]), git(root, ['cat-file', '-s', spec])]).catch(() => {
    throw new Error(t('The file doesn’t exist in that revision.'))
  })
  if (kind !== 'blob') throw new Error(t('Not a file.'))
  return mediaFrom(await blobHead(root, spec), rel, Number(size), null, rootId, rev)
}

/** Writes a file in the folder. If it changed since the last read it does not write: whoever is editing decides. */
export async function writeText(root: string, rel: string, text: string, baseMtime: number | null): Promise<FileWriteResult> {
  const absolute = insideRoot(root, rel)
  if (rel.split(/[\\/]/).includes('.git')) throw new Error(t('Ladder doesn’t edit files inside .git.'))
  // A symbolic link must not lead the write outside the folder.
  const realRoot = await realpath(root)
  const target = await realpath(absolute).catch(async () => join(await realpath(dirname(absolute)), basename(absolute)))
  if (target !== realRoot && !target.startsWith(realRoot + sep)) throw new Error(t('Path outside the session folder.'))
  const info = await stat(absolute).catch(() => null)
  if (info && !info.isFile()) throw new Error(t('Not a file.'))
  if (info && baseMtime !== null && info.mtimeMs !== baseMtime) {
    const current = await readFile(absolute, 'utf8')
    if (current !== text) return { ok: false, text: current, mtimeMs: info.mtimeMs }
  }
  await writeFile(absolute, text, 'utf8')
  return { ok: true, mtimeMs: (await stat(absolute)).mtimeMs }
}

/**
 * Watches the folders open in the interface and notifies, once a burst is over, when something that matters changes:
 * project files, git index and HEAD. Ignores node_modules, git objects and Ladder checkpoints.
 */
export class RootWatcher {
  private watchers = new Map<string, { watcher: FSWatcher; count: number; timer: NodeJS.Timeout | null }>()

  constructor(private readonly onChange: (root: string) => void) {}

  watch(root: string): void {
    const current = this.watchers.get(root)
    if (current) {
      current.count++
      return
    }
    let watcher: FSWatcher
    try {
      watcher = watch(root, { recursive: true }, (_event, name) => {
        if (name && ignored(name.toString())) return
        const entry = this.watchers.get(root)
        if (!entry) return
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          entry.timer = null
          this.onChange(root)
        }, 250)
      })
    } catch {
      return
    }
    watcher.on('error', () => this.drop(root))
    this.watchers.set(root, { watcher, count: 1, timer: null })
  }

  unwatch(root: string): void {
    const current = this.watchers.get(root)
    if (!current) return
    current.count--
    if (current.count <= 0) this.drop(root)
  }

  private drop(root: string): void {
    const current = this.watchers.get(root)
    if (!current) return
    if (current.timer) clearTimeout(current.timer)
    current.watcher.close()
    this.watchers.delete(root)
  }

  close(): void {
    for (const root of [...this.watchers.keys()]) this.drop(root)
  }
}

function ignored(name: string): boolean {
  if (name.startsWith('node_modules/') || name.includes('/node_modules/') || name === 'node_modules') return true
  if (name === '.DS_Store' || name.endsWith('/.DS_Store')) return true
  if (name === '.git' || name.startsWith('.git/')) {
    // Only visible changes count: index (stage, commit) and HEAD (branch switch).
    return !(name === '.git/index' || name === '.git/HEAD')
  }
  return false
}
