// Opaque ids of the roots the main process serves files from (ladder-file protocol): one per project or session worktree.
// The full list goes to the main process on every change; a root the host no longer knows stops working within a few seconds.
import { randomBytes } from 'node:crypto'
import type { HostToMain } from '@shared/protocol'

export class FileRoots {
  private readonly ids = new Map<string, string>()
  private sent = ''

  constructor(
    private readonly send: (message: HostToMain) => void,
    /** Folders currently known: projects and session working folders. */
    private readonly live: () => Iterable<string>
  ) {
    setInterval(() => this.refresh(), 3000).unref()
  }

  /** Root id (call only with a root already validated by knownRoot). It tells the main process before returning it. */
  idFor(root: string): string {
    let id = this.ids.get(root)
    if (!id) {
      id = randomBytes(16).toString('hex')
      this.ids.set(root, id)
    }
    this.refresh()
    return id
  }

  /** Drops vanished roots and, if the list changed, sends it to the main process. */
  refresh(): void {
    const live = new Set(this.live())
    for (const root of [...this.ids.keys()]) if (!live.has(root)) this.ids.delete(root)
    const roots = [...this.ids].map(([root, id]) => ({ id, root }))
    const key = JSON.stringify(roots)
    if (key === this.sent) return
    this.sent = key
    this.send({ type: 'file-roots', roots })
  }
}
