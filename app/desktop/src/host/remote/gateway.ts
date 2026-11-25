// Remote gateway: carries the window's protocol over an encrypted connection (Noise NK), for the phone.
// It knows nothing about the transport (local WebSocket or relay): it receives an already open RemoteLink.
// Relative imports (no @shared alias): the file is tested in-process with `node --test`.
import { REMOTE_MAX_ATTACH_COMMAND, REMOTE_MAX_ATTACHMENTS, REMOTE_MAX_COMMAND } from '../../shared/protocol.ts'
import type { AgentId, AgentStatus, FromRemoteHost, HostCommand, HostEvent, PermissionLevel, RemoteAgentStatus, RemoteAuthErrorCode, RemoteCommand, RemoteEvent, RemoteLogAction, RemoteLogEntry, RemotePage, RemoteProfile, RemoteProjectDefaults, RemoteSessionCreate, RemoteSnapshot, RequestResponse, SessionSummary, SlashCommand } from '../../shared/protocol.ts'
import { isLocale, plural, t, type Locale } from '../../shared/i18n.ts'
import { serverHandshake, type RemoteSession } from '../../shared/remote/session.ts'
import type { NoiseKeyPair } from '../../shared/remote/noise.ts'
import { authErrorText, type DeviceRow, type RemoteAccess } from './access.ts'
import { searchFiles } from './file-search.ts'
import { carriesAttachmentsShape, declaredAttachments, isForwardedEventType, parseRemoteMessage, RemoteCommandError } from './allowlist.ts'
import { imagePlaceholder } from '../../shared/image-placeholder.ts'

/** An already open byte channel: one message = one Noise message. Implemented by the local WebSocket and by the relay. */
export interface RemoteLink {
  send(bytes: Uint8Array): void
  close(): void
  onBytes(handler: (bytes: Uint8Array) => void): void
  onClose(handler: () => void): void
  /** Bytes queued and not yet sent; if missing, no queue check. */
  buffered?(): number
  /** The transport knows the other end is alive (WebSocket pong): counts as activity even without Noise messages. */
  onAlive?(handler: () => void): void
}

/** What the gateway uses of the Host. */
export interface RemoteHostApi {
  snapshot(): Promise<Extract<HostEvent, { type: 'snapshot' }>>
  handle(command: Exclude<RemoteCommand, { type: 'session.page' | 'session.watch' | 'device.push.set' | 'device.notify.set' | 'device.state' | 'project.sessions.archived' | 'session.create' | 'project.files.search' | 'agents.usage' }> | Extract<HostCommand, { type: 'session.create' | 'agents.usage' }>, origin: object): Promise<unknown>
  pageItems(sessionId: string, before?: number, limit?: number): RemotePage
  /** Permission ceiling per project and send preference, for the snapshot; missing = no ceiling and 'steer'. */
  remoteExtras?(): Promise<{ permissionsMax: RemoteSnapshot['permissionsMax']; busySend: RemoteSnapshot['prefs']['busySend']; defaults?: RemoteSnapshot['defaults'] }>
  /**
   * `session.create` checks that need host state (project, agent allowed and available, model, effort, account).
   * Throws a translated error if anything is wrong; returns the names for the log. Missing = no checks beyond those of createSession.
   */
  checkCreate?(command: RemoteSessionCreate): Promise<{ agent: string; project: string }>
  /**
   * Agent and account of `agents.usage`, checked and normalized: unknown agent or non-existent account (or one belonging to another agent) = error;
   * the default profile (absent or `default:*`) comes back without `profileId`. Missing = only `default:*` is normalized.
   */
  usageTarget?(agent: string, profileId?: string): { agent: string; profileId?: string }
  /** List of a project's files (relative paths, .gitignore respected) for `project.files.search`. Translated error if the project does not exist. */
  projectFiles?(projectId: string): Promise<string[]>
  /** Archived sessions of a project (project.sessions.archived). */
  archivedSessions?(projectId: string, before?: number, limit?: number): SessionSummary[]
  connectionClosed(origin: object): void
  /** Title and options of a request, for the log of remote actions; missing = the log only writes "Responded". */
  requestInfo?(sessionId: string, requestId: string): { title: string; options: { id: string; kind: 'allow' | 'allow-always' | 'deny' }[] } | null
}

export interface RemoteGatewayOptions {
  host: RemoteHostApi
  identity: NoiseKeyPair
  /** Devices, pairing code and log. Every connection must authenticate with this before any command. */
  access: RemoteAccess
  /** Mac name and Ladder version, for the hello. */
  macName: string
  appVersion: string
  log?: (message: string) => void
  /** Clock; only tests change it. */
  now?: () => number
  /** Maximum silence after the handshake; only tests change it. */
  idleTimeoutMs?: number
  /** Called when the number of connected phones changes (successful authentication or closed connection). */
  onClients?: (count: number) => void
  /** Called when a device connects or disconnects entirely (for the window state). */
  onDevices?: () => void
  /** New entry in the log of remote actions. */
  onLog?: (entry: RemoteLogEntry) => void
}

