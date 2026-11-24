// Mappa dei branch delle sessioni rispetto al ramo principale (LAD-80). Solo letture git sul checkout principale, sui riferimenti
// (mai sulle cartelle dei worktree: se la cartella è sparita il branch si legge lo stesso), nessuna scrittura e nessuna chiamata a gh
// (nemmeno per il ramo principale: lo risolve l'host da origin/HEAD, main o master).
// Costo: una `for-each-ref` per giro legge sha, data e titolo di tutti i branch; i conteggi veri (merge-base, ahead/behind, righe) si
// ricalcolano solo quando cambia una coppia (sha del branch, sha del ramo principale) e restano in cache.
import type { AgentId, BranchMap, BranchMapEntry, BranchMapProblem, PrStatus, RunState } from '@shared/protocol'
import { t } from '@shared/i18n'
import { currentBranch } from './branches'
import { dirtyCount, gitRead } from './git'

/** Righe di worktree al massimo nella mappa (attivi o uniti): le sessioni più recenti. */
export const MAX_BRANCH_MAP_ENTRIES = 50
/** Sessioni del checkout principale al massimo (non costano letture git): servono a dire "sei su main" quando il checkout è sul ramo principale. */
const MAX_BASE_ENTRIES = 20
/** Righe di worktree esaminate al massimo per riempire la mappa: una sessione archiviata si sa se è unita solo leggendo git. */
const MAX_EXAMINED = 200
/** Una sessione archiviata più vecchia di così non entra nemmeno nel calcolo (un branch unito da più di 7 giorni la UI lo nasconde). */
const MAX_ARCHIVED_AGE_MS = 30 * 24 * 3_600_000
/** Tempo massimo di ogni comando git. */
const READ_TIMEOUT_MS = 10_000
/** Comandi git contemporanei al massimo (a freddo, con molti branch). */
const CONCURRENCY = 6
/** Raffiche di cambi (fs, turni, fetch) si fondono in un calcolo solo. */
const DEBOUNCE_MS = 600
/** Rilettura periodica per i progetti con una finestra iscritta: prende push, fetch e commit che nessun evento ha segnalato. */
const POLL_MS = 60_000
const CACHE_MAX = 600
const SHA = /^[0-9a-f]{40,64}$/

/** Dati di una sessione che l'host sa senza git. */
export interface BranchMapRow {
  sessionId: string
  title: string
  agent: AgentId
  run: RunState
  archived: boolean
  activityAt: number
  prState: PrStatus['state'] | null
  isWorktree: boolean
  worktreeMissing: boolean
  /** Cartella di lavoro: chiave per le modifiche non committate lette dal tracker. */
  cwd: string
  branch: string | null
  /** Commit da cui è nato il worktree (sha), se noto. */
  start: string | null
  /** PR unita nota (non di una sessione precedente con lo stesso nome di branch): data (mergedAt) e testa della PR. */
  prMerged: { at: number; oid: string | null } | null
  /** Unione registrata quando la sessione è stata archiviata (sopravvive al riavvio); `at` null se la data non si sa. */
  saved: { via: 'git' | 'pr'; at: number | null } | null
}

export interface BranchMapSource {
  /** Checkout principale del progetto, dove girano tutte le letture. */
  root: string
  /** Ramo principale (lo stesso del pannello Merge); null se il progetto non è git o la cartella non c'è. */
  base: string | null
  rows: BranchMapRow[]
}

export interface BranchMapHooks {
  /** Dati grezzi del progetto; lancia se il progetto non esiste. */
  source: (projectId: string) => Promise<BranchMapSource>
  emit: (projectId: string, map: BranchMap) => void
  /** File con modifiche non committate di una cartella, se il tracker git l'ha già letta. */
  dirty: (cwd: string) => number | null
}

interface Facts {
  problem: BranchMapProblem | null
  mergeBase: string | null
  mergeBaseAt: number | null
  ahead: number | null
  behind: number | null
  merged: 'git' | 'pr' | null
  mergedAt: number | null
  added: number | null
  removed: number | null
}

