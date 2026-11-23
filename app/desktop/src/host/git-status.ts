// Stato git per l'intestazione della sessione (LAD-68): rilettura a ogni cambio e fetch silenzioso in background.
import { spawn } from 'node:child_process'
import type { GitStatus } from '@shared/protocol'
import { cleanEnv, shellPath } from './agents/common'
import { gitRead, gitStatus, validRemoteName } from './git'
import { registerFetch, repoLocked } from './repo-lock'

/** Ogni quanto si scarica dall'upstream (all'apertura e poi di continuo). */
export const FETCH_INTERVAL_MS = 5 * 60_000
/** Dopo errori l'intervallo raddoppia a ogni fallimento, fino a questo tetto. */
export const FETCH_BACKOFF_MAX_MS = 60 * 60_000
/** Un fetch che non finisce entro questo tempo si ferma (rete assente, host che non risponde). */
export const FETCH_TIMEOUT_MS = 60_000
/** Se l'agente sta lavorando nella cartella o un altro fetch gira, si riprova tra tanto. */
const FETCH_RETRY_MS = 30_000
/** Rilettura periodica dello stato: prende i cambi che il watcher non vede (push da un terminale, commit in un worktree). */
const POLL_MS = 60_000
/** Distanza minima tra due letture dello stato della stessa cartella. */
const MIN_GAP_MS = 400
/** Come sopra mentre una sessione lavora nella cartella: ogni lettura costa ~7 processi git e la rilettura dei file nuovi. */
const BUSY_GAP_MS = 3_000
/** Una lettura del tracker vale per `merge.info` finché non c'è stato un cambio e non è più vecchia di così. */
const FRESH_MS = 5_000

interface Entry {
  count: number
  last: string | null
  running: boolean
  pending: boolean
  lastRunAt: number
  /** Cresce a ogni richiesta di rilettura (cambio nella cartella): una lettura vale solo se è della versione corrente. */
  version: number
  fresh: { status: GitStatus; version: number; at: number } | null
  refreshTimer: NodeJS.Timeout | null
  pollTimer: NodeJS.Timeout
  fetchTimer: NodeJS.Timeout | null
  /** Cartella git comune a tutti i worktree dello stesso repo: chiave del fetch. */
  repo: string | null
}

interface RepoFetch {
  failures: number
  nextAt: number
  /** Un fetch di questo repo è in corso (impostato in modo sincrono, prima di ogni attesa). */
  running: boolean
  cancel: (() => void) | null
}

export interface GitStatusHooks {
  emit: (status: GitStatus) => void
  isWorktree: (root: string) => boolean
  /** Una sessione sta lavorando in questa cartella (un turno può star facendo git). */
  busy: (root: string) => boolean
  /** Un fetch è andato a buon fine: i branch remoti sono cambiati anche se lo stato della cartella no (mappa dei branch, LAD-80). */
  fetched?: (root: string) => void
}

export class GitStatusTracker {
  private readonly roots = new Map<string, Entry>()
  private readonly repos = new Map<string, RepoFetch>()
  private stopped = false

  constructor(private readonly hooks: GitStatusHooks) {}

  /** Stato attuale (comando `git.status`); aggiorna anche l'ultimo mandato, così l'evento successivo non lo ripete. */
  async read(root: string): Promise<GitStatus | null> {
    const status = await gitStatus(root, this.hooks.isWorktree(root))
    const entry = this.roots.get(root)
    if (entry && status) entry.last = JSON.stringify(status)
    return status
  }

  /** Lettura recente del tracker (nessun cambio da allora, al massimo 5 s) o, se non c'è, una lettura nuova: `merge.info` non rifà tutto a ogni `fs.changed`. */
  async recent(root: string): Promise<GitStatus | null> {
    const fresh = this.roots.get(root)?.fresh
    if (fresh && fresh.version === this.roots.get(root)!.version && Date.now() - fresh.at < FRESH_MS) return fresh.status
    return gitStatus(root, this.hooks.isWorktree(root))
  }

  /** Ultimo stato letto dal tracker per la cartella (nessuna lettura nuova); null se non è seguita o non è ancora stata letta. */
  peek(root: string): GitStatus | null {
    return this.roots.get(root)?.fresh?.status ?? null
  }

  /** Un iscritto in più: la prima volta legge subito e programma il primo fetch. */
  track(root: string): void {
    if (this.stopped) return
    const current = this.roots.get(root)
    if (current) {
      current.count++
      return
    }
    const entry: Entry = {
      count: 1,
      last: null,
      running: false,
      pending: false,
      lastRunAt: 0,
      version: 0,
      fresh: null,
      refreshTimer: null,
      pollTimer: setInterval(() => this.refresh(root), POLL_MS),
      fetchTimer: null,
      repo: null
    }
    entry.pollTimer.unref()
    this.roots.set(root, entry)
    this.refresh(root)
    this.scheduleFetch(root, 2_000)
  }

