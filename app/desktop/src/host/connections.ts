// Ladder connections: GitHub (gh), Claude Code and Codex. State, tool download if missing, and browser login.
// Ladder never reads tokens or credential files: logins are kept by gh, the Claude CLI and Codex (Keychain / auth.json).
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
  /** The host has no browser: main opens the address. */
  openUrl(url: string): void
  /** The tool or the account changed: the host rereads the agent's path, account, models and limits (of the profile, if any). `reset`: after a logout. `probe`: rereads account and limits even with `reset` (after an account switch). */
  changed(id: ConnectionId, reset: boolean, probe?: boolean, profileId?: string): Promise<void>
  /** Non-default profiles, for `list` and for the state at startup. */
  profiles(): Profile[]
  /** Non-default profile by id; null if it doesn't exist (removed). */
  profile(profileId: string): Profile | null
}

/**
 * What is being read or changed: a connection and, for Claude Code and Codex, a profile. `key` tells the states apart
 * (`claude-code`, `claude-code:<profileId>`); `configDir` is the profile's folder, null for the default.
 */
interface Target {
  id: ConnectionId
  profileId?: string
  key: string
  configDir: string | null
}

/** A job in progress (download or login) that can be cancelled. */
interface Job {
  abort: AbortController
  child: ChildProcess | null
  rpc: CodexRpc | null
}

class Cancelled extends Error {}

const empty = (id: ConnectionId, profileId?: string): ConnectionStatus => ({ id, ...(profileId ? { profileId } : {}), state: 'missing', source: null, version: null, user: null, plan: null, email: null, login: null, error: null })