interface RefInfo {
  sha: string
  at: number
  subject: string
}

interface Watched {
  count: number
  last: string | null
  timer: NodeJS.Timeout | null
  poll: NodeJS.Timeout
  running: boolean
  again: boolean
}

export class BranchMapService {
  private readonly facts = new Map<string, Promise<Facts>>()
  /** Un solo calcolo alla volta per progetto: chi arriva durante lo condivide. */
  private readonly inflight = new Map<string, Promise<BranchMap>>()
  private readonly watched = new Map<string, Watched>()
  /** File non committati del checkout principale quando il tracker non lo guarda: si rileggono solo se la cartella è cambiata o col poll, non a ogni calcolo. */
  private readonly mainDirty = new Map<string, { value: number | null; stale: boolean }>()
  private stopped = false

  constructor(private readonly hooks: BranchMapHooks) {}

  /** Mappa attuale (comando `project.branchMap`); aggiorna anche l'ultima mandata, così l'evento successivo non la ripete. */
  async read(projectId: string): Promise<BranchMap> {
    const map = await this.build(projectId)
    const entry = this.watched.get(projectId)
    if (entry) entry.last = JSON.stringify(map)
    return map
  }

  isWatched(projectId: string): boolean {
    return this.watched.has(projectId)
  }

  watch(projectId: string): void {
    if (this.stopped) return
    const current = this.watched.get(projectId)
    if (current) {
      current.count++
      return
    }
    const poll = setInterval(() => this.touch(projectId, true), POLL_MS)
    poll.unref()
    this.watched.set(projectId, { count: 1, last: null, timer: null, poll, running: false, again: false })
    this.touch(projectId)
  }

  unwatch(projectId: string): void {
    const entry = this.watched.get(projectId)
    if (!entry || --entry.count > 0) return
    this.forget(projectId)
  }

  /** Progetto rimosso, o ultimo iscritto uscito: niente più timer. */
  forget(projectId: string): void {
    const entry = this.watched.get(projectId)
    if (!entry) return
    clearInterval(entry.poll)
    if (entry.timer) clearTimeout(entry.timer)
    this.watched.delete(projectId)
    this.mainDirty.delete(projectId)
  }