/** How long "foreground" stays valid without news from the connection. */
export const FOREGROUND_TTL_MS = 30_000
export const MAX_WATCHED = 8
const MAX_IN_FLIGHT = 64
/** Beyond this send queue the connection is too slow and is closed. */
const MAX_BUFFERED = 64 * 1024 * 1024
/** From opening the connection to authentication: Noise handshake included. */
const HANDSHAKE_TIMEOUT_MS = 10_000
/** Open but not yet authenticated connections: beyond this, new ones are closed (they do not take room from paired phones). */
export const MAX_UNAUTHENTICATED = 4
/** Concurrent remote connections and maximum silence after the handshake (messages or transport pongs). */
export const MAX_CONNECTIONS = 8
export const IDLE_TIMEOUT_MS = 120_000
/** Commands per second (steady state) and maximum burst per connection; beyond that they get an error, and after too many refusals in a row the connection is closed. */
/** One real read of the usage limits every 60 seconds per agent+profile and connection; in between the last value applies. */
export const USAGE_REFRESH_MS = 60_000
const MAX_USAGE_KEYS = 32
const MAX_USAGE_CACHE = 64
/** New sessions from the phone, per device: burst of 3, then 5 per minute. */
export const CREATE_BURST = 3
export const CREATE_PER_MINUTE = 5
/** Images from the phone, per device: burst of 6, then 10 per minute (counted on `session.send` and `session.create`). */
export const IMAGE_BURST = 6
export const IMAGE_PER_MINUTE = 10
/** File searches (`@` mentions), per device: burst of 10, then 4 per second. A project's file list stays cached for 10 seconds. */
export const SEARCH_BURST = 10
export const SEARCH_PER_SECOND = 4
export const FILES_CACHE_MS = 10_000
const MAX_FILES_CACHE = 16
/** Wait before resending the defaults (several close changes = a single event). */
const DEFAULTS_DEBOUNCE_MS = 300
export const RATE_PER_SECOND = 20
export const RATE_BURST = 40
const MAX_REJECTED_IN_A_ROW = 100
/** An invalid attachment weighs as many refusals: 5 in a row close the connection. */
const ATTACHMENT_ERROR_WEIGHT = 20

/** Reduced snapshot: no drafts, terminals, shortcuts, links, profiles; of the UI only groups and seenAt. */
/** No account email or CLI path goes to the phone. */
export function toRemoteAgent(status: AgentStatus): RemoteAgentStatus {
  const { email: _email, path: _path, ...rest } = status
  return { ...rest, error: status.error ? safeError(status.error) : null }
}

/** For an agent, what matters for the defaults is availability and models (with effort and defaults), not usage limits. */
function agentSignature(status: AgentStatus): string {
  return JSON.stringify([status.available, status.models.map((m) => [m.id, m.isDefault ?? false, m.defaultEffort ?? null, m.efforts ?? null])])
}

