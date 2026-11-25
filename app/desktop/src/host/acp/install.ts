// Installation of ACP agent binaries into <data>/bin/<id>. Only with a verifiable checksum, version pinned
// by the registry, no automatic updates: every install starts from `agents.install` with the user's confirmation.
// Order: expected host, checksum (and conflict with the one already seen for the same version), download with a size limit,
// extraction into a temporary folder, quarantine, signature (codesign), execute permission on the program only, move.
// Nothing is executed before these checks are done.
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
 * Files that besides the program must be executable, per agent: explicit paths relative to the agent's folder,
 * not a glob. Everything else in the archive stays without execute permission. Verified on the real archives of the curated agents:
 * amp-acp, goose, OpenCode and Kiro are a single executable (no helper). Junie is an app with a bundled JDK: the launcher loads
 * libjli with dlopen (it doesn't launch `java`), but the JVM starts `jspawnhelper` for every child process (the agent's shell commands).
 */
const HELPERS: Record<string, string[]> = {
  junie: ['Applications/junie.app/Contents/runtime/Contents/Home/lib/jspawnhelper']
}

/** Marker written in the new folder before the swap: says which registered entry it belongs to (fixed name, never executable). */
const MARKER = '.ladder-version'

/** Comparison key for a path: macOS disks are case-insensitive and don't distinguish Unicode forms. */
const folded = (path: string) => path.normalize('NFD').toLowerCase()

/** Rejects a program or helper that (even via link, case or NFD) is the marker: its content would be replaced by Ladder's JSON. */
async function assertNotMarker(fresh: string, path: string): Promise<void> {
  const real = await realpath(path)
  if (folded(real) === folded(join(await realpath(fresh), MARKER))) throw new Error(t('The registry gives an unsafe path for the program.'))
}