  /** Qualcosa che può cambiare la mappa è successo: se c'è un iscritto si rilegge (a raffiche, una volta sola) e si manda se è cambiata. */
  touch(projectId: string, mainChanged = false): void {
    // Il segno resta anche senza iscritti: il prossimo calcolo rilegge i file non committati.
    if (mainChanged) {
      const cached = this.mainDirty.get(projectId)
      if (cached) cached.stale = true
    }
    const entry = this.watched.get(projectId)
    if (!entry || this.stopped) return
    if (entry.running) {
      entry.again = true
      return
    }
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.tick(projectId, entry)
    }, DEBOUNCE_MS)
    entry.timer.unref()
  }

  shutdown(): void {
    this.stopped = true
    for (const id of [...this.watched.keys()]) this.forget(id)
    this.facts.clear()
  }

  private async tick(projectId: string, entry: Watched): Promise<void> {
    entry.running = true
    try {
      // Un calcolo già in corso (per esempio di una `read`) è partito prima di questo cambio: si aspetta e si rifà, invece di
      // riusarne il risultato e perdere il cambio fino al giro di 60 s.
      await this.inflight.get(projectId)?.catch(() => undefined)
      const map = await this.build(projectId)
      if (this.stopped || this.watched.get(projectId) !== entry) return
      const json = JSON.stringify(map)
      if (json !== entry.last) {
        entry.last = json
        this.hooks.emit(projectId, map)
      }
    } catch {
      // Progetto sparito o repo in uno stato transitorio: ci si riprova al prossimo cambio.
    } finally {
      entry.running = false
      if (entry.again) {
        entry.again = false
        this.touch(projectId)
      }
    }
  }

  private build(projectId: string): Promise<BranchMap> {
    let run = this.inflight.get(projectId)
    if (!run) {
      run = this.compute(projectId).finally(() => this.inflight.delete(projectId))
      this.inflight.set(projectId, run)
    }
    return run
  }

  private async compute(projectId: string): Promise<BranchMap> {
    // Se il progetto non c'è più lancia: non è una mappa da mostrare.
    const source = await this.hooks.source(projectId)
    const empty: BranchMap = { projectId, base: null, baseAt: null, baseSha: null, entries: [], hidden: 0 }
    if (!source.root || !source.base || !validRefName(source.base)) return empty
    try {
      return await this.mapOf(projectId, source as BranchMapSource & { base: string })
    } catch {
      // Un guasto nel calcolo non lascia la UI su "Reading…" per sempre: mappa vuota con l'errore.
      return { ...empty, error: t('Could not read the branches') }
    }
  }

  private async mapOf(projectId: string, source: BranchMapSource & { base: string }): Promise<BranchMap> {
    const now = Date.now()
    const recent = source.rows.filter((r) => !(r.archived && now - r.activityAt > MAX_ARCHIVED_AGE_MS)).sort((a, b) => b.activityAt - a.activityAt)
    // Il limite si applica solo a ciò che la UI mostra: i worktree. Le sessioni sul checkout principale non lo consumano
    // (ne servono poche, per "sei su main"); quelle su un altro branch senza worktree non si disegnano e non si mandano.
    const worktrees = recent.filter((r) => r.isWorktree)
    // Il branch del checkout principale si legge da git, non dalle sessioni (il loro `branch` è quello visto all'ultimo snapshot, e senza
    // sessioni non c'è nulla da leggere): se non è il ramo principale compare come una riga a sé, altrimenti valgono le sessioni "sei su main".
    const head = await currentBranch(source.root)
    const inMain = recent.filter((r) => !r.isWorktree)
    const onBase = (head === null ? inMain.filter((r) => r.branch === source.base) : head === source.base ? inMain.map((r) => ({ ...r, branch: head })) : []).slice(0, MAX_BASE_ENTRIES)
    const mainRow = head !== null && head !== source.base && validRefName(head) ? mainCheckoutRow(projectId, source, head, inMain) : null
    const baseRef = await readBaseRef(source.root, source.base)

    // Una sessione archiviata che non è unita è un lavoro abbandonato: non ha una curva. Se è unita lo si sa solo leggendo git
    // (o dall'unione registrata): si esamina a blocchi, in ordine di data, finché le righe valide bastano.
    const kept: BranchMapEntry[] = []
    let next = 0
    while (next < worktrees.length && kept.length < MAX_BRANCH_MAP_ENTRIES && next < MAX_EXAMINED) {
      const part = worktrees.slice(next, next + MAX_BRANCH_MAP_ENTRIES)
      next += part.length
      for (const e of await this.entriesFor(source, baseRef, part)) if (!e.archived || e.merged) kept.push(e)
    }
    const shown = kept.slice(0, MAX_BRANCH_MAP_ENTRIES)
    // Quelle che avrebbero posto ma non ci sono: l'avanzo e le righe non esaminate che certamente contano (stima per difetto).
    const hidden = kept.length - shown.length + worktrees.slice(next).filter((r) => !r.archived || r.prMerged || r.saved).length
    const rest = await this.entriesFor(source, baseRef, mainRow ? [...onBase, mainRow] : onBase)
    if (mainRow) {
      const entry = rest[rest.length - 1]
      entry.mainCheckout = true
      // Il tracker conosce solo le cartelle che una finestra guarda: senza sessioni aperte nel checkout principale i file non committati si contano qui.
      if (entry.dirty === null) {
        const cached = this.mainDirty.get(projectId)
        if (cached && !cached.stale) entry.dirty = cached.value
        else {
          const value = await dirtyCount(source.root).catch(() => null)
          this.mainDirty.set(projectId, { value, stale: false })
          entry.dirty = value
        }
      }
      // Senza sessioni la riga non ha un'attività propria: vale l'ultimo commit del branch.
      if (!inMain.some((r) => !r.archived)) entry.activityAt = entry.lastCommit?.at ?? entry.activityAt
    }
    const entries = [...shown, ...rest].sort((a, b) => b.activityAt - a.activityAt)
    return { projectId, base: source.base, baseAt: baseRef && baseRef.at > 0 ? baseRef.at : null, baseSha: baseRef?.sha ?? null, entries, hidden }
  }

  /** Le righe della mappa per queste sessioni (con i fatti git dei branch). */
  private async entriesFor(source: BranchMapSource & { base: string }, baseRef: RefInfo | null, rows: BranchMapRow[]): Promise<BranchMapEntry[]> {
    if (rows.length === 0) return []
    // Un solo processo per giro: sha, data e titolo dell'ultimo commit di ogni branch interessato (e di origin/<branch>, per le unioni fast-forward).
    const branches = [...new Set(rows.map((r) => r.branch).filter((b): b is string => !!b && b !== source.base && validRefName(b)))]
    const refs = branches.length > 0 ? await readRefs(source.root, source.base, branches) : new Map<string, RefInfo>()

    const entries: BranchMapEntry[] = []
    const jobs: { index: number; row: BranchMapRow; head: RefInfo; remote: RefInfo | null }[] = []
    for (const row of rows) {
      const entry = baseEntry(row)
      const head = row.branch && validRefName(row.branch) ? (refs.get(`refs/heads/${row.branch}`) ?? null) : null
      entry.dirty = row.worktreeMissing ? null : this.hooks.dirty(row.cwd)
      if (!row.branch) entry.problem = 'detached'
      else if (row.branch === source.base) entry.isBase = true
      else if (!head) entry.problem = 'branch_missing'
      else if (!baseRef) entry.problem = 'no_base'
      else {
        entry.lastCommit = { subject: head.subject, at: head.at }
        jobs.push({ index: entries.length, row, head, remote: refs.get(`refs/remotes/origin/${row.branch}`) ?? null })
      }
      entries.push(entry)
    }
    await pool(jobs, CONCURRENCY, async ({ index, row, head, remote }) => {
      const key = [source.root, head.sha, remote?.sha ?? '', baseRef!.sha, row.start ?? '', row.prMerged?.oid ?? '', row.prMerged?.at ?? ''].join('\0')
      let facts = this.facts.get(key)
      if (!facts) {
        if (this.facts.size >= CACHE_MAX) for (const k of [...this.facts.keys()].slice(0, CACHE_MAX / 2)) this.facts.delete(k)
        facts = factsFor(source.root, head, remote, baseRef!.sha, row)
        this.facts.set(key, facts)
        facts.catch(() => this.facts.delete(key))
      }
      Object.assign(entries[index], await facts.catch((): Partial<Facts> => ({})))
    })
    // Archiviata come unita e git non lo conferma (squash dopo un riavvio, PR non più in cache): vale l'unione registrata.
    rows.forEach((row, i) => {
      const entry = entries[i]
      if (!row.archived || !row.saved || entry.merged) return
      entry.merged = row.saved.via
      entry.mergedAt = row.saved.at ?? entry.lastCommit?.at ?? row.activityAt
    })
    return entries
  }
}

