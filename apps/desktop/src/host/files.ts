// File delle cartelle di lavoro: albero con stato git, lettura per il viewer e osservazione dei cambiamenti.
import { watch, type FSWatcher } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { t } from '@shared/i18n'
import type { FileContent, FileTree } from '@shared/protocol'
import { isBinary, listFiles, MAX_TEXT_BYTES, repoInfo, statusMap } from './git'

const MAX_FILES = 20000
/** Cartelle saltate nelle cartelle senza git, dove non c'è un .gitignore da seguire. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', '.cache', '.venv', '__pycache__', 'DerivedData'])

/** Percorso assoluto di `rel` dentro `root`. Rifiuta tutto ciò che esce dalla cartella. */
export function insideRoot(root: string, rel: string): string {
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

export async function readText(root: string, rel: string): Promise<FileContent> {
  const absolute = insideRoot(root, rel)
  const info = await stat(absolute)
  if (!info.isFile()) throw new Error(t('Not a file.'))
  if (info.size > MAX_TEXT_BYTES) return { path: rel, size: info.size, binary: false, tooLarge: true, text: null }
  const handle = await open(absolute, 'r')
  try {
    const buffer = await handle.readFile()
    if (isBinary(buffer)) return { path: rel, size: info.size, binary: true, tooLarge: false, text: null }
    return { path: rel, size: info.size, binary: false, tooLarge: false, text: buffer.toString('utf8') }
  } finally {
    await handle.close()
  }
}

/**
 * Osserva le cartelle aperte nell'interfaccia e avvisa, a raffica finita, quando cambia qualcosa che conta:
 * file del progetto, indice e HEAD di git. Ignora node_modules, gli oggetti di git e i checkpoint di Ladder.
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
    // Contano solo i cambi visibili: indice (stage, commit) e HEAD (cambio branch).
    return !(name === '.git/index' || name === '.git/HEAD')
  }
  return false
}
