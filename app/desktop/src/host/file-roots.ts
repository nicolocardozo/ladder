// Id opachi delle root da cui il main serve file (LAD-70, protocollo ladder-file): uno per progetto o worktree di sessione.
// L'elenco completo va al main a ogni cambio; una root che l'host non conosce più smette di funzionare entro pochi secondi.
import { randomBytes } from 'node:crypto'
import type { HostToMain } from '@shared/protocol'

export class FileRoots {
  private readonly ids = new Map<string, string>()
  private sent = ''

  constructor(
    private readonly send: (message: HostToMain) => void,
    /** Cartelle oggi note: progetti e cartelle di lavoro delle sessioni. */
    private readonly live: () => Iterable<string>
  ) {
    setInterval(() => this.refresh(), 3000).unref()
  }

  /** Id della root (chiamare solo con una root già validata da knownRoot). Lo comunica al main prima di restituirlo. */
  idFor(root: string): string {
    let id = this.ids.get(root)
    if (!id) {
      id = randomBytes(16).toString('hex')
      this.ids.set(root, id)
    }
    this.refresh()
    return id
  }

  /** Toglie le root sparite e, se l'elenco è cambiato, lo manda al main. */
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