/** Stdout of a command even when it exits with a non-zero code (e.g. `auth status` when signed out). */
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
 * The CLI also prints the "manual" address (redirect to a page with a code to paste into stdin): Ladder has nowhere
 * to paste it, so only the one that comes back to localhost, which the CLI listens on by itself, is offered.
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
  // The maps are keyed (connection + profile, see Target).
  private status = new Map<string, ConnectionStatus>()
  private jobs = new Map<string, Job>()
  /** Logout in progress: a second request reuses the same operation. */
  private logouts = new Map<string, Promise<ConnectionStatus>>()
  /** Rereads in progress: a second request for the same key reuses the first. */
  private refreshes = new Map<string, { gen: number; op: Promise<ConnectionStatus> }>()
  /** Generation per key: login and logout increment it, and a read started earlier neither publishes nor is reused. */
  private generations = new Map<string, number>()
  /** Downloads in progress per tool, shared by the logins. */
  private installs = new Map<'gh' | 'codex', Promise<void>>()

  constructor(private readonly hooks: ConnectionHooks) {}

  /** Last known state, without reading anything: for the snapshot. */
  cached(): ConnectionStatus[] {
    return [...this.status.values()]
  }

  /** Profile `profileId` for a connection: only Claude Code and Codex have them; the default (absent or `default:<agent>`) has no folder. */
  private target(id: ConnectionId, profileId?: string): Target {
    const custom = id === 'github' ? undefined : customProfileId(profileId)
    if (!custom) return { id, key: id, configDir: null }
    const profile = this.hooks.profile(custom)
    if (!profile || profile.agent !== id) throw new Error(t('Account not found.'))
    return { id, profileId: custom, key: `${id}:${custom}`, configDir: profile.configDir }
  }

  /** Current state of all, without starting anything: GitHub, the two defaults and every profile. */
  async list(): Promise<ConnectionStatus[]> {
    const targets = [this.target('github'), this.target('claude-code'), this.target('codex'), ...this.hooks.profiles().filter((p) => !p.isDefault).map((p) => this.target(p.agent, p.id))]
    return Promise.all(targets.map((target) => this.refreshTarget(target)))
  }

  /** Rereads the state of one; if a login is in progress, that stays. */
  refresh(id: ConnectionId, profileId?: string): Promise<ConnectionStatus> {
    return this.refreshTarget(this.target(id, profileId))
  }

  private refreshTarget(target: Target): Promise<ConnectionStatus> {
    const { key } = target
    if (this.jobs.has(key) || this.logouts.has(key)) return Promise.resolve(this.status.get(key) ?? empty(target.id, target.profileId))
    // Two rereads of the same state share the same operation (if of the same generation): a single process and no out-of-order publishing.
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

  /** A read already started is no longer valid: it would arrive with the state from before the login or logout. */
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
    // A login or logout started in the meantime: their state wins over this read.
    if (gen !== this.generation(key)) return this.status.get(key) ?? next
    this.put(next)
    return next
  }

  /** Starts download (if needed) and login in the background; answers at once with the state. */
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
      // After the logout a fresh read is needed, not one started earlier.
      this.invalidate(key)
      return this.refreshTarget(target)
    })
    this.logouts.set(key, op)
    return op
  }

  /** The profile was removed: whatever it was doing stops and its state is forgotten. */
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

  // ── Reading the state ─────────────────────────────────────────────────────

  private async readGithub(): Promise<ConnectionStatus> {
    // If the user installed gh while Ladder was open, it must be found again before downloading a second copy.
    resetGh()
    const path = await findGh()
    if (!path) return empty('github')
    const env = await agentEnv([], { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' })
    const version = /gh version (\S+)/.exec((await output(path, ['--version'], env, 10000)).stdout)?.[1] ?? null
    const base: ConnectionStatus = { ...empty('github'), source: path === downloadedGhPath() ? 'downloaded' : 'system', version }
    // Without a network gh exits non-zero as if it weren't connected: the classification is in ghAuthCheck.
    const auth = await ghAuthCheck(path, env)
    if (auth === 'unauthenticated') return { ...base, state: 'unauthenticated' }
    if (auth === 'error') return { ...base, state: 'error', error: t('Could not check the GitHub login. Check your connection.') }
    // Who you are is told by the GitHub API: gh uses the token, Ladder doesn't see it.
    const me = await output(path, ['api', 'user'], env, 10000)
    let profile: { login?: string; name?: string | null; email?: string | null } = {}
    try {
      profile = JSON.parse(me.stdout)
    } catch {
      // Connected but without details: the state stays "connected".
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
    // Without JSON (timeout, broken CLI) we can't tell whether access exists: error, which doesn't block the composer.
    if (!info) return { ...base, state: 'error', error: t('Can’t read the Claude login status.') }
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
      // A logout that arrived while waiting goes through the catch: the row stays signed out on purpose.
      signal.throwIfAborted()
      this.jobs.delete(key)
      if (this.gone(target)) return
      this.invalidate(key)
      const status = await this.refreshTarget(target)
      // If a logout arrived in the meantime, refresh returned the cached state: the login is gone.
      if (status.state !== 'connected') this.put({ ...status, login: null, error: status.state === 'error' ? status.error : t('Login did not complete.') })
      else this.put({ ...status, login: null, error: null })
    } catch (error) {
      this.jobs.delete(key)
      // Profile removed in the meantime: nothing to reread or publish.
      if (this.gone(target)) return
      // The old account has already left: the agent must forget account, plan and limits.
      if (signedOut) await this.afterChange(target, true)
      this.invalidate(key)
      const status = await this.refreshTarget(target)
      // A deliberate cancellation is not an error.
      this.put({ ...status, login: null, error: error instanceof Cancelled || signal.aborted ? null : (error as Error).message })
    }
  }

  /** The connection's profile was removed. */
  private gone(target: Target): boolean {
    return Boolean(target.profileId) && !this.hooks.profile(target.profileId!)
  }

  /**
   * Makes sure the tool is there. The gh and Codex download is one per tool: logins of different profiles
   * wait for the same promise (same archive and same extraction folder); if whoever was downloading cancels, we retry.
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
        // Downloaded: a single pass. If the tool still isn't found (wrong test path) the login goes on and gives its own error.
        return
      } catch (error) {
        // If whoever was downloading cancelled, it's not our error: we retry, downloading ourselves. Any other error is rethrown.
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

  /** gh and Codex are downloaded into the data folder; Claude Code already ships inside Ladder. */
  private async install(link: Target, job: Job): Promise<void> {
    const { id } = link
    if (id === 'claude-code') throw new Error(t('Claude is not included in this build of Ladder.'))
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
    // The agent's reread is done by afterChange, at the end of the login.
    if (isGh) resetGh()
  }

  /** `gh auth login --web`: gh prints a one-time code; Ladder opens the browser (GH_BROWSER neutralizes gh's own). */
  private async loginGithub(job: Job, target: Target): Promise<void> {
    const path = await findGh()
    if (!path) throw new Error(t('gh is not installed'))
    const env = await agentEnv([], { GH_BROWSER: '/usr/bin/true', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' })
    job.abort.signal.throwIfAborted()
    const child = spawn(path, ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    job.child = child
    // If gh closes stdin before the write (EPIPE), the host must not crash.
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

  /** `claude auth login --claudeai`: the CLI opens the browser itself; the address it prints is offered as a fallback. */
  private async loginClaude(job: Job, target: Target): Promise<void> {
    const cli = await findClaudeCli()
    if (!cli) throw new Error(t('Claude is not included in this build of Ladder.'))
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
    // The CLI text may contain the sign-in address with its parameters: it doesn't end up in errors or logs.
    if ((await this.exit(child, job)) !== 0) throw new Error(t('Login did not complete.'))
  }

  /** Codex's app-server has ChatGPT login built in: it returns authUrl and then notifies account/login/completed. */
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
    // If the app-server closes before the end, the login failed.
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

  /** Waits for the login process to end, with cancellation and a timeout. */
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
      // The real outcome is given by the state reread.
    }
  }

  // ── State and progress ────────────────────────────────────────────────────

  private async afterChange({ id, profileId }: Target, reset: boolean, probe = !reset): Promise<void> {
    if (id === 'github') resetGh()
    await this.hooks.changed(id, reset, probe, profileId).catch(() => undefined)
  }

  private loginState(stage: ConnectionStage): ConnectionLogin {
    return { stage, progress: null, bytes: null, total: null, url: null, code: null }
  }

  /** Updates the login in progress and publishes it. */
  private step(target: Target, patch: Partial<ConnectionLogin>): void {
    const current = this.status.get(target.key) ?? empty(target.id, target.profileId)
    this.put({ ...current, login: { ...(current.login ?? this.loginState('verifying')), ...patch } })
  }

  private put(status: ConnectionStatus): void {
    // A removed profile's state must not reappear (cancelled login or read in flight).
    if (status.profileId && !this.hooks.profile(status.profileId)) return
    this.status.set(status.profileId ? `${status.id}:${status.profileId}` : status.id, status)
    this.hooks.publish(status)
  }
}