  untrack(root: string): void {
    const entry = this.roots.get(root)
    if (!entry) return
    if (--entry.count > 0) return
    this.drop(root, entry)
  }

  /** Rilegge lo stato (a raffiche si fonde in una lettura sola) e lo manda se è cambiato. */
  refresh(root: string): void {
    const entry = this.roots.get(root)
    if (entry) entry.version++
    if (!entry || entry.refreshTimer || this.stopped) return
    const gap = this.hooks.busy(root) ? BUSY_GAP_MS : MIN_GAP_MS
    const wait = Math.max(0, entry.lastRunAt + gap - Date.now())
    entry.refreshTimer = setTimeout(() => {
      entry.refreshTimer = null
      void this.run(root, entry)
    }, wait)
    entry.refreshTimer.unref()
  }

  shutdown(): void {
    this.stopped = true
    for (const [root, entry] of [...this.roots]) this.drop(root, entry)
    for (const repo of this.repos.values()) repo.cancel?.()
    this.repos.clear()
  }

  private drop(root: string, entry: Entry): void {
    clearInterval(entry.pollTimer)
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
    if (entry.fetchTimer) clearTimeout(entry.fetchTimer)
    this.roots.delete(root)
    // Se era l'ultima cartella del repo, un fetch in corso non serve più.
    if (entry.repo && ![...this.roots.values()].some((e) => e.repo === entry.repo)) this.repos.get(entry.repo)?.cancel?.()
  }

  private async run(root: string, entry: Entry): Promise<void> {
    if (entry.running) {
      entry.pending = true
      return
    }
    entry.running = true
    const version = entry.version
    try {
      const status = await gitStatus(root, this.hooks.isWorktree(root))
      if (status) entry.fresh = { status, version, at: Date.now() }
      if (status && this.roots.get(root) === entry) {
        const json = JSON.stringify(status)
        if (json !== entry.last) {
          entry.last = json
          this.hooks.emit(status)
        }
      }
    } catch {
      // Lettura fallita (repo in uno stato transitorio): ci si riprova al prossimo cambio.
    } finally {
      entry.running = false
      entry.lastRunAt = Date.now()
      if (entry.pending) {
        entry.pending = false
        this.refresh(root)
      }
    }
  }

  private scheduleFetch(root: string, delay: number): void {
    const entry = this.roots.get(root)
    if (!entry || this.stopped) return
    if (entry.fetchTimer) clearTimeout(entry.fetchTimer)
    entry.fetchTimer = setTimeout(() => {
      entry.fetchTimer = null
      void this.fetchTick(root, entry)
    }, delay)
    entry.fetchTimer.unref()
  }

  private async fetchTick(root: string, entry: Entry): Promise<void> {
    try {
      // Mai mentre un turno lavora nella cartella (o in un'altra dello stesso repo): potrebbe star facendo git.
      entry.repo ??= await commonDir(root)
      const key = entry.repo
      if (!key) return
      const siblings = [...this.roots].filter(([, e]) => e.repo === key).map(([r]) => r)
      if (siblings.some((r) => this.hooks.busy(r)) || repoLocked(key)) return this.scheduleFetch(root, FETCH_RETRY_MS)
      let repo = this.repos.get(key)
      if (!repo) this.repos.set(key, (repo = { failures: 0, nextAt: 0, running: false, cancel: null }))
      // Un solo fetch alla volta per repo; chi arriva dopo aspetta la scadenza fissata da chi ha finito (anche dopo un errore).
      if (repo.running) return this.scheduleFetch(root, FETCH_RETRY_MS)
      const wait = repo.nextAt - Date.now()
      if (wait > 0) return this.scheduleFetch(root, Math.min(wait, FETCH_INTERVAL_MS) + 500)
      repo.running = true
      let ok: boolean
      let preempted = false
      let unregister = () => {}
      try {
        const remote = await fetchRemote(root)
        if (!remote) {
          // Nessun upstream o nessun remote: niente da scaricare; si ricontrolla, potrebbe pubblicarsi più tardi.
          repo.nextAt = Date.now() + FETCH_INTERVAL_MS
          return this.scheduleFetch(root, FETCH_INTERVAL_MS)
        }
        // Un push, un merge o un'archiviazione è partito mentre si leggeva il remote: cede il passo.
        if (repoLocked(key)) return this.scheduleFetch(root, FETCH_RETRY_MS)
        const job = startFetch(root, remote)
        const cancel = () => {
          preempted = true
          job.cancel()
        }
        repo.cancel = job.cancel
        // Chi prende il lock del repo (push, merge, archivia) ferma questo fetch e lo aspetta; qui non conta come errore.
        unregister = registerFetch(key, { cancel, done: job.done })
        ok = await job.done
      } finally {
        unregister()
        repo.running = false
        repo.cancel = null
      }
      if (this.stopped) return
      if (preempted) return this.scheduleFetch(root, FETCH_RETRY_MS)
      repo.failures = ok ? 0 : repo.failures + 1
      repo.nextAt = Date.now() + (ok ? FETCH_INTERVAL_MS : Math.min(FETCH_INTERVAL_MS * 2 ** repo.failures, FETCH_BACKOFF_MAX_MS))
      for (const r of siblings) this.refresh(r)
      if (ok) this.hooks.fetched?.(root)
      this.scheduleFetch(root, repo.nextAt - Date.now() + 500)
    } catch {
      this.scheduleFetch(root, FETCH_INTERVAL_MS)
    }
  }
}

