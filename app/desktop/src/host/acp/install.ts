// Installazione dei binari degli agenti ACP in <dati>/bin/<id> (LAD-56). Solo con checksum verificabile, versione fissata
// dal registro, nessun aggiornamento automatico: ogni installazione parte da `agents.install` con la conferma dell'utente.
// Ordine: host atteso, checksum (e conflitto con quello già visto per la stessa versione), download con limite di dimensione,
// estrazione in cartella temporanea, quarantena, firma (codesign), permesso di esecuzione al solo programma, spostamento.
// Niente viene eseguito prima della fine di queste verifiche.
import { access, chmod, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { t } from '@shared/i18n'
import type { AcpAgentSpec, AgentInstall, AgentSignature } from '@shared/protocol'
import { BlockError, codeSignature, dataDir, downloadVerified, extractArchive, githubReleaseDigest, hasQuarantine, removeTree, resolveInside, toolDir } from '../downloads'
import { CURATED, cmdPinnedOk, downloadAddress, downloadHostOk, forgetDownloadCache, hostReason, isSafeAgentId, wrongCmdReason } from './catalog'
import { binarySpec, binaryTarget, checksumSource, hasUnsafeArgs, registryEntry } from './registry'

export function agentDir(id: string): string {
  if (!isSafeAgentId(id)) throw new Error(t('Invalid agent id.'))
  return toolDir(id)
}

/**
 * File che oltre al programma devono poter essere eseguiti, per agente: percorsi espliciti relativi alla cartella dell'agente,
 * non un glob. Tutto il resto dell'archivio resta senza permessi di esecuzione. Verificato sugli archivi reali dei curati:
 * amp-acp, goose, OpenCode e Kiro sono un solo eseguibile (nessun helper). Junie è un'app con un JDK incluso: il launcher carica
 * libjli con dlopen (non lancia `java`), ma la JVM avvia `jspawnhelper` per ogni processo figlio (i comandi di shell dell'agente).
 */
const HELPERS: Record<string, string[]> = {
  junie: ['Applications/junie.app/Contents/runtime/Contents/Home/lib/jspawnhelper']
}

/** Marcatore scritto nella cartella nuova prima dello scambio: dice a quale voce registrata appartiene (nome fisso, mai eseguibile). */
const MARKER = '.ladder-version'

/** Chiave di confronto di un percorso: il disco di macOS non distingue maiuscole né forme Unicode. */
const folded = (path: string) => path.normalize('NFD').toLowerCase()

/** Rifiuta un programma o un helper che (anche via link, maiuscole o NFD) sia il marcatore: il suo contenuto verrebbe sostituito dal JSON di Ladder. */
async function assertNotMarker(fresh: string, path: string): Promise<void> {
  const real = await realpath(path)
  if (folded(real) === folded(join(await realpath(fresh), MARKER))) throw new Error(t('The registry gives an unsafe path for the program.'))
}

/** Impronta della voce registrata di un agente scaricato: versione, programma, argomenti e ambiente (non l'icona, che si legge dopo). */
export function specKey(spec: Pick<AcpAgentSpec, 'version' | 'command' | 'args' | 'env'>): string {
  return JSON.stringify([spec.version ?? null, spec.command, spec.args, Object.entries(spec.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])
}

/**
 * All'avvio: un'installazione interrotta (app chiusa, crash) può lasciare `<id>.new`, `<id>.download` o `<id>.old`. Lo scambio è
 * rename(dir, old), rename(new, dir), registrazione dell'agente (`installed`), rm(old): se la cartella dell'agente manca e c'è
 * `<id>.old` si ripristina la versione precedente. Se ci sono entrambe (chiusura prima o durante la registrazione) si guarda il marcatore
 * `<id>/.ladder-version` scritto prima dello scambio: se la sua impronta (`specKey`) è quella della voce registrata nel database la
 * registrazione è già quella nuova e si cancella `.old`; se è diversa la registrazione è ancora la vecchia e `.old` torna al posto della
 * cartella (vale anche quando il programma ha lo stesso nome nelle due versioni, tipico `./opencode`). Senza marcatore conta il programma
 * registrato (`registered`, dal database): se sta dentro la cartella ma non esiste nella versione nuova si ripristina `.old`.
 * Il ripristino usa solo rename (la cartella parziale va su `<id>.new`, poi `.old` torna al suo posto, poi si cancella il resto): non si cancella mai prima di aver rimesso a posto.
 * Il resto si cancella. Non tocca gh e codex né niente che non abbia il nome di un agente.
 */
export async function recoverInstalls(registered: (id: string) => AcpAgentSpec | null = () => null): Promise<void> {
  const bin = join(dataDir(), 'bin')
  const names = await readdir(bin).catch(() => [] as string[])
  for (const name of names) {
    const match = /^([a-z0-9][a-z0-9_-]{0,63})\.(old|new|download)$/.exec(name)
    if (!match || match[1] === 'gh' || match[1] === 'codex') continue
    const path = join(bin, name)
    const dir = join(bin, match[1])
    if (match[2] === 'old' && !names.includes(match[1])) await rename(path, dir).catch(() => undefined)
    else if (match[2] === 'old') {
      const spec = registered(match[1])
      const marker = await readFile(join(dir, MARKER), 'utf8').then(
        (text) => (JSON.parse(text) as { spec?: unknown }).spec,
        () => undefined
      )
      let lost: boolean
      if (typeof marker === 'string' && spec) lost = marker !== specKey(spec)
      else lost = spec !== null && spec.command.startsWith(dir + sep) && !(await access(spec.command).then(() => true, () => false))
      if (lost) {
        // Soli rename: la cartella parziale va sul nome `.new` (prima si libera, è un avanzo), poi la vecchia torna; il resto si cancella alla fine.
        // Se un rename fallisce non si cancella niente: il prossimo avvio riprova.
        const fresh = join(bin, `${match[1]}.new`)
        await removeTree(fresh).catch(() => undefined)
        const parked = await rename(dir, fresh).then(() => true, () => false)
        if (parked && (await rename(path, dir).then(() => true, () => false))) await removeTree(fresh).catch(() => undefined)
      } else {
        await removeTree(path).catch(() => undefined)
        await rm(join(dir, MARKER), { force: true }).catch(() => undefined)
      }
    } else await removeTree(path).catch(() => undefined)
  }
}

export class AgentInstaller {
  /** `done` finisce quando il lavoro in background è chiuso */
  private jobs = new Map<string, { abort: AbortController; state: AgentInstall; done: Promise<void>; shown: string; host: string }>()

  constructor(
    private readonly hooks: {
      /** Aggiorna lo stato (evento agent.install). */
      update: (install: AgentInstall) => void
      /** Installazione riuscita: l'host registra l'agente con la voce nuova e la firma letta da codesign. */
      installed: (spec: AcpAgentSpec, signature: AgentSignature) => Promise<void>
      /** Checksum delle versioni già scaricate (chiave: id e versione), per accorgersi che il registro cambia il checksum di una versione. */
      checksums: { get: (id: string, version: string) => string | null; set: (id: string, version: string, sha256: string) => void }
    }
  ) {}

  current(id: string): AgentInstall | null {
    const job = this.jobs.get(id)
    return job?.state.state === 'running' ? job.state : null
  }

  /**
   * Controlla la richiesta, risponde subito con lo stato e scarica in background. `sha256` e `host` sono quelli che l'utente ha
   * visto nel dialog: devono coincidere con quelli che l'host userebbe adesso, altrimenti rifiuta. Una seconda richiesta per la
   * stessa versione mentre il download è in corso riceve lo stato di quello (un solo download); per un'altra versione è un errore.
   */
  async start(id: string, version: string, confirmed: boolean, shown: string, host: string): Promise<AgentInstall> {
    if (confirmed !== true) throw new Error(t('Installing needs your confirmation.'))
    if (typeof shown !== 'string' || !/^[0-9a-f]{64}$/i.test(shown) || typeof host !== 'string' || !host) throw new Error(t('The checksum and the address shown to you are needed to install. Review the download and confirm again.'))
    const running = this.current(id)
    if (running) {
      if (running.version !== version) throw new Error(t('Another installation of this agent is already in progress ({version}). Wait for it to finish or cancel it.', { version: running.version }))
      // Checksum e indirizzo di questa conferma devono essere quelli del job in corso: se l'utente ha visto altro, la sua conferma non si ignora in silenzio.
      const job = this.jobs.get(id)
      if (job && (job.shown !== shown.toLowerCase() || job.host !== host.toLowerCase())) throw new BlockError('checksum-changed', t('The registry changed this download after you reviewed it. Review it and confirm again.'))
      return running
    }
    const dir = agentDir(id)
    const state: AgentInstall = { id, version, state: 'running', stage: 'downloading', progress: null, bytes: null, total: null, error: null, errorCode: null, signature: null }
    const abort = new AbortController()
    const job = { abort, state, done: Promise.resolve(), shown: shown.toLowerCase(), host: host.toLowerCase() }
    // Il posto si prenota prima di ogni await: due richieste insieme non partono entrambe sugli stessi file.
    this.jobs.set(id, job)
    let entry: NonNullable<Awaited<ReturnType<typeof registryEntry>>>
    let target: NonNullable<ReturnType<typeof binaryTarget>>
    let sha256: string
    try {
      const found = await registryEntry(id)
      if (!found) throw new Error(t('Agent not found in the ACP registry.'))
      if (found.version !== version) throw new Error(t('The registry now lists version {version}. Review it and confirm again.', { version: found.version }))
      if (hasUnsafeArgs(found)) throw new Error(t('The registry gives arguments or settings for this agent that Ladder does not accept.'))
      const built = binaryTarget(found)
      if (!built) throw new Error(t('No build for Apple silicon Macs.'))
      if (checksumSource(built) === 'missing') throw new BlockError('no-checksum', t('Can’t verify the download: no checksum published.'))
      // Solo https e solo dall'host atteso per questo agente (fissato per i curati, coerente con sito e repository per gli altri).
      if (!downloadHostOk(found, built.archive)) throw new BlockError('host', hostReason(built.archive))
      // Per i curati scaricabili il programma è fissato in Ladder: un `cmd` diverso (es. il `java` del JDK dentro un'app) non si installa.
      if (!cmdPinnedOk(id, built.cmd)) throw new BlockError('signature', wrongCmdReason())
      // L'indirizzo che l'utente ha visto nel dialog è quello da cui si scarica.
      if (downloadAddress(built.archive) !== host.toLowerCase()) throw new BlockError('checksum-changed', t('The registry now points this download to a different address. Review it and confirm again.'))
      // Checksum: dal registro, altrimenti dal digest della release GitHub. Senza, non si scarica. Si rilegge sempre qui (il catalogo può avere dati in cache)
      // e prima di rispondere: se non coincide con quello visto nel dialog, `agents.install` rifiuta (come per versione e indirizzo, e per un checksum in conflitto) e la UI riapre la conferma.
      forgetDownloadCache(built.archive)
      let current = built.sha256
      if (!current) {
        // Letta ma senza digest (o release sparita) = no-checksum; non letta ora (403, rete, timeout) = checksum-unavailable, transitorio. L'annullamento resta tale.
        const digest = await githubReleaseDigest(built.archive, AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])).catch((error: unknown) => {
          if (abort.signal.aborted) throw error
          throw new BlockError('checksum-unavailable', t('Can’t read the checksum right now. Try again later.'))
        })
        current = digest?.sha256
      }
      if (!current) throw new BlockError('no-checksum', t('Can’t verify the download: no checksum published.'))
      if (shown.toLowerCase() !== current.toLowerCase()) throw new BlockError('checksum-changed', t('The registry changed this download after you reviewed it. Review it and confirm again.'))
      sha256 = current.toLowerCase()
      // Stessa versione già scaricata con un altro checksum: si rifiuta qui, come gli altri blocchi, e non come evento a richiesta già accettata.
      const seen = this.hooks.checksums.get(id, found.version)
      if (seen && seen !== sha256) throw new BlockError('checksum-conflict', t('The registry now lists a different checksum for version {version}, which Ladder already downloaded. Ladder will not install it.', { version: found.version }))
      entry = found
      target = built
    } catch (caught) {
      const error = caught
      this.jobs.delete(id)
      // Annullata mentre si leggeva il checksum: è un annullamento, non un errore.
      if (abort.signal.aborted && !(error instanceof BlockError)) {
        Object.assign(state, { state: 'cancelled', stage: null })
        this.hooks.update({ ...state })
        return { ...state }
      }
      // Chi ha avuto "running" da una seconda richiesta riceve comunque l'esito.
      Object.assign(state, { state: 'error', stage: null, error: (error as Error).message, errorCode: error instanceof BlockError ? error.code : null })
      this.hooks.update({ ...state })
      throw error
    }
    // Annullata mentre si controllava il registro: non si scarica niente.
    if (abort.signal.aborted) {
      this.jobs.delete(id)
      Object.assign(state, { state: 'cancelled', stage: null })
      this.hooks.update({ ...state })
      return { ...state }
    }
    this.hooks.update({ ...state })
    job.done = this.run(id, dir, entry, target, sha256, shown, abort.signal, (patch) => {
      Object.assign(state, patch)
      this.hooks.update({ ...state })
    })
    return { ...state }
  }

  cancel(id: string): void {
    this.jobs.get(id)?.abort.abort()
  }

  /** Annulla e aspetta che il job abbia ripulito i suoi file (serve prima di toccare la cartella dell'agente). */
  async cancelAndWait(id: string): Promise<boolean> {
    const job = this.jobs.get(id)
    if (!job) return false
    job.abort.abort()
    await job.done
    return true
  }

  private async run(
    id: string,
    dir: string,
    entry: NonNullable<Awaited<ReturnType<typeof registryEntry>>>,
    target: NonNullable<ReturnType<typeof binaryTarget>>,
    sha256: string,
    shown: string,
    signal: AbortSignal,
    step: (patch: Partial<AgentInstall>) => void
  ): Promise<void> {
    const archive = `${dir}.download`
    const fresh = `${dir}.new`
    const old = `${dir}.old`
    // Stato finale: si pubblica solo dopo la pulizia dei file, altrimenti un nuovo start() potrebbe partire e il finally di questo job cancellerebbe i suoi file.
    let final: Partial<AgentInstall>
    // Vero dopo la registrazione: solo allora `.old` si può cancellare e il marcatore non serve più.
    let committed = false
    try {
      // `sha256` è già stato letto e confrontato da start(); qui resta come difesa.
      if (shown.toLowerCase() !== sha256) throw new BlockError('checksum-changed', t('The registry changed this download after you reviewed it. Review it and confirm again.'))
      // Stessa versione già scaricata con un altro checksum: il registro non è più affidabile per questa versione.
      const seen = this.hooks.checksums.get(id, entry.version)
      if (seen && seen !== sha256) throw new BlockError('checksum-conflict', t('The registry now lists a different checksum for version {version}, which Ladder already downloaded. Ladder will not install it.', { version: entry.version }))
      await downloadVerified({ url: target.archive, sha256, size: 0 }, archive, signal, (bytes, total) => step({ stage: 'downloading', bytes, total, progress: total ? Math.min(1, bytes / total) : null }))
      signal.throwIfAborted()
      step({ stage: 'installing', progress: null })
      await extractArchive(archive, fresh, target.cmd, target.archive, signal)
      signal.throwIfAborted()
      step({ stage: 'verifying' })
      if (!cmdPinnedOk(id, target.cmd)) throw new BlockError('signature', wrongCmdReason())
      // `cmd` deve restare dentro la cartella dell'agente, anche seguendo i link.
      const program = await resolveInside(fresh, target.cmd)
      await assertNotMarker(fresh, program)
      // Il download non passa da Gatekeeper; se un attributo di quarantena c'è comunque, macOS bloccherebbe l'avvio e Ladder non lo toglie da sé.
      if (await hasQuarantine(program)) throw new BlockError('quarantine', t('macOS has marked the download as quarantined, so it would not start.'))
      // Firma letta senza eseguire il programma: firmato ma non verificabile blocca, non firmato si installa e si segnala.
      // Per gli agenti curati con un team fissato in Ladder, la firma deve essere di quel team.
      const signature = await codeSignature(fresh, program, CURATED.find((c) => c.id === id)?.team)
      step({ signature })
      signal.throwIfAborted()
      // L'estrazione ha tolto l'esecuzione a ogni file: si dà solo al programma atteso e agli helper elencati per l'agente, ora che le verifiche sono passate.
      await chmod(program, 0o755)
      for (const helper of HELPERS[id] ?? []) {
        const path = await resolveInside(fresh, helper).catch(() => null)
        if (path) {
          await assertNotMarker(fresh, path)
          await chmod(path, 0o755)
        }
      }
      step({ stage: 'finishing' })
      const spec = binarySpec(entry, dir)
      if (!spec) throw new Error(t('No build for Apple silicon Macs.'))
      // Marcatore prima dello scambio: se l'app si chiude a metà, recoverInstalls sa se la voce registrata è quella di questa cartella. Prima si toglie
      // ciò che l'archivio ha messo con quel nome (anche un link: writeFile lo seguirebbe); 'wx' non scrive su niente che esista.
      await rm(join(fresh, MARKER), { recursive: true, force: true })
      await writeFile(join(fresh, MARKER), JSON.stringify({ version: entry.version, sha256, spec: specKey(spec) }), { flag: 'wx', mode: 0o644 })
      await mkdir(join(dir, '..'), { recursive: true })
      // Un `.old` rimasto da un ripristino fallito è l'unica copia se la cartella dell'agente manca: prima si rimette a posto, poi si cancella.
      if (!(await access(dir).then(() => true, () => false))) await rename(old, dir).catch(() => undefined)
      await removeTree(old)
      // Si ignora solo "non esiste" (prima installazione): con ogni altro errore (EPERM, EBUSY…) la cartella buona resta dov'è e l'installazione fallisce qui.
      let moved = false
      try {
        await rename(dir, old)
        moved = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      // Vero dopo rename(fresh, dir): solo allora `dir` è la versione nuova e il rollback la può togliere.
      let swapped = false
      try {
        await rename(fresh, dir)
        swapped = true
        // La versione vecchia si cancella solo dopo la registrazione: se questa fallisce (o l'app si chiude qui, vedi recoverInstalls) torna al suo posto.
        await this.hooks.installed(spec, signature)
      } catch (error) {
        // Rollback con soli rename (atomici, mai cancellare prima di rimettere a posto): la nuova va sul nome temporaneo `.new` (libero, lo ripulisce il finally), la vecchia torna.
        // Se un rename fallisce si lascia lo stato com'è (`.old` resta, vedi recoverInstalls).
        if (swapped) await rename(dir, fresh).then(() => (moved ? rename(old, dir) : undefined)).catch(() => undefined)
        else if (moved) await rename(old, dir).catch(() => undefined)
        throw error
      }
      committed = true
      // Il checksum di questa versione diventa il riferimento solo a installazione riuscita: se lo scrivesse il solo download, un registro compromesso
      // con un archivio malevolo bloccherebbe per sempre la versione buona. Se la scrittura fallisce l'agente è comunque installato e registrato: si logga e si va avanti.
      try {
        if (!seen) this.hooks.checksums.set(id, entry.version, sha256)
      } catch (error) {
        console.error('[host] checksum dell’agente non registrato', error instanceof Error ? error.message : error)
      }
      final = { state: 'done', stage: null, progress: 1, error: null, errorCode: null }
    } catch (error) {
      const cancelled = signal.aborted || (error as Error).name === 'AbortError'
      final = { state: cancelled ? 'cancelled' : 'error', stage: null, progress: null, error: cancelled ? null : (error as Error).message, errorCode: !cancelled && error instanceof BlockError ? error.code : null }
    } finally {
      await rm(archive, { force: true }).catch(() => undefined)
      await removeTree(fresh).catch(() => undefined)
      if (committed) {
        await removeTree(old).catch(() => undefined)
        await rm(join(dir, MARKER), { force: true }).catch(() => undefined)
      }
      // Il job si libera solo a pulizia finita, poi si pubblica l'esito.
      if (this.jobs.get(id)?.abort.signal === signal) this.jobs.delete(id)
    }
    step(final!)
  }
}