/**
 * Dati della riga del checkout principale su `head` (un branch che non è il ramo principale). La sessione è la più recente non archiviata del
 * checkout principale (la riga si apre su quella); senza sessioni ha un id sintetico e non si apre. Lo stato è il più urgente tra quelle non archiviate.
 */
function mainCheckoutRow(projectId: string, source: BranchMapSource, head: string, inMain: BranchMapRow[]): BranchMapRow {
  const live = inMain.filter((r) => !r.archived)
  const latest = live[0] ?? null
  const run: RunState = live.some((r) => r.run === 'waiting') ? 'waiting' : live.some((r) => r.run === 'running' || r.run === 'starting') ? 'running' : (latest?.run ?? 'idle')
  return {
    sessionId: latest?.sessionId ?? `main-checkout:${projectId}`,
    title: latest?.title ?? head,
    agent: latest?.agent ?? 'claude-code',
    run,
    archived: false,
    activityAt: latest?.activityAt ?? 0,
    // PR e unione registrata sono di un branch di una sessione: per il branch letto adesso non valgono.
    prState: null,
    isWorktree: false,
    worktreeMissing: false,
    cwd: source.root,
    branch: head,
    start: null,
    prMerged: null,
    saved: null
  }
}

function baseEntry(row: BranchMapRow): BranchMapEntry {
  return {
    sessionId: row.sessionId,
    title: row.title,
    agent: row.agent,
    run: row.run,
    archived: row.archived,
    activityAt: row.activityAt,
    prState: row.prState,
    isWorktree: row.isWorktree,
    worktreeMissing: row.worktreeMissing,
    branch: row.branch,
    isBase: false,
    problem: null,
    mergeBase: null,
    mergeBaseAt: null,
    ahead: null,
    behind: null,
    merged: null,
    mergedAt: null,
    lastCommit: null,
    added: null,
    removed: null,
    dirty: null
  }
}

