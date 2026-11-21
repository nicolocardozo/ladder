// Collegamenti di Ladder: GitHub (gh), Claude Code e Codex. Stato, download dello strumento se manca e login dal browser.
// Ladder non legge mai token o file delle credenziali: i login li custodiscono gh, la CLI di Claude e Codex (Portachiavi / auth.json).
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { t } from '@shared/i18n'
import type { ConnectionId, ConnectionLogin, ConnectionStage, ConnectionStatus, Profile } from '@shared/protocol'
import { agentEnv } from './agents/common'
import { bundledClaudeCli, claudeEnv, claudeVersion, findClaudeCli } from './claude/environment'
import { accountEmail, accountLabel, codexEnv, codexVersion, downloadedCodexPath, findCodexCli } from './codex/environment'
import { CodexRpc } from './codex/rpc'
import { downloadedGhPath, findGh, ghAuthCheck, resetGh } from './github'
import { downloadVerified, extractBinary, latestAsset, toolDir } from './downloads'
import { customProfileId } from './profiles'

const run = promisify(execFile)

const LOGIN_TIMEOUT = 10 * 60_000
const GITHUB_DEVICE_URL = 'https://github.com/login/device'

export interface ConnectionHooks {
  publish(status: ConnectionStatus): void
  /** L'host non ha un browser: il main apre l'indirizzo. */
  openUrl(url: string): void
  /** Lo strumento o l'account sono cambiati: l'host rilegge percorso, account, modelli e limiti dell'agente (del profilo, se c'è). `reset`: dopo un logout. `probe`: rilegge account e limiti anche con `reset` (dopo uno switch di account). */
  changed(id: ConnectionId, reset: boolean, probe?: boolean, profileId?: string): Promise<void>
  /** Profili non predefiniti, per `list` e per lo stato all'avvio. */
  profiles(): Profile[]
  /** Profilo non predefinito per id; null se non esiste (rimosso). */
  profile(profileId: string): Profile | null
}

/**
 * Cosa si sta leggendo o cambiando: un collegamento e, per Claude Code e Codex, un profilo. `key` distingue gli stati
 * (`claude-code`, `claude-code:<profileId>`); `configDir` è la cartella del profilo, null per il predefinito.
 */
interface Target {
  id: ConnectionId
  profileId?: string
  key: string
  configDir: string | null
}

/** Un lavoro in corso (download o login) che si può annullare. */
interface Job {
  abort: AbortController
  child: ChildProcess | null
  rpc: CodexRpc | null
}

class Cancelled extends Error {}

const empty = (id: ConnectionId, profileId?: string): ConnectionStatus => ({ id, ...(profileId ? { profileId } : {}), state: 'missing', source: null, version: null, user: null, plan: null, email: null, login: null, error: null })

/** Stdout di un comando anche quando esce con codice diverso da zero (es. `auth status` da scollegato). */
async function output(file: string, args: string[], env: Record<string, string | undefined>, timeout = 15000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(file, args, { env, timeout, maxBuffer: 1024 * 1024 })
    return { ok: true, stdout, stderr }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return { ok: false, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
  }
}

/**
 * La CLI stampa anche l'indirizzo "manuale" (redirect a una pagina con un codice da incollare nello stdin): Ladder non ha
 * dove incollarlo, quindi si offre solo quello che torna su localhost, che la CLI ascolta da sé.
 */
function automaticLoginUrl(raw: string): boolean {
  try {
    const redirect = new URL(raw).searchParams.get('redirect_uri')
    return redirect !== null && ['localhost', '127.0.0.1'].includes(new URL(redirect).hostname)
  } catch {
    return false
  }
}

const arch = () => (process.arch === 'arm64' ? 'arm64' : 'amd64')

export class Connections {
  // Le mappe sono per chiave (collegamento + profilo, vedi Target).
  private status = new Map<string, ConnectionStatus>()
  private jobs = new Map<string, Job>()
  /** Logout in corso: una seconda richiesta riusa la stessa operazione. */
  private logouts = new Map<string, Promise<ConnectionStatus>>()
  /** Riletture in corso: una seconda richiesta per la stessa chiave riusa la prima. */
  private refreshes = new Map<string, { gen: number; op: Promise<ConnectionStatus> }>()
  /** Generazione per chiave: login e logout la incrementano, e una lettura partita prima non pubblica né si riusa. */
  private generations = new Map<string, number>()
  /** Download in corso per strumento, condivisi dai login. */
  private installs = new Map<'gh' | 'codex', Promise<void>>()