/** An agent's error may quote paths or CLI output: the phone gets a short line without paths. */
function safeError(error: string): string {
  const flat = error.replace(/\s+/g, ' ').replace(/(?:~|[A-Za-z]:)?(?:[\\/][^\s'"“”:;,)]+){2,}/g, '…').trim()
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat
}

export function toRemoteSnapshot(full: Extract<HostEvent, { type: 'snapshot' }>, extras: Pick<RemoteSnapshot, 'permissionsMax' | 'prefs'> & { defaults?: RemoteSnapshot['defaults'] }): RemoteSnapshot {
  const ui: RemoteSnapshot['ui'] = {}
  for (const [projectId, state] of Object.entries(full.ui)) {
    ui[projectId] = {
      ...(state.groups ? { groups: state.groups } : {}),
      ...(state.groupOf ? { groupOf: state.groupOf } : {}),
      ...(state.seenAt !== undefined ? { seenAt: state.seenAt } : {})
    }
  }
  return { type: 'snapshot', projects: full.projects, sessions: full.sessions, ui, ...(full.projectGroups ? { projectGroups: full.projectGroups } : {}), agents: full.agents.map(toRemoteAgent), profiles: (full.profiles ?? []).map((p) => ({ id: p.id, agent: p.agent, name: p.name, isDefault: p.isDefault })), defaults: extras.defaults ?? {}, permissionsMax: extras.permissionsMax, prefs: extras.prefs }
}

/** A remote connection: it is also the `origin` the Host associates with subscriptions. */
class RemoteConnection {
  readonly link: RemoteLink
  session: RemoteSession | null = null
  /** Name declared in the hello (unauthenticated): only for the diagnostic log. */
  device = ''
  /** Authenticated device; null until it has sent `pair` or `auth`. */
  auth: DeviceRow | null = null
  authenticating = false
  /** App language from the hello (unauthenticated: saved only after authentication). */
  locale: Locale | null = null
  /** Last command received (application traffic: transport pongs and keepalives do not count). */
  activeAt = 0
  /** Followed sessions, least recent first (insertion order of the Map). */
  readonly watched = new Map<string, true>()
  inFlight = 0
  closed = false
  handshakeTimer: ReturnType<typeof setTimeout> | null = null
  idleTimer: ReturnType<typeof setTimeout> | null = null
  /** Token bucket for the request limit. */
  tokens = RATE_BURST
  tokensAt = Date.now()
  rejected = 0

  constructor(link: RemoteLink) {
    this.link = link
  }
}

const levelName = (level: PermissionLevel): string => {
  switch (level) {
    case 'plan':
      return t('Plan')
    case 'ask':
      return t('Ask')
    case 'edit':
      return t('Edit')
    case 'full': {
      // In English `t` returns the key itself: the short text is "Full".
      const label = t('Full access (short)')
      return label === 'Full access (short)' ? 'Full' : label
    }
  }
}

/** Short summary for the log: "Approved: Run command"; never the text of a free-form answer. */
function describeResponse(info: { title: string; options: { id: string; kind: string }[] } | null, response: RequestResponse): string {
  const title = (info?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const kind = 'optionId' in response ? info?.options.find((o) => o.id === response.optionId)?.kind : 'answers'
  if (!title) return kind === 'deny' ? t('Denied') : kind === 'answers' ? t('Answered') : kind === 'allow-always' ? t('Always allowed') : kind === 'allow' ? t('Approved') : t('Responded')
  if (kind === 'deny') return t('Denied: {title}', { title })
  if (kind === 'answers') return t('Answered: {title}', { title })
  if (kind === 'allow-always') return t('Always allowed: {title}', { title })
  return kind === 'allow' ? t('Approved: {title}', { title }) : t('Responded: {title}', { title })
}

export class RemoteGateway {
  private readonly options: RemoteGatewayOptions
  private readonly connections = new Set<RemoteConnection>()
  private identity: NoiseKeyPair
  /** Last device.state per device. */
  private readonly foreground = new Map<string, { foreground: boolean; at: number; conn: RemoteConnection }>()
  /** Last usage-limits value read per agent+profile (from any connection). */
  private readonly usageCache = new Map<string, RemoteAgentStatus>()
  /** Last real read per device (not per connection: reconnecting does not reset the limit) and agent+account. */
  private readonly usageReads = new Map<string, Map<string, number>>()
  /** Tokens for new sessions per device. */
  private readonly createBuckets = new Map<string, { tokens: number; at: number }>()
  /** Generation of the last defaults send (an older send finishing later is discarded) and signature of the agents already seen. */
  private defaultsGen = 0
  private readonly agentSigs = new Map<string, string>()
  /** Tokens for images and searches per device; file lists per project (and those being read right now). */
  private readonly imageBuckets = new Map<string, { tokens: number; at: number }>()
  private readonly searchBuckets = new Map<string, { tokens: number; at: number }>()
  private readonly filesCache = new Map<string, { at: number; files: string[] }>()
  private readonly filesReading = new Map<string, Promise<string[]>>()
  /** Last defaults sent to the phones and timer of the delayed send. */
  private lastDefaults = ''
  private defaultsTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: RemoteGatewayOptions) {
    this.options = options
    this.identity = options.identity
  }

  /** New identity of the Mac (key regeneration): applies to new connections. */
  setIdentity(identity: NoiseKeyPair): void {
    this.identity = identity
  }

  get size(): number {
    return this.connections.size
  }

  /** Connected phones: authenticated connections. */
  get clients(): number {
    let n = 0
    for (const conn of this.connections) if (conn.auth) n++
    return n
  }

  /** Ids of the devices with at least one authenticated connection. */
  connectedDevices(): Set<string> {
    const ids = new Set<string>()
    for (const conn of this.connections) if (conn.auth) ids.add(conn.auth.id)
    return ids
  }

  /**
   * Devices with the app in the foreground, from the device's last `device.state` (on any connection).
   * It only counts if the connection that reported it is still open and either reported it less than 30 seconds ago or sent commands
   * in the last 30 seconds: a silent or dropped connection does not suppress pushes.
   */
  foregroundDevices(): Set<string> {
    const now = this.now()
    const ids = new Set<string>()
    for (const [deviceId, state] of this.foreground) {
      if (state.foreground && !state.conn.closed && (now - state.at < FOREGROUND_TTL_MS || now - state.conn.activeAt < FOREGROUND_TTL_MS)) ids.add(deviceId)
    }
    return ids
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** The device was renamed: open connections use the new name (log and `viaDevice`). */
  deviceRenamed(deviceId: string, name: string): void {
    for (const conn of this.connections) if (conn.auth?.id === deviceId) conn.auth = { ...conn.auth, name }
  }

  /** Sends the phones the Mac's current preferences (`remote.prefs` event). */
  async pushPrefs(): Promise<void> {
    const extras = await this.options.host.remoteExtras?.()
    const event: RemoteEvent = { type: 'remote.prefs', prefs: { busySend: extras?.busySend ?? 'steer', allowFull: this.options.access.allowFull } }
    for (const conn of this.connections) if (conn.auth) this.send(conn, { kind: 'event', event })
    // The proposed permission depends on "Allow Full access from phone".
    this.pushDefaults(true)
  }

  /** 'full' proposed with "Allow Full access from phone" off becomes 'edit': the phone must not propose a level the Mac refuses. */
  private phoneDefaults(defaults: Record<string, RemoteProjectDefaults> | undefined): Record<string, RemoteProjectDefaults> {
    if (!defaults) return {}
    if (this.options.access.allowFull) return defaults
    const out: Record<string, RemoteProjectDefaults> = {}
    for (const [id, d] of Object.entries(defaults)) out[id] = d.permission === 'full' ? { ...d, permission: 'edit' } : d
    return out
  }

  /**
   * Sends the phones the current defaults and permission ceilings (`remote.defaults` event), only if they changed since the last send.
   * Delayed by 300 ms (several changes = one send); `now` skips the wait.
   */
  pushDefaults(now = false): void {
    if (this.defaultsTimer) clearTimeout(this.defaultsTimer)
    const run = () => {
      this.defaultsTimer = null
      // No phone: the next one starts from a fresh hello, and the comparison with the last send no longer applies.
      if (![...this.connections].some((c) => c.auth)) {
        this.lastDefaults = ''
        return
      }
      const gen = ++this.defaultsGen
      void this.options.host
        .remoteExtras?.()
        .then((extras) => {
          // A newer send started while this one was reading: its result is more recent.
          if (!extras || gen !== this.defaultsGen) return
          const event: RemoteEvent = { type: 'remote.defaults', defaults: this.phoneDefaults(extras.defaults), permissionsMax: extras.permissionsMax }
          const key = JSON.stringify(event)
          if (key === this.lastDefaults) return
          this.lastDefaults = key
          for (const conn of this.connections) if (conn.auth) this.send(conn, { kind: 'event', event })
        })
        .catch(() => undefined)
    }
    if (now) run()
    else {
      this.defaultsTimer = setTimeout(run, DEFAULTS_DEBOUNCE_MS)
      this.defaultsTimer.unref()
    }
  }

  /** Revocation: notifies the phone and immediately closes all connections of that device. */
  disconnectDevice(deviceId: string): void {
    for (const conn of [...this.connections]) if (conn.auth?.id === deviceId) this.reject(conn, 'device-revoked')
  }

  /** Closes all connections, authenticated or not (key regeneration, channel off); paired phones are notified. */
  disconnectAll(): void {
    for (const conn of [...this.connections]) {
      if (conn.auth) this.reject(conn, 'device-revoked')
      else this.drop(conn)
    }
  }

  /** Takes over a new connection: handshake, then commands. */
  accept(link: RemoteLink): void {
    // Full of unauthenticated connections (or of slots): the oldest of those is closed, not the new one, so whoever holds the slots cannot keep real phones out.
    const waiting = [...this.connections].filter((other) => !other.auth)
    if (waiting.length >= MAX_UNAUTHENTICATED || (this.connections.size >= MAX_CONNECTIONS && waiting.length > 0)) this.drop(waiting[0], 'replaced by a newer connection')
    if (this.connections.size >= MAX_CONNECTIONS) {
      link.close()
      return
    }
    const conn = new RemoteConnection(link)
    this.connections.add(conn)
    const handshake = serverHandshake({ identity: this.identity, hello: { mac: this.options.macName, app: this.options.appVersion } })
    conn.handshakeTimer = setTimeout(() => this.drop(conn, 'handshake timeout'), HANDSHAKE_TIMEOUT_MS)
    conn.handshakeTimer.unref()
    link.onClose(() => this.drop(conn))
    link.onAlive?.(() => this.touch(conn))
    link.onBytes((bytes) => {
      if (conn.closed) return
      this.touch(conn)
      try {
        if (!conn.session) {
          const { reply, session, client } = handshake.accept(bytes)
          // The handshake timer stays: it applies until authentication (pair/auth), not just until the first message.
          conn.session = session
          conn.device = client.device.slice(0, 80)
          conn.locale = isLocale(client.locale) ? client.locale : null
          link.send(reply)
          this.options.log?.(`connection opened, waiting for authentication (device: ${JSON.stringify(conn.device)})`)
          return
        }
        const message = conn.session.open<unknown>(bytes)
        if (message !== null) {
          // After authentication the limit is wider, but only messages with images may exceed REMOTE_MAX_COMMAND.
          if (conn.session.lastSize > REMOTE_MAX_COMMAND && !carriesAttachmentsShape(message)) throw new Error('message too large')
          this.onMessage(conn, message)
        }
      } catch (error) {
        // Decryption failed, different version, message too large, broken JSON: the connection cannot recover.
        this.drop(conn, error instanceof Error ? error.message : String(error))
      }
    })
  }

  /** Snapshot for the phone: the reduced one plus the permission ceilings and the Mac's preferences. */
  private async buildSnapshot(full: Extract<HostEvent, { type: 'snapshot' }>): Promise<RemoteSnapshot> {
    const extras = (await this.options.host.remoteExtras?.()) ?? { permissionsMax: {}, busySend: 'steer' as const }
    const defaults = this.phoneDefaults((extras as { defaults?: RemoteSnapshot['defaults'] }).defaults)
    return toRemoteSnapshot(full, { permissionsMax: extras.permissionsMax, defaults, prefs: { busySend: extras.busySend, allowFull: this.options.access.allowFull } })
  }

  /** A host event: goes to remote clients only if it is among the allowed ones (and, for chats, only to whoever follows the session). */
  broadcast(event: HostEvent): void {
    if (this.connections.size === 0) return
    let out: RemoteEvent
    if (event.type === 'snapshot') {
      // The snapshot needs asynchronous data (permission ceilings): it is sent as soon as they are ready.
      void this.buildSnapshot(event)
        .then((snapshot) => {
          for (const conn of this.connections) if (conn.auth) this.send(conn, { kind: 'event', event: snapshot })
        })
        .catch(() => undefined)
      return
    } else if (isForwardedEventType(event.type)) {
      // The account email and the CLI path do not leave the Mac.
      if (event.type === 'agent.status') out = { ...event, status: toRemoteAgent(event.status) } as unknown as RemoteEvent
      // The account without the configuration folder.
      else if (event.type === 'profile.upsert') out = { type: 'profile.upsert', profile: { id: event.profile.id, agent: event.profile.agent, name: event.profile.name, isDefault: event.profile.isDefault } satisfies RemoteProfile }
      else out = event as RemoteEvent
      // Models (not just usage limits), agents, projects and accounts change the defaults shown to the phone.
      if (event.type === 'agent.status') {
        const sig = agentSignature(event.status)
        const id = `${event.status.agent}|${event.status.profileId ?? ''}`
        if (this.agentSigs.get(id) !== sig) {
          this.agentSigs.set(id, sig)
          this.pushDefaults()
        }
      } else if (event.type === 'project.upsert' || event.type === 'project.removed' || event.type === 'profile.upsert' || event.type === 'profile.removed') this.pushDefaults()
    } else return
    // replace: true (also from session.open on the Mac) carries the whole chat: the phone only gets the last page, computed once.
    let lastPage: RemoteEvent | null | undefined
    for (const conn of this.connections) {
      if (!conn.auth) continue
      if ((out.type === 'session.items' || out.type === 'session.subagents') && !conn.watched.has(out.sessionId)) continue
      if (out.type === 'session.items' && out.replace) {
        if (lastPage === undefined) {
          try {
            lastPage = { type: 'session.items', sessionId: out.sessionId, items: this.options.host.pageItems(out.sessionId).items, replace: true }
          } catch {
            lastPage = null // session gone: nothing to send
          }
        }
        if (lastPage) this.send(conn, { kind: 'event', event: lastPage })
        continue
      }
      this.send(conn, { kind: 'event', event: out })
    }
  }

  /** Activity on the connection: the silence clock restarts. */
  private touch(conn: RemoteConnection): void {
    if (conn.closed || !conn.auth) return
    if (conn.idleTimer) clearTimeout(conn.idleTimer)
    conn.idleTimer = setTimeout(() => this.drop(conn, 'idle timeout'), this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS)
    conn.idleTimer.unref()
  }

  /** One token per command; true if there was one. */
  private allow(conn: RemoteConnection): boolean {
    const now = Date.now()
    conn.tokens = Math.min(RATE_BURST, conn.tokens + ((now - conn.tokensAt) / 1000) * RATE_PER_SECOND)
    conn.tokensAt = now
    if (conn.tokens < 1) return false
    conn.tokens -= 1
    return true
  }

  /** Closes all connections (channel shutdown). */
  close(): void {
    if (this.defaultsTimer) clearTimeout(this.defaultsTimer)
    this.defaultsTimer = null
    for (const conn of [...this.connections]) this.drop(conn)
  }

  private send(conn: RemoteConnection, message: FromRemoteHost): void {
    if (conn.closed || !conn.session) return
    try {
      if ((conn.link.buffered?.() ?? 0) > MAX_BUFFERED) throw new Error('send queue too long')
      for (const bytes of conn.session.seal(message)) conn.link.send(bytes)
    } catch (error) {
      this.drop(conn, error instanceof Error ? error.message : String(error))
    }
  }

  private drop(conn: RemoteConnection, reason?: string): void {
    if (conn.closed) return
    conn.closed = true
    if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer)
    if (conn.idleTimer) clearTimeout(conn.idleTimer)
    this.connections.delete(conn)
    conn.watched.clear()
    if (conn.auth && this.foreground.get(conn.auth.id)?.conn === conn) this.foreground.delete(conn.auth.id)
    const device = conn.auth
    if (device) {
      this.options.onClients?.(this.clients)
      try {
        this.options.access.touch(device.id)
      } catch {
        // database closed while shutting down
      }
    }
    try {
      conn.link.close()
    } catch {
      // already closed
    }
    // Git and file subscriptions that the host associates with the connection: they go away with it.
    try {
      this.options.host.connectionClosed(conn)
    } catch (error) {
      console.error('[remote] connectionClosed', error instanceof Error ? error.message : String(error))
    }
    if (device) this.options.onDevices?.()
    if (reason) this.options.log?.(`connection closed: ${reason}`)
  }

  /** Authentication failed or revoked: the phone receives the code (and the translated text), then the connection closes. */
  private reject(conn: RemoteConnection, code: RemoteAuthErrorCode): void {
    this.send(conn, { kind: 'auth', ok: false, code, error: authErrorText(code) })
    this.drop(conn, `authentication: ${code}`)
  }

  /** The first message: `pair` or `auth`. Anything else, or a second message while verifying, closes the connection. */
  private onFirstMessage(conn: RemoteConnection, value: unknown): void {
    if (conn.authenticating) return this.drop(conn, 'message before authentication finished')
    conn.authenticating = true
    const session = conn.session!
    void this.options.access
      .authenticate(value, session.handshakeHash)
      .then((outcome) => {
        if (conn.closed) return
        if (!outcome.ok) return this.reject(conn, outcome.code)
        if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer)
        conn.handshakeTimer = null
        conn.auth = outcome.device
        // Only now (authenticated) can the connection receive messages with images.
        session.setMaxInbound(REMOTE_MAX_ATTACH_COMMAND)
        // The app language decides the push text; without it, the saved one stays (or English).
        if (conn.locale) {
          try {
            this.options.access.setLocale(outcome.device.id, conn.locale)
          } catch (error) {
            console.error('[remote] locale', error instanceof Error ? error.message : String(error))
          }
        }
        this.touch(conn)
        this.send(conn, { kind: 'auth', ok: true, deviceId: outcome.device.id, name: outcome.device.name, allowFull: this.options.access.allowFull })
        this.options.log?.(`device authenticated (${outcome.paired ? 'paired' : 'known'})`)
        this.options.onClients?.(this.clients)
        this.options.onDevices?.()
      })
      .catch(() => this.drop(conn, 'authentication error'))
  }

  /** Writes to the log of remote actions; a database error does not stop the command. */
  private record(conn: RemoteConnection, action: RemoteLogAction, sessionId: string | null, detail: string): void {
    if (!conn.auth) return
    try {
      this.options.onLog?.(this.options.access.record(conn.auth, action, sessionId, detail))
    } catch (error) {
      console.error('[remote] log', error instanceof Error ? error.message : String(error))
    }
  }

  private onMessage(conn: RemoteConnection, value: unknown): void {
    if (!conn.auth) return this.onFirstMessage(conn, value)
    // Limits first, then the real work (validating and decoding images is costly): only the shape and the request id are needed.
    const shape = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { rid?: unknown; command?: { type?: unknown; sessionId?: unknown } }) : null
    // A rid that is present but malformed is a client that does not follow the protocol: the connection is closed (as parseRemoteMessage does).
    if (shape && shape.rid !== undefined && !(typeof shape.rid === 'string' && shape.rid.length > 0 && shape.rid.length <= 128)) return this.drop(conn, 'bad message')
    const early = shape && typeof shape.rid === 'string' ? shape.rid : undefined
    if (!this.allow(conn)) {
      if (++conn.rejected >= MAX_REJECTED_IN_A_ROW) this.drop(conn, 'rate limit')
      else if (early) this.send(conn, { kind: 'result', rid: early, ok: false, error: t('Too many requests. Slow down.') })
      return
    }
    // Declared images count immediately against the device limit (even if they later fail the checks).
    const declared = declaredAttachments(value)
    if (declared > 0 && !this.takeFrom(this.imageBuckets, conn, IMAGE_BURST, IMAGE_PER_MINUTE / 60_000, Math.min(declared, REMOTE_MAX_ATTACHMENTS))) {
      const create = shape?.command?.type === 'session.create'
      const id = typeof shape?.command?.sessionId === 'string' && shape.command.sessionId.length <= 256 ? shape.command.sessionId : null
      this.record(conn, create ? 'create' : 'send', create ? null : id, create ? t('New session refused: too many images') : t('Message refused: too many images'))
      if (++conn.rejected >= MAX_REJECTED_IN_A_ROW) this.drop(conn, 'rate limit')
      else if (early) this.send(conn, { kind: 'result', rid: early, ok: false, error: t('Too many images. Try again in a moment.') })
      return
    }
    let rid: string | undefined
    let command: RemoteCommand
    try {
      const parsed = parseRemoteMessage(value, { invalid: t('Invalid request.'), notAllowed: t('This request is not available from the phone.'), attachments: t('Invalid images. Send up to 3 JPEG, PNG or WebP images, 1 MB each and 2 MB in total.') })
      rid = parsed.rid
      command = parsed.command
    } catch (error) {
      if (error instanceof RemoteCommandError && error.rid) this.send(conn, { kind: 'result', rid: error.rid, ok: false, error: error.message })
      else if (!(error instanceof RemoteCommandError)) this.drop(conn, 'bad message')
      // Repeated invalid attachments: a well-behaved app does not send them; the connection closes after a few (5) consecutive attempts.
      if (error instanceof RemoteCommandError && error.attachments && (conn.rejected += ATTACHMENT_ERROR_WEIGHT) >= MAX_REJECTED_IN_A_ROW) this.drop(conn, 'invalid attachments')
      return
    }
    conn.rejected = 0
    conn.activeAt = this.now()
    if (conn.inFlight >= MAX_IN_FLIGHT) {
      this.drop(conn, 'too many requests in flight')
      return
    }
    conn.inFlight++
    void this.run(conn, command)
      .then((data) => {
        if (rid) this.send(conn, { kind: 'result', rid, ok: true, data })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[remote] ${command.type}: ${message}`)
        if (rid) this.send(conn, { kind: 'result', rid, ok: false, error: message })
      })
      .finally(() => {
        conn.inFlight--
      })
  }

  /** One token per new session, per device: burst of 3, then 5 per minute. */
  private takeCreate(conn: RemoteConnection): boolean {
    const id = conn.auth?.id ?? ''
    const now = this.now()
    const bucket = this.createBuckets.get(id) ?? { tokens: CREATE_BURST, at: now }
    bucket.tokens = Math.min(CREATE_BURST, bucket.tokens + ((now - bucket.at) / 60_000) * CREATE_PER_MINUTE)
    bucket.at = now
    this.createBuckets.set(id, bucket)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  /** Tokens per device: `cost` at a time; true if there were enough. `refill` = tokens per millisecond. */
  private takeFrom(buckets: Map<string, { tokens: number; at: number }>, conn: RemoteConnection, burst: number, refill: number, cost: number): boolean {
    const id = conn.auth?.id ?? ''
    const now = this.now()
    const bucket = buckets.get(id) ?? { tokens: burst, at: now }
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) * refill)
    bucket.at = now
    buckets.set(id, bucket)
    if (bucket.tokens < cost) return false
    bucket.tokens -= cost
    return true
  }

  /** Puts `cost` tokens back in the device's bucket (a request counted but then refused for another reason). */
  private refundFrom(buckets: Map<string, { tokens: number; at: number }>, conn: RemoteConnection, burst: number, cost: number): void {
    const bucket = buckets.get(conn.auth?.id ?? '')
    if (bucket) bucket.tokens = Math.min(burst, bucket.tokens + cost)
  }

  /** The project's file list, cached for FILES_CACHE_MS; concurrent reads of the same project (cold cache) become one. */
  private async projectFiles(projectId: string): Promise<string[]> {
    const now = this.now()
    const hit = this.filesCache.get(projectId)
    if (hit && now - hit.at < FILES_CACHE_MS) return hit.files
    const running = this.filesReading.get(projectId)
    if (running) return running
    const read = (async () => (await this.options.host.projectFiles?.(projectId)) ?? [])()
    this.filesReading.set(projectId, read)
    try {
      const files = await read
      this.filesCache.delete(projectId)
      this.filesCache.set(projectId, { at: now, files })
      while (this.filesCache.size > MAX_FILES_CACHE) this.filesCache.delete(this.filesCache.keys().next().value as string)
      return files
    } finally {
      this.filesReading.delete(projectId)
    }
  }

  private async run(conn: RemoteConnection, command: RemoteCommand): Promise<unknown> {
    const { host } = this.options
    switch (command.type) {
      case 'session.page':
        return host.pageItems(command.sessionId, command.before, command.limit)
      case 'session.watch':
        if (command.on) {
          // Most recent last; beyond MAX_WATCHED the least recent stops being followed.
          conn.watched.delete(command.sessionId)
          conn.watched.set(command.sessionId, true)
          while (conn.watched.size > MAX_WATCHED) conn.watched.delete(conn.watched.keys().next().value as string)
        } else {
          conn.watched.delete(command.sessionId)
        }
        return null
      case 'hello':
        return this.buildSnapshot(await host.snapshot())
      case 'project.sessions.archived':
        return host.archivedSessions?.(command.projectId, command.before, command.limit) ?? []
      case 'device.push.set':
        if (conn.auth) this.options.access.setPushToken(conn.auth.id, command.token, command.platform)
        // The window shows "Notifications on" from the token.
        this.options.onDevices?.()
        return null
      case 'device.notify.set':
        if (conn.auth) this.options.access.setNotifyPrefs(conn.auth.id, command.prefs)
        return null
      case 'device.state':
        if (conn.auth) this.foreground.set(conn.auth.id, { foreground: command.foreground, at: this.now(), conn })
        return null
      case 'session.create': {
        // Per-device limit of its own: every attempt counts, even if it later fails the checks; a refusal goes to the log.
        if (!this.takeCreate(conn)) {
          // Refused because of the session limit: the images already counted go back to the device.
          if (command.attachments?.length) this.refundFrom(this.imageBuckets, conn, IMAGE_BURST, command.attachments.length)
          this.record(conn, 'create', null, t('New session refused: too many requests'))
          throw new Error(t('Too many new sessions. Try again in a moment.'))
        }
        // The images were already counted (and validated) by onMessage.
        const images = command.attachments?.length ?? 0
        const info = (await host.checkCreate?.(command)) ?? { agent: command.agent, project: command.projectId }
        const base = t('New session: {agent} in {project}', { agent: info.agent, project: info.project })
        const detail = images > 0 ? t('{detail} ({images})', { detail: base, images: plural(images, '{n} image', '{n} images', { n: images }) }) : base
        if (command.permission === 'full' && !this.options.access.allowFull) {
          this.record(conn, 'create', null, t('{detail} (blocked)', { detail }))
          throw new Error(t('Full access cannot be turned on from the phone. Allow it in Settings on your Mac.'))
        }
        // Chat, no worktree, no attachments: the command is rebuilt field by field (the text does not go in the log).
        const created = (await host.handle({ type: 'session.create', projectId: command.projectId, agent: command.agent, text: images > 0 && !command.text.trim() ? imagePlaceholder(images) : command.text, model: command.model, effort: command.effort, permission: command.permission, ...(command.profileId ? { profileId: command.profileId } : {}), mode: 'chat', ...(images > 0 ? { attachments: command.attachments } : {}) }, conn)) as SessionSummary | null
        this.record(conn, 'create', created?.id ?? null, detail)
        return created
      }
      case 'project.files.search': {
        if (!this.takeFrom(this.searchBuckets, conn, SEARCH_BURST, SEARCH_PER_SECOND / 1000, 1)) throw new Error(t('Too many requests. Slow down.'))
        return searchFiles(await this.projectFiles(command.projectId), command.query, command.limit)
      }
      case 'agents.usage': {
        // Agent and account verified first (no invented keys); the default has a single key.
        const target = host.usageTarget ? host.usageTarget(command.agent, command.profileId) : { agent: command.agent, ...(command.profileId && !command.profileId.startsWith('default:') ? { profileId: command.profileId } : {}) }
        const key = `${target.agent}|${target.profileId ?? ''}`
        const deviceId = conn.auth?.id ?? ''
        let reads = this.usageReads.get(deviceId)
        if (!reads) this.usageReads.set(deviceId, (reads = new Map()))
        const last = reads.get(key)
        const now = this.now()
        if (last !== undefined && now - last < USAGE_REFRESH_MS) {
          const cached = this.usageCache.get(key)
          if (cached) return cached
        }
        reads.delete(key)
        reads.set(key, now)
        while (reads.size > MAX_USAGE_KEYS) reads.delete(reads.keys().next().value as string)
        const status = (await host.handle({ type: 'agents.usage', agent: target.agent as AgentId, ...(target.profileId ? { profileId: target.profileId } : {}) }, conn)) as AgentStatus | null
        const clean = status ? toRemoteAgent(status) : null
        if (clean) {
          this.usageCache.delete(key)
          this.usageCache.set(key, clean)
          while (this.usageCache.size > MAX_USAGE_CACHE) this.usageCache.delete(this.usageCache.keys().next().value as string)
        }
        return clean
      }
      case 'session.send': {
        // Images already counted and validated by onMessage; the log only records how many there are. A message of images only
        // carries the window's placeholder text: the agent does not accept an empty text block.
        const images = command.attachments?.length ?? 0
        const result = await host.handle(images > 0 && !command.text.trim() ? { ...command, text: imagePlaceholder(images) } : command, conn)
        this.record(conn, 'send', command.sessionId, images > 0 ? plural(images, 'Message with {n} image', 'Message with {n} images', { n: images }) : t('Message ({n} chars)', { n: command.text.length }))
        return result
      }
      case 'session.command': {
        // The command must be in the session's current list (the same as `session.commands`); the arguments do not go in the log.
        const list = ((await host.handle({ type: 'session.commands', sessionId: command.sessionId }, conn)) as SlashCommand[] | null) ?? []
        if (!list.some((c) => c.name === command.name)) throw new Error(t('Unknown command: /{name}', { name: command.name }))
        const result = await host.handle(command, conn)
        this.record(conn, 'send', command.sessionId, t('Command /{name}', { name: command.name }))
        return result
      }
      case 'session.respond': {
        const info = host.requestInfo?.(command.sessionId, command.requestId) ?? null
        const result = await host.handle({ ...command, via: 'phone', viaDevice: conn.auth?.name }, conn)
        this.record(conn, 'respond', command.sessionId, describeResponse(info, command.response))
        return result
      }
      case 'session.queue.deliver': {
        const result = await host.handle(command, conn)
        this.record(conn, 'queue', command.sessionId, command.how === 'now' ? t('Queued message sent now') : t('Queued message sent into the turn'))
        return result
      }
      case 'session.interrupt': {
        const result = await host.handle(command, conn)
        this.record(conn, 'interrupt', command.sessionId, t('Stopped'))
        return result
      }
      case 'session.permission.set': {
        if (command.permission === 'full' && !this.options.access.allowFull) {
          this.record(conn, 'permission', command.sessionId, t('Permission → {level} (blocked)', { level: levelName('full') }))
          throw new Error(t('Full access cannot be turned on from the phone. Allow it in Settings on your Mac.'))
        }
        const result = (await host.handle(command, conn)) as { permission?: PermissionLevel } | null
        // The real level is the one after the project ceiling.
        this.record(conn, 'permission', command.sessionId, t('Permission → {level}', { level: levelName(result?.permission ?? command.permission) }))
        return result
      }
      default:
        return host.handle(command, conn)
    }
  }
}
