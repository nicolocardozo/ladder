// One operation at a time per repository: push, merge and archive exclude each other; the background fetch
// yields (it stops and retries) instead of failing whoever asked for the operation.
import { t } from '@shared/i18n'
import { gitRead } from './git'

const locks = new Set<string>()
const fetches = new Map<string, { cancel: () => void; done: Promise<unknown> }>()

/** Repo key: git folder shared by all worktrees, absolute (the same one the fetch tracker uses). */
export async function repoKey(root: string): Promise<string> {
  return (await gitRead(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')).trim() || root
}

/** Is a push, merge or archive in progress on this repo? */
export function repoLocked(key: string): boolean {
  return locks.has(key)
}

/** The background fetch declares it is running on `key`: whoever takes the lock stops it and waits for it to finish. */
export function registerFetch(key: string, job: { cancel: () => void; done: Promise<unknown> }): () => void {
  fetches.set(key, job)
  return () => {
    if (fetches.get(key) === job) fetches.delete(key)
  }
}

/** Runs `fn` if no other network operation (push, merge, archive) is running on the same repo; otherwise throws immediately. A background fetch just stops. */
export async function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = await repoKey(root)
  if (locks.has(key)) throw new Error(t('Another push or merge is already running on this repository: wait for it to finish.'))
  locks.add(key)
  try {
    const fetch = fetches.get(key)
    if (fetch) {
      fetch.cancel()
      // The fetch stops by itself (SIGTERM, then SIGKILL after 3 s): wait a little, not forever.
      await Promise.race([fetch.done.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000).unref())])
    }
    return await fn()
  } finally {
    locks.delete(key)
  }
}