  constructor(private readonly hooks: ConnectionHooks) {}

  /** Ultimo stato noto, senza leggere niente: per lo snapshot. */
  cached(): ConnectionStatus[] {
    return [...this.status.values()]
  }

  /** Il profilo `profileId` per un collegamento: solo Claude Code e Codex ne hanno; il predefinito (assente o `default:<agent>`) non ha cartella. */
  private target(id: ConnectionId, profileId?: string): Target {
    const custom = id === 'github' ? undefined : customProfileId(profileId)
    if (!custom) return { id, key: id, configDir: null }
    const profile = this.hooks.profile(custom)
    if (!profile || profile.agent !== id) throw new Error(t('Account not found.'))
    return { id, profileId: custom, key: `${id}:${custom}`, configDir: profile.configDir }
  }

  /** Stato attuale di tutti, senza avviare nulla: GitHub, i due predefiniti e ogni profilo. */
  async list(): Promise<ConnectionStatus[]> {
    const targets = [this.target('github'), this.target('claude-code'), this.target('codex'), ...this.hooks.profiles().filter((p) => !p.isDefault).map((p) => this.target(p.agent, p.id))]
    return Promise.all(targets.map((target) => this.refreshTarget(target)))
  }

  /** Rilegge lo stato di uno; se c'è un login in corso resta quello. */
  refresh(id: ConnectionId, profileId?: string): Promise<ConnectionStatus> {
    return this.refreshTarget(this.target(id, profileId))
  }

  private refreshTarget(target: Target): Promise<ConnectionStatus> {
    const { key } = target
    if (this.jobs.has(key) || this.logouts.has(key)) return Promise.resolve(this.status.get(key) ?? empty(target.id, target.profileId))
    // Due riletture dello stesso stato condividono la stessa operazione (se della stessa generazione): un solo processo e nessuna pubblicazione fuori ordine.
    const gen = this.generation(key)
    const running = this.refreshes.get(key)
    if (running && running.gen === gen) return running.op
    const op: Promise<ConnectionStatus> = this.readAndPut(target, gen).finally(() => {
      if (this.refreshes.get(key)?.op === op) this.refreshes.delete(key)
    })
    this.refreshes.set(key, { gen, op })
    return op
  }

  private generation(key: string): number {
    return this.generations.get(key) ?? 0
  }

  /** Una lettura già partita non vale più: arriverebbe con lo stato di prima del login o del logout. */
  private invalidate(key: string): void {
    this.generations.set(key, this.generation(key) + 1)
  }

  private async readAndPut(target: Target, gen: number): Promise<ConnectionStatus> {
    const { id, key } = target
    let next: ConnectionStatus
    try {
      next = id === 'github' ? await this.readGithub() : id === 'claude-code' ? await this.readClaude(target) : await this.readCodex(target)
    } catch (error) {
      next = { ...empty(id, target.profileId), state: 'error', error: (error as Error).message }
    }
    // Nel frattempo è partito un login o un logout: il loro stato vince su questa lettura.
    if (gen !== this.generation(key)) return this.status.get(key) ?? next
    this.put(next)
    return next
  }

  /** Avvia download (se serve) e login in background; risponde subito con lo stato. */
  async login(id: ConnectionId, switchAccount = false, profileId?: string): Promise<ConnectionStatus> {
    const target = this.target(id, profileId)
    const { key } = target
    if (this.jobs.has(key) || this.logouts.has(key)) return this.status.get(key) ?? empty(id, target.profileId)
    const job: Job = { abort: new AbortController(), child: null, rpc: null }
    this.jobs.set(key, job)
    this.invalidate(key)
    const first: ConnectionStatus = { ...(this.status.get(key) ?? empty(id, target.profileId)), error: null, login: this.loginState('verifying') }
    this.put(first)
    void this.runLogin(target, job, switchAccount)
    return first
  }

  cancel(id: ConnectionId, profileId?: string): void {
    this.cancelKey(this.target(id, profileId).key)
  }

  private cancelKey(key: string): void {
    const job = this.jobs.get(key)
    if (!job) return
    job.abort.abort()
    job.child?.kill('SIGTERM')
    job.rpc?.kill()
  }