/** Nome di branch che si può usare in un riferimento: niente caratteri di controllo né jolly (git li vieta), mai un'opzione. */
function validRefName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith('-') && !/[\u0000-\u001f\u007f\s*?[\\~^:]/.test(name)
}

/** Ramo principale di questo giro: origin/<base> se c'è, altrimenti quello locale. */
async function readBaseRef(root: string, base: string): Promise<RefInfo | null> {
  const refs = await readRefs(root, base, [])
  return refs.get(`refs/remotes/origin/${base}`) ?? refs.get(`refs/heads/${base}`) ?? null
}

/** Sha, data (ms) e titolo dell'ultimo commit dei riferimenti richiesti. */
async function readRefs(root: string, base: string, branches: string[]): Promise<Map<string, RefInfo>> {
  const patterns = [
    ...new Set([`refs/heads/${base}`, `refs/remotes/origin/${base}`, ...branches.flatMap((b) => [`refs/heads/${b}`, `refs/remotes/origin/${b}`])])
  ]
  const out = new Map<string, RefInfo>()
  let text: string
  try {
    text = await gitRead(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(subject)', ...patterns], READ_TIMEOUT_MS)
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const [name, sha, at, subject] = line.split('\0')
    // Il pattern `refs/heads/foo` prende anche `refs/heads/foo/bar`: si tiene solo chi è stato chiesto.
    if (!name || !SHA.test(sha ?? '') || !patterns.includes(name)) continue
    out.set(name, { sha, at: (Number(at) || 0) * 1000, subject: (subject ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) })
  }
  return out
}

async function factsFor(root: string, head: RefInfo, remote: RefInfo | null, baseSha: string, row: BranchMapRow): Promise<Facts> {
  const none: Facts = { problem: null, mergeBase: null, mergeBaseAt: null, ahead: null, behind: null, merged: null, mergedAt: null, added: null, removed: null }
  const read = (args: string[]) => gitRead(root, args, READ_TIMEOUT_MS)
  const mergeBase = (await read(['merge-base', baseSha, head.sha]).catch(() => '')).trim()
  // Storie non correlate (o merge-base illeggibile): nessuna curva con un punto di partenza.
  if (!SHA.test(mergeBase)) return { ...none, problem: 'no_merge_base' }
  const [counts, mergeBaseAt, shortstat] = await Promise.all([
    read(['rev-list', '--left-right', '--count', `${head.sha}...${baseSha}`]).catch(() => ''),
    read(['log', '-1', '--format=%ct', mergeBase]).catch(() => ''),
    read(['diff', '--shortstat', '--no-ext-diff', '--no-textconv', '--no-renames', mergeBase, head.sha]).catch(() => null)
  ])
  const [a, b] = counts.trim().split(/\s+/).map(Number)
  const ahead = Number.isFinite(a) ? a : null
  const behind = Number.isFinite(b) ? b : null
  const facts: Facts = {
    ...none,
    mergeBase,
    mergeBaseAt: (Number(mergeBaseAt.trim()) || 0) * 1000 || null,
    ahead,
    behind,
    added: shortstat === null ? null : Number(/(\d+) insertion/.exec(shortstat)?.[1] ?? 0),
    removed: shortstat === null ? null : Number(/(\d+) deletion/.exec(shortstat)?.[1] ?? 0)
  }
  // Unito con una PR nota (squash e rebase compresi): solo se il branch non ha commit dopo la testa della PR.
  if (row.prMerged && (await coveredByPr(root, head.sha, row.prMerged.oid))) {
    return { ...facts, merged: 'pr', mergedAt: row.prMerged.at }
  }
  // Unito in git: serve la prova che il branch ha avuto commit propri (vedi `gitMergedAt`), non basta ahead 0.
  if (ahead === 0) {
    const at = await gitMergedAt(root, head, remote, baseSha, row.start)
    if (at !== null) return { ...facts, merged: 'git', mergedAt: at }
  }
  return facts
}

/**
 * Il branch è tutto nel ramo principale (ahead 0): è stato unito, o è solo "avanzato" lungo main (un pull fast-forward o un
 * `reset --hard origin/main` di un branch che non ha mai avuto commit propri, che dal grafo sono identici a un fast-forward merge)?
 * Si dichiara unito solo con una prova, altrimenti null (meglio un mancato "unito" che uno falso). Prove:
 *  1. merge commit sul ramo principale che ha HEAD come genitore NON primo (merge --no-ff, "Create a merge commit" di GitHub): data del merge;
 *  2. fast-forward: HEAD è diverso dal commit di nascita e il suo branch su origin (pubblicato dopo la nascita: discendente di `start`)
 *     è dentro il ramo principale. Un branch mai pubblicato (o con il remoto già potato) e unito in fast-forward resta null.
 * Un `reset` che butta i commit propri non lascia prove: null. Rebase-and-merge riscrive i commit (ahead > 0): lo copre solo la PR.
 */
async function gitMergedAt(root: string, head: RefInfo, remote: RefInfo | null, baseSha: string, start: string | null): Promise<number | null> {
  if (start && start === head.sha) return null
  const mergeAt = await mergeCommitAt(root, head.sha, baseSha)
  if (mergeAt !== null) return mergeAt
  if (!start || !SHA.test(start) || !remote || remote.sha === start) return null
  if ((await isAncestor(root, start, remote.sha)) && (await isAncestor(root, remote.sha, baseSha))) return head.at
  return null
}

/** `a` è `b` o un suo antenato? true/false; null se non si sa (oggetto mancante, timeout). */
async function isAncestor(root: string, a: string, b: string): Promise<boolean | null> {
  try {
    await gitRead(root, ['merge-base', '--is-ancestor', a, b], READ_TIMEOUT_MS)
    return true
  } catch (error) {
    // Uscita 1 = non è un antenato; qualunque altro errore (oggetto mancante, timeout) = non lo si sa.
    return (error as { code?: unknown }).code === 1 ? false : null
  }
}

/** HEAD è la testa della PR unita o un suo antenato? Se non si può dire (oggetto non scaricato, timeout) no: nel dubbio non unito. Senza testa nota sì, come per `merge.info`. */
async function coveredByPr(root: string, head: string, oid: string | null): Promise<boolean> {
  if (!oid || !SHA.test(oid)) return true
  return (await isAncestor(root, head, oid)) === true
}

/** Data del merge commit che ha portato `head` nel ramo principale (lo ha tra i genitori, non come primo); null se non c'è (fast-forward, rebase) o non si legge. */
async function mergeCommitAt(root: string, head: string, baseSha: string): Promise<number | null> {
  try {
    const out = await gitRead(root, ['log', '--ancestry-path', '--merges', '--format=%P %ct', `${head}..${baseSha}`], READ_TIMEOUT_MS)
    let at: number | null = null
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/)
      const time = Number(parts.pop())
      // Come primo genitore c'è il ramo principale: se HEAD è lì, è main che ha solo incluso un commit già suo.
      if (parts.indexOf(head) < 1 || !time) continue
      at = at === null ? time : Math.min(at, time)
    }
    return at === null ? null : at * 1000
  } catch {
    return null
  }
}

/** Esegue `fn` su tutti gli elementi, al massimo `limit` alla volta. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