/** Fingerprint of a downloaded agent's registered entry: version, program, arguments and environment (not the icon, which is read later). */
export function specKey(spec: Pick<AcpAgentSpec, 'version' | 'command' | 'args' | 'env'>): string {
  return JSON.stringify([spec.version ?? null, spec.command, spec.args, Object.entries(spec.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])
}

/**
 * At startup: an interrupted install (app closed, crash) may leave `<id>.new`, `<id>.download` or `<id>.old`. The swap is
 * rename(dir, old), rename(new, dir), agent registration (`installed`), rm(old): if the agent's folder is missing and `<id>.old`
 * exists, the previous version is restored. If both exist (closed before or during registration) look at the marker
 * `<id>/.ladder-version` written before the swap: if its fingerprint (`specKey`) matches the entry registered in the database, the
 * registration is already the new one and `.old` is deleted; if different, the registration is still the old one and `.old` goes back in place of the
 * folder (also when the program has the same name in both versions, typically `./opencode`). Without a marker, the registered program
 * counts (`registered`, from the database): if it is inside the folder but doesn't exist in the new version, `.old` is restored.
 * The restore uses only rename (the partial folder goes to `<id>.new`, then `.old` goes back in place, then the rest is deleted): nothing is ever deleted before things are put back.
 * The rest is deleted. It doesn't touch gh and codex or anything that isn't named after an agent.
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
        // Renames only: the partial folder goes to the `.new` name (freed first, it is a leftover), then the old one comes back; the rest is deleted at the end.
        // If a rename fails nothing is deleted: the next startup retries.
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
  /** `done` resolves when the background work is finished */
  private jobs = new Map<string, { abort: AbortController; state: AgentInstall; done: Promise<void>; shown: string; host: string }>()

  constructor(
    private readonly hooks: {
      /** Updates the state (agent.install event). */
      update: (install: AgentInstall) => void
      /** Install succeeded: the host registers the agent with the new entry and the signature read by codesign. */
      installed: (spec: AcpAgentSpec, signature: AgentSignature) => Promise<void>
      /** Checksums of the versions already downloaded (key: id and version), to notice when the registry changes a version's checksum. */
      checksums: { get: (id: string, version: string) => string | null; set: (id: string, version: string, sha256: string) => void }
    }
  ) {}

  current(id: string): AgentInstall | null {
    const job = this.jobs.get(id)
    return job?.state.state === 'running' ? job.state : null
  }

  /**
   * Checks the request, replies right away with the state and downloads in the background. `sha256` and `host` are the ones the user
   * saw in the dialog: they must match what the host would use now, otherwise it refuses. A second request for the
   * same version while the download is running gets that download's state (a single download); for another version it is an error.
   */
  async start(id: string, version: string, confirmed: boolean, shown: string, host: string): Promise<AgentInstall> {
    if (confirmed !== true) throw new Error(t('Installing needs your confirmation.'))
    if (typeof shown !== 'string' || !/^[0-9a-f]{64}$/i.test(shown) || typeof host !== 'string' || !host) throw new Error(t('The checksum and the address shown to you are needed to install. Review the download and confirm again.'))
    const running = this.current(id)
    if (running) {
      if (running.version !== version) throw new Error(t('Another installation of this agent is already in progress ({version}). Wait for it to finish or cancel it.', { version: running.version }))
      // Checksum and address of this confirmation must be those of the running job: if the user saw something else, their confirmation is not silently ignored.
      const job = this.jobs.get(id)
      if (job && (job.shown !== shown.toLowerCase() || job.host !== host.toLowerCase())) throw new BlockError('checksum-changed', t('The registry changed this download after you reviewed it. Review it and confirm again.'))
      return running
    }
    const dir = agentDir(id)
    const state: AgentInstall = { id, version, state: 'running', stage: 'downloading', progress: null, bytes: null, total: null, error: null, errorCode: null, signature: null }
    const abort = new AbortController()
    const job = { abort, state, done: Promise.resolve(), shown: shown.toLowerCase(), host: host.toLowerCase() }
    // The slot is reserved before any await: two simultaneous requests must not both start on the same files.
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
      // Only https and only from the host expected for this agent (pinned for curated ones, consistent with site and repository for the others).
      if (!downloadHostOk(found, built.archive)) throw new BlockError('host', hostReason(built.archive))
      // For downloadable curated agents the program is pinned in Ladder: a different `cmd` (e.g. the `java` of a JDK inside an app) is not installed.
      if (!cmdPinnedOk(id, built.cmd)) throw new BlockError('signature', wrongCmdReason())
      // The address the user saw in the dialog is the one to download from.
      if (downloadAddress(built.archive) !== host.toLowerCase()) throw new BlockError('checksum-changed', t('The registry now points this download to a different address. Review it and confirm again.'))
      // Checksum: from the registry, otherwise from the GitHub release digest. Without it, no download. Always reread here (the catalog may have cached data)
      // and before replying: if it doesn't match the one seen in the dialog, `agents.install` refuses (as for version and address, and for a conflicting checksum) and the UI reopens the confirmation.
      forgetDownloadCache(built.archive)
      let current = built.sha256
      if (!current) {
        // Read but without digest (or release gone) = no-checksum; not read now (403, network, timeout) = checksum-unavailable, transient. A cancellation stays a cancellation.
        const digest = await githubReleaseDigest(built.archive, AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])).catch((error: unknown) => {
          if (abort.signal.aborted) throw error
          throw new BlockError('checksum-unavailable', t('Can’t read the checksum right now. Try again later.'))
        })
        current = digest?.sha256
      }
      if (!current) throw new BlockError('no-checksum', t('Can’t verify the download: no checksum published.'))
      if (shown.toLowerCase() !== current.toLowerCase()) throw new BlockError('checksum-changed', t('The registry changed this download after you reviewed it. Review it and confirm again.'))
      sha256 = current.toLowerCase()
      // Same version already downloaded with a different checksum: refuse here, like the other blocks, and not as an event after the request was accepted.
      const seen = this.hooks.checksums.get(id, found.version)
      if (seen && seen !== sha256) throw new BlockError('checksum-conflict', t('The registry now lists a different checksum for version {version}, which Ladder already downloaded. Ladder will not install it.', { version: found.version }))
      entry = found
      target = built
    } catch (caught) {
      const error = caught
      this.jobs.delete(id)
      // Cancelled while reading the checksum: it is a cancellation, not an error.
      if (abort.signal.aborted && !(error instanceof BlockError)) {
        Object.assign(state, { state: 'cancelled', stage: null })
        this.hooks.update({ ...state })
        return { ...state }
      }
      // Whoever got "running" from a second request still receives the outcome.
      Object.assign(state, { state: 'error', stage: null, error: (error as Error).message, errorCode: error instanceof BlockError ? error.code : null })
      this.hooks.update({ ...state })
      throw error
    }
    // Cancelled while checking the registry: nothing is downloaded.
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

  /** Cancels and waits for the job to clean up its files (needed before touching the agent's folder). */
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
    // Final state: published only after the files are cleaned up, otherwise a new start() could begin and this job's finally would delete its files.
    let final: Partial<AgentInstall>
    // True after registration: only then `.old` can be deleted and the marker is no longer needed.
    let committed = false
    try {
      // `sha256` was already read and compared by start(); it remains here as a safeguard.
      if (shown.toLowerCase() !== sha256) throw new BlockError('checksum-changed', t('The registry changed this download after you reviewed it. Review it and confirm again.'))
      // Same version already downloaded with a different checksum: the registry is no longer trustworthy for this version.
      const seen = this.hooks.checksums.get(id, entry.version)
      if (seen && seen !== sha256) throw new BlockError('checksum-conflict', t('The registry now lists a different checksum for version {version}, which Ladder already downloaded. Ladder will not install it.', { version: entry.version }))
      await downloadVerified({ url: target.archive, sha256, size: 0 }, archive, signal, (bytes, total) => step({ stage: 'downloading', bytes, total, progress: total ? Math.min(1, bytes / total) : null }))
      signal.throwIfAborted()
      step({ stage: 'installing', progress: null })
      await extractArchive(archive, fresh, target.cmd, target.archive, signal)
      signal.throwIfAborted()
      step({ stage: 'verifying' })
      if (!cmdPinnedOk(id, target.cmd)) throw new BlockError('signature', wrongCmdReason())
      // `cmd` must stay inside the agent's folder, even following links.
      const program = await resolveInside(fresh, target.cmd)
      await assertNotMarker(fresh, program)
      // The download doesn't go through Gatekeeper; if a quarantine attribute is there anyway, macOS would block the launch and Ladder doesn't remove it on its own.
      if (await hasQuarantine(program)) throw new BlockError('quarantine', t('macOS has marked the download as quarantined, so it would not start.'))
      // Signature read without running the program: signed but not verifiable blocks, unsigned is installed and flagged.
      // For curated agents with a team pinned in Ladder, the signature must be from that team.
      const signature = await codeSignature(fresh, program, CURATED.find((c) => c.id === id)?.team)
      step({ signature })
      signal.throwIfAborted()
      // Extraction removed execute permission from every file: it is given only to the expected program and the helpers listed for the agent, now that the checks passed.
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
      // Marker before the swap: if the app closes midway, recoverInstalls knows whether the registered entry is this folder's. First remove
      // whatever the archive put under that name (even a link: writeFile would follow it); 'wx' doesn't write over anything that exists.
      await rm(join(fresh, MARKER), { recursive: true, force: true })
      await writeFile(join(fresh, MARKER), JSON.stringify({ version: entry.version, sha256, spec: specKey(spec) }), { flag: 'wx', mode: 0o644 })
      await mkdir(join(dir, '..'), { recursive: true })
      // A `.old` left by a failed restore is the only copy if the agent's folder is missing: first put it back, then delete.
      if (!(await access(dir).then(() => true, () => false))) await rename(old, dir).catch(() => undefined)
      await removeTree(old)
      // Only "doesn't exist" is ignored (first install): with any other error (EPERM, EBUSY…) the good folder stays where it is and the install fails here.
      let moved = false
      try {
        await rename(dir, old)
        moved = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      // True after rename(fresh, dir): only then is `dir` the new version and the rollback may remove it.
      let swapped = false
      try {
        await rename(fresh, dir)
        swapped = true
        // The old version is deleted only after registration: if that fails (or the app closes here, see recoverInstalls) it goes back in place.
        await this.hooks.installed(spec, signature)
      } catch (error) {
        // Rollback with renames only (atomic, never delete before putting things back): the new one goes to the temporary `.new` name (free, the finally cleans it up), the old one comes back.
        // If a rename fails the state is left as is (`.old` stays, see recoverInstalls).
        if (swapped) await rename(dir, fresh).then(() => (moved ? rename(old, dir) : undefined)).catch(() => undefined)
        else if (moved) await rename(old, dir).catch(() => undefined)
        throw error
      }
      committed = true
      // This version's checksum becomes the reference only after a successful install: if the download alone wrote it, a compromised registry
      // with a malicious archive would block the good version forever. If the write fails the agent is still installed and registered: log it and move on.
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
      // The job frees itself only when cleanup is done, then the outcome is published.
      if (this.jobs.get(id)?.abort.signal === signal) this.jobs.delete(id)
    }
    step(final!)
  }
}