  logout(id: ConnectionId, profileId?: string): Promise<ConnectionStatus> {
    const target = this.target(id, profileId)
    const { key } = target
    const running = this.logouts.get(key)
    if (running) return running
    const op = (async () => {
      this.invalidate(key)
      this.cancelKey(key)
      await this.signOut(target)
      await this.afterChange(target, true)
    })().then(() => {
      this.logouts.delete(key)
      // Dopo il logout serve una lettura nuova, non una partita prima.
      this.invalidate(key)
      return this.refreshTarget(target)
    })
    this.logouts.set(key, op)
    return op
  }

  /** Il profilo è stato rimosso: si ferma ciò che stava facendo e si dimentica il suo stato. */
  forget(profileId: string): void {
    for (const [key, status] of [...this.status]) {
      if (status.profileId !== profileId) continue
      this.invalidate(key)
      this.cancelKey(key)
      this.status.delete(key)
    }
  }

  shutdown(): void {
    for (const key of this.jobs.keys()) this.cancelKey(key)
  }

  // ── Lettura dello stato ───────────────────────────────────────────────────

  private async readGithub(): Promise<ConnectionStatus> {
    // Se l'utente ha installato gh a Ladder aperto, va ritrovato prima di scaricarne una seconda copia.
    resetGh()
    const path = await findGh()
    if (!path) return empty('github')
    const env = await agentEnv([], { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' })
    const version = /gh version (\S+)/.exec((await output(path, ['--version'], env, 10000)).stdout)?.[1] ?? null
    const base: ConnectionStatus = { ...empty('github'), source: path === downloadedGhPath() ? 'downloaded' : 'system', version }
    // Senza rete gh esce non zero come se non fosse collegato: la classificazione sta in ghAuthCheck.
    const auth = await ghAuthCheck(path, env)
    if (auth === 'unauthenticated') return { ...base, state: 'unauthenticated' }
    if (auth === 'error') return { ...base, state: 'error', error: t('Could not check the GitHub login. Check your connection.') }
    // Chi sei lo dice l'API di GitHub: il token lo usa gh, Ladder non lo vede.
    const me = await output(path, ['api', 'user'], env, 10000)
    let profile: { login?: string; name?: string | null; email?: string | null } = {}
    try {
      profile = JSON.parse(me.stdout)
    } catch {
      // Collegato ma senza dettagli: lo stato resta "collegato".
    }
    return { ...base, state: 'connected', user: profile.login ?? null, email: profile.email ?? null }
  }

  private async readClaude({ profileId, configDir }: Target): Promise<ConnectionStatus> {
    const cli = await findClaudeCli()
    if (!cli) return empty('claude-code', profileId)
    const base: ConnectionStatus = { ...empty('claude-code', profileId), source: cli === bundledClaudeCli() ? 'bundled' : 'system', version: await claudeVersion(cli) }
    const { stdout } = await output(cli, ['auth', 'status', '--json'], claudeEnv(configDir))
    let info: { loggedIn?: boolean; email?: string | null; subscriptionType?: string | null } | null = null
    try {
      info = JSON.parse(stdout)
    } catch {
      info = null
    }
    // Senza JSON (timeout, CLI rotta) non si sa se l'accesso c'è: errore, che non blocca il composer.
    if (!info) return { ...base, state: 'error', error: t('Can’t read the Claude Code login status.') }
    if (!info.loggedIn) return { ...base, state: 'unauthenticated' }
    const plan = info.subscriptionType ? info.subscriptionType.charAt(0).toUpperCase() + info.subscriptionType.slice(1) : null
    return { ...base, state: 'connected', plan, email: info.email ?? null }
  }

  private async readCodex({ profileId, configDir }: Target): Promise<ConnectionStatus> {
    const cli = await findCodexCli()
    if (!cli) return empty('codex', profileId)
    const version = await codexVersion(cli)
    const base: ConnectionStatus = { ...empty('codex', profileId), source: cli === downloadedCodexPath() ? 'downloaded' : 'system', version }
    const rpc = this.codexRpc(cli, await codexEnv(configDir), () => undefined)
    try {
      await rpc.initialize(version ?? '0.0.0')
      const { account } = await rpc.request<{ account: Record<string, unknown> | null }>('account/read', { refreshToken: false }, 15000)
      if (!account) return { ...base, state: 'unauthenticated' }
      return { ...base, state: 'connected', plan: this.codexPlan(account), email: accountEmail(account) }
    } finally {
      rpc.kill()
    }
  }

  private codexPlan(account: Record<string, unknown>): string | null {
    return accountLabel(account)?.replace(/^ChatGPT\s+/, '') ?? null
  }

  private codexRpc(cli: string, env: Record<string, string>, onNotification: (method: string, params: Record<string, unknown>) => void): CodexRpc {
    return new CodexRpc(cli, env, onNotification, async () => ({ error: { code: -32601, message: t('unexpected') } }))
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  private async runLogin(target: Target, job: Job, switchAccount: boolean): Promise<void> {
    const { id, key } = target
    const signal = job.abort.signal
    let signedOut = false
    try {
      await this.ensureTool(target, job)
      signal.throwIfAborted()
      if (switchAccount) {
        signedOut = true
        await this.signOut(target)
        signal.throwIfAborted()
      }
      this.step(target, { stage: 'waiting-browser' })
      if (id === 'github') await this.loginGithub(job, target)
      else if (id === 'claude-code') await this.loginClaude(job, target)
      else await this.loginCodex(job, target)
      signal.throwIfAborted()
      this.step(target, { stage: 'finishing', url: null, code: null })
      await this.afterChange(target, signedOut, true)
      // Un logout arrivato nell'attesa passa dal catch: la riga resta scollegata di proposito.
      signal.throwIfAborted()
      this.jobs.delete(key)
      if (this.gone(target)) return
      this.invalidate(key)
      const status = await this.refreshTarget(target)
      // Se nel frattempo è arrivato un logout, refresh ha restituito lo stato in cache: il login non c'è più.
      if (status.state !== 'connected') this.put({ ...status, login: null, error: status.state === 'error' ? status.error : t('Login did not complete.') })
      else this.put({ ...status, login: null, error: null })
    } catch (error) {
      this.jobs.delete(key)
      // Profilo rimosso nel frattempo: niente da rileggere né da pubblicare.
      if (this.gone(target)) return
      // Il vecchio account è già uscito: l'agente deve dimenticare account, piano e limiti.
      if (signedOut) await this.afterChange(target, true)
      this.invalidate(key)
      const status = await this.refreshTarget(target)
      // Un annullamento voluto non è un errore.
      this.put({ ...status, login: null, error: error instanceof Cancelled || signal.aborted ? null : (error as Error).message })
    }
  }

  /** Il profilo del collegamento è stato rimosso. */
  private gone(target: Target): boolean {
    return Boolean(target.profileId) && !this.hooks.profile(target.profileId!)
  }

  /**
   * Si assicura che lo strumento ci sia. Il download di gh e Codex è uno solo per strumento: login di profili diversi
   * aspettano la stessa promessa (stesso archivio e stessa cartella di estrazione); se chi scaricava annulla, si riprova.
   */
  private async ensureTool(target: Target, job: Job): Promise<void> {
    const { id } = target
    const signal = job.abort.signal
    while (!(await this.hasTool(id))) {
      signal.throwIfAborted()
      if (id === 'claude-code') return this.install(target, job)
      const name = id === 'github' ? 'gh' : 'codex'
      let shared = this.installs.get(name)
      const owner = !shared
      if (!shared) {
        const created: Promise<void> = this.install(target, job).finally(() => {
          if (this.installs.get(name) === created) this.installs.delete(name)
        })
        shared = created
        this.installs.set(name, created)
      }
      let stop = () => {}
      const aborted = new Promise<never>((_, reject) => {
        stop = () => reject(new Cancelled())
        if (signal.aborted) stop()
        else signal.addEventListener('abort', stop, { once: true })
      })
      try {
        await Promise.race([shared, aborted])
        // Scaricato: un solo giro. Se lo strumento ancora non si trova (percorso di prova sbagliato) il login prosegue e dà il suo errore.
        return
      } catch (error) {
        // Se chi scaricava ha annullato non è un errore nostro: si riprova, scaricando noi. Ogni altro errore si rilancia.
        const cancelled = error instanceof Cancelled || (error as Error).name === 'AbortError'
        if (owner || signal.aborted || !cancelled) throw error
      } finally {
        signal.removeEventListener('abort', stop)
      }
    }
  }

  private async hasTool(id: ConnectionId): Promise<boolean> {
    if (id === 'github') return Boolean(await findGh())
    if (id === 'claude-code') return Boolean(await findClaudeCli())
    return Boolean(await findCodexCli())
  }

  /** gh e Codex si scaricano nella cartella dati; Claude Code arriva già dentro Ladder. */
  private async install(link: Target, job: Job): Promise<void> {
    const { id } = link
    if (id === 'claude-code') throw new Error(t('Claude Code is not included in this build of Ladder.'))
    const signal = job.abort.signal
    signal.throwIfAborted()
    this.step(link, { stage: 'downloading', progress: null, bytes: null, total: null })
    const isGh = id === 'github'
    const asset = isGh
      ? await latestAsset('cli/cli', (tag) => `gh_${tag.slice(1)}_macOS_${arch()}.zip`, signal, (tag) => `gh_${tag.slice(1)}_checksums.txt`)
      : await latestAsset('openai/codex', () => `codex-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin.tar.gz`, signal)
    signal.throwIfAborted()
    const archive = `${toolDir(isGh ? 'gh' : 'codex')}/download.${isGh ? 'zip' : 'tar.gz'}`
    await downloadVerified(asset, archive, signal, (bytes, total) => this.step(link, { stage: 'downloading', bytes, total, progress: total ? Math.min(1, bytes / total) : null }))
    signal.throwIfAborted()
    this.step(link, { stage: 'installing', progress: null })
    const target = isGh ? downloadedGhPath() : downloadedCodexPath()
    await extractBinary(archive, target, isGh ? (p) => p.endsWith('/bin/gh') : (p) => basename(p).startsWith('codex') && !basename(p).includes('.'))
    signal.throwIfAborted()
    this.step(link, { stage: 'verifying' })
    const version = (await run(target, ['--version'], { timeout: 15000, env: await agentEnv() }).catch(() => null))?.stdout
    signal.throwIfAborted()
    if (!version) throw new Error(t('The downloaded program does not start. Try again.'))
    // La rilettura dell'agente la fa afterChange, a fine login.
    if (isGh) resetGh()
  }

  /** `gh auth login --web`: gh stampa un codice monouso; il browser lo apre Ladder (GH_BROWSER neutralizza quello di gh). */
  private async loginGithub(job: Job, target: Target): Promise<void> {
    const path = await findGh()
    if (!path) throw new Error(t('gh is not installed'))
    const env = await agentEnv([], { GH_BROWSER: '/usr/bin/true', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' })
    job.abort.signal.throwIfAborted()
    const child = spawn(path, ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    job.child = child
    // Se gh chiude lo stdin prima della scrittura (EPIPE) non deve cadere l'host.
    child.stdin.on('error', () => undefined)
    let seen = ''
    let answered = false
    const tail: string[] = []
    const onData = (chunk: Buffer) => {
      const text = chunk.toString()
      seen += text
      for (const line of text.split('\n')) if (line.trim()) tail.push(line.trim())
      if (!answered && /Press Enter/i.test(seen)) {
        answered = true
        child.stdin.write('\n')
      }
      const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(seen)?.[1]
      if (code && !this.status.get(target.key)?.login?.code) {
        this.step(target, { stage: 'waiting-browser', code, url: GITHUB_DEVICE_URL })
        this.hooks.openUrl(GITHUB_DEVICE_URL)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const code = await this.exit(child, job)
    if (code !== 0) throw new Error(tail.filter((l) => !/one-time code|Press Enter/i.test(l)).pop()?.slice(0, 200) || t('Login did not complete.'))
    resetGh()
  }

  /** `claude auth login --claudeai`: la CLI apre il browser da sé; l'indirizzo che stampa si offre come ripiego. */
  private async loginClaude(job: Job, target: Target): Promise<void> {
    const cli = await findClaudeCli()
    if (!cli) throw new Error(t('Claude Code is not included in this build of Ladder.'))
    job.abort.signal.throwIfAborted()
    const child = spawn(cli, ['auth', 'login', '--claudeai'], { env: claudeEnv(target.configDir) as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    job.child = child
    child.stdin.on('error', () => undefined)
    let seen = ''
    const onData = (chunk: Buffer) => {
      seen += chunk.toString()
      const url = [...seen.matchAll(/https:\/\/[^\s"'<>]+(?=\s)/g)].map((m) => m[0]).find(automaticLoginUrl)
      if (url && !this.status.get(target.key)?.login?.url) this.step(target, { stage: 'waiting-browser', url })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    // Il testo della CLI può contenere l'indirizzo di accesso con i suoi parametri: non finisce in errori o log.
    if ((await this.exit(child, job)) !== 0) throw new Error(t('Login did not complete.'))
  }

  /** L'app-server di Codex ha il login ChatGPT integrato: restituisce authUrl e poi notifica account/login/completed. */
  private async loginCodex(job: Job, target: Target): Promise<void> {
    const cli = await findCodexCli()
    if (!cli) throw new Error(t('Codex not found.'))
    const signal = job.abort.signal
    signal.throwIfAborted()
    let finish: (result: { success: boolean; error: string | null }) => void = () => undefined
    const done = new Promise<{ success: boolean; error: string | null }>((resolve) => (finish = resolve))
    const env = await codexEnv(target.configDir)
    signal.throwIfAborted()
    const rpc = this.codexRpc(cli, env, (method, params) => {
      if (method === 'account/login/completed') finish({ success: params.success === true, error: typeof params.error === 'string' ? params.error : null })
    })
    job.rpc = rpc
    // Se l'app-server si chiude prima della fine, il login è fallito.
    void rpc.exited.then(() => finish({ success: false, error: null }))
    let loginId: string | null = null
    try {
      await rpc.initialize((await codexVersion(cli)) ?? '0.0.0')
      signal.throwIfAborted()
      const started = await rpc.request<{ authUrl?: string; loginId?: string }>('account/login/start', { type: 'chatgpt' }, 30000)
      signal.throwIfAborted()
      if (!started.authUrl) throw new Error(t('Login did not complete.'))
      loginId = started.loginId ?? null
      this.step(target, { stage: 'waiting-browser', url: started.authUrl })
      this.hooks.openUrl(started.authUrl)
      const timer = setTimeout(() => finish({ success: false, error: t('Login timed out.') }), LOGIN_TIMEOUT)
      let onAbort: () => void = () => undefined
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Cancelled())
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      const result = await Promise.race([done, aborted]).finally(() => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      })
      if (!result.success) throw new Error(result.error || t('Login did not complete.'))
    } catch (error) {
      if (loginId && !rpc.isClosed) await rpc.request('account/login/cancel', { loginId }, 3000).catch(() => undefined)
      throw error
    } finally {
      rpc.kill()
    }
  }

  /** Aspetta la fine del processo di login, con annullamento e tempo massimo. */
  private async exit(child: ChildProcess, job: Job): Promise<number | null> {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, LOGIN_TIMEOUT)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('exit', (c) => resolve(c))
      })
      if (job.abort.signal.aborted) throw new Cancelled()
      if (timedOut) throw new Error(t('Login timed out.'))
      return code
    } finally {
      clearTimeout(timer)
    }
  }

  private async signOut({ id, configDir }: Target): Promise<void> {
    try {
      if (id === 'github') {
        const path = await findGh()
        if (path) await output(path, ['auth', 'logout', '--hostname', 'github.com'], await agentEnv([], { GH_PROMPT_DISABLED: '1' }))
        resetGh()
      } else if (id === 'claude-code') {
        const cli = await findClaudeCli()
        if (cli) await output(cli, ['auth', 'logout'], claudeEnv(configDir))
      } else {
        const cli = await findCodexCli()
        if (!cli) return
        const rpc = this.codexRpc(cli, await codexEnv(configDir), () => undefined)
        try {
          await rpc.initialize((await codexVersion(cli)) ?? '0.0.0')
          await rpc.request('account/logout', undefined, 15000)
        } finally {
          rpc.kill()
        }
      }
    } catch {
      // L'esito vero lo dice la rilettura dello stato.
    }
  }

  // ── Stato e avanzamento ───────────────────────────────────────────────────

  private async afterChange({ id, profileId }: Target, reset: boolean, probe = !reset): Promise<void> {
    if (id === 'github') resetGh()
    await this.hooks.changed(id, reset, probe, profileId).catch(() => undefined)
  }

  private loginState(stage: ConnectionStage): ConnectionLogin {
    return { stage, progress: null, bytes: null, total: null, url: null, code: null }
  }

  /** Aggiorna il login in corso e lo pubblica. */
  private step(target: Target, patch: Partial<ConnectionLogin>): void {
    const current = this.status.get(target.key) ?? empty(target.id, target.profileId)
    this.put({ ...current, login: { ...(current.login ?? this.loginState('verifying')), ...patch } })
  }

  private put(status: ConnectionStatus): void {
    // Uno stato di un profilo rimosso non deve ricomparire (login annullato o lettura in volo).
    if (status.profileId && !this.hooks.profile(status.profileId)) return
    this.status.set(status.profileId ? `${status.id}:${status.profileId}` : status.id, status)
    this.hooks.publish(status)
  }
}