/** Cartella git comune a tutti i worktree del repo, assoluta; null se non è un repo. */
async function commonDir(root: string): Promise<string | null> {
  try {
    return (await gitRead(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() || null
  } catch {
    return null
  }
}

/** Remote da cui scarica l'upstream del branch corrente; null se non c'è upstream o l'upstream è un branch locale. */
async function fetchRemote(root: string): Promise<string | null> {
  try {
    const ref = (await gitRead(root, ['symbolic-ref', '-q', 'HEAD'])).trim()
    if (!ref) return null
    const remote = (await gitRead(root, ['for-each-ref', '--format=%(upstream:remotename)', ref])).trim()
    // Solo nomi di remote veri: mai un URL o qualcosa che git leggerebbe come opzione.
    return remote && remote !== '.' && validRemoteName(remote) ? remote : null
  } catch {
    return null
  }
}

/**
 * Ambiente di un git che parla con la rete (fetch di LAD-68, push di LAD-69): env pulito (senza le variabili ANTHROPIC e CLAUDE), PATH della
 * shell di login, nessun prompt di credenziali (i credential helper di git continuano a funzionare), SSH in BatchMode se l'utente
 * non ne ha già configurato uno (la configurazione di ~/.ssh/config vale comunque).
 */
export async function gitNetworkEnv(root: string): Promise<Record<string, string | undefined>> {
  const PATH = await shellPath().catch(() => process.env.PATH)
  const env: Record<string, string | undefined> = { ...cleanEnv(), PATH, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/true', GCM_INTERACTIVE: 'never' }
  // GIT_SSH_COMMAND vince su core.sshCommand: lo si imposta solo se l'utente non ha né l'uno né GIT_SSH.
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
    const configured = await gitRead(root, ['config', '--get', 'core.sshCommand']).then((v) => v.trim(), () => '')
    if (!configured) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  }
  return env
}

/**
 * `git fetch` leggero e senza interazione: niente tag, niente prune, niente sottomoduli, niente gc in background. stdin chiuso,
 * nessun prompt di credenziali (i credential helper di git continuano a funzionare), SSH in BatchMode se l'utente non ne ha
 * già configurato uno (la configurazione di ~/.ssh/config vale comunque). Gruppo di processi a sé: allo scadere si ferma tutto.
 */
function startFetch(root: string, remote: string): { done: Promise<boolean>; cancel: () => void } {
  let child: ReturnType<typeof spawn> | null = null
  let cancelled = false
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child?.pid) process.kill(-child.pid, signal)
    } catch {
      child?.kill(signal)
    }
  }
  const cancel = () => {
    cancelled = true
    killGroup('SIGTERM')
    setTimeout(() => killGroup('SIGKILL'), 3_000).unref()
  }
  const done = (async () => {
    const env = await gitNetworkEnv(root)
    if (cancelled) return false
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined
      try {
        child = spawn(
          'git',
          [
            '-C', root, '--no-optional-locks', '--literal-pathspecs', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
            // Un .git/config ostile non apre trasporti pericolosi (`ext::` esegue comandi) né lancia fsmonitor. `protocol.file.allow`
            // resta com'è: i remote locali (cartelle, bare in /tmp) sono legittimi. Rischio residuo: `remote.<nome>.uploadpack`
            // di un remote locale è un comando eseguito dal fetch, come nel terminale; non si sovrascrivono `core.sshCommand`
            // né `credential.helper` (romperebbero config legittime).
            '-c', 'protocol.ext.allow=never', '-c', 'core.fsmonitor=false',
            'fetch', '--quiet', '--no-tags', '--no-prune', '--no-recurse-submodules', '--', remote
          ],
          { env, detached: true, stdio: 'ignore' }
        )
      } catch {
        return resolve(false)
      }
      timer = setTimeout(cancel, FETCH_TIMEOUT_MS)
      child.on('error', () => (clearTimeout(timer), resolve(false)))
      child.on('close', (code) => (clearTimeout(timer), resolve(code === 0 && !cancelled)))
    })
  })()
  return { done, cancel }
}
