// Un'operazione alla volta per repository (LAD-69): push, merge e archiviazione si escludono tra loro; il fetch in background
// cede il passo (si ferma e si ritenta) invece di far fallire chi ha chiesto l'operazione.
import { t } from '@shared/i18n'
import { gitRead } from './git'

const locks = new Set<string>()
const fetches = new Map<string, { cancel: () => void; done: Promise<unknown> }>()

/** Chiave del repo: cartella git comune a tutti i worktree, assoluta (la stessa che usa il tracker del fetch). */
export async function repoKey(root: string): Promise<string> {
  return (await gitRead(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')).trim() || root
}

/** C'è un push, un merge o un'archiviazione in corso su questo repo? */
export function repoLocked(key: string): boolean {
  return locks.has(key)
}

/** Il fetch in background dichiara di girare su `key`: chi prende il lock lo ferma e ne aspetta la fine. */
export function registerFetch(key: string, job: { cancel: () => void; done: Promise<unknown> }): () => void {
  fetches.set(key, job)
  return () => {
    if (fetches.get(key) === job) fetches.delete(key)
  }
}

/** Esegue `fn` se nessun'altra operazione di rete (push, merge, archivia) gira sullo stesso repo; altrimenti lancia subito. Un fetch in background si ferma e basta. */
export async function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = await repoKey(root)
  if (locks.has(key)) throw new Error(t('Another push or merge is already running on this repository: wait for it to finish.'))
  locks.add(key)
  try {
    const fetch = fetches.get(key)
    if (fetch) {
      fetch.cancel()
      // Il fetch si ferma da solo (SIGTERM, poi SIGKILL dopo 3 s): si aspetta un po', non all'infinito.
      await Promise.race([fetch.done.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000).unref())])
    }
    return await fn()
  } finally {
    locks.delete(key)
  }
}
