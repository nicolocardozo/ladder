// Remote channel client (protocol 2): Noise NK handshake (initiator, the Mac's public key), then the first signed message
// (`pair` the first time, `auth` afterwards), then `hello` and the commands with rid, events, reconnection with backoff.
// It does not know the store: it talks to its user through callbacks. Host limits respected: 20 commands/s (here 15/s),
// 1 MiB per command, max silence 120 s (relay and server pings take care of it).
import { t, type Locale } from '@shared/i18n'
import type { FromRemoteHost, RemoteAuthErrorCode, RemoteAuthResult, RemoteCommand, RemoteEvent, RemoteFirstMessage, RemoteMacStatus, RemoteOfflineReason, RemotePlatform, RemoteServerHello, RemoteSnapshot, ToRemoteHost } from '@shared/protocol'
import { toBase64Url } from '@shared/remote/pairing'
import { signChannelBinding } from '@shared/remote/pairing'
import { clientHandshake, type RemoteSession } from '@shared/remote/session'
import type { LinkFactory, RemoteLink } from './link'

export type ConnState =
  | { kind: 'connecting'; since: number }
  | { kind: 'connected'; since: number }
  | { kind: 'reconnecting'; since: number; reason?: string }
  /** Connected, but re-reading the chats after reconnecting. */
  | { kind: 'syncing'; since: number }
  | { kind: 'unreachable'; since: number; reason?: string }
  /** The relay is reachable but the Mac is not: `reason` and `since` (last time the relay saw it) come from the relay. */
  | { kind: 'mac-offline'; since: number | null; reason: RemoteOfflineReason; /** Since when the phone has seen it offline (phone clock). */ at: number }
  /** "Access from your phone" is off on the Mac: retried calmly. */
  | { kind: 'disabled'; since: number }
  // Final states: the client stops and its user shows a screen.
  /** The Mac revoked this phone (or no longer knows it). */
  | { kind: 'revoked' }
  /** The Mac's key is no longer the one from pairing. */
  | { kind: 'key-changed' }
  /** Pairing was rejected (expired code, wrong password…). */
  | { kind: 'denied'; code: RemoteAuthErrorCode; error: string }

/** How the phone introduces itself after the handshake. */
export type FirstMessage =
  | { mode: 'auth'; deviceId: string }
  | { mode: 'pair'; token: string; password?: string; device: { name: string; platform: RemotePlatform } }

export interface ClientOptions {
  createLink: LinkFactory
  macPublicKey: Uint8Array
  /** The phone's Ed25519 key (the private part never leaves here: it is only used to sign). */
  deviceKey: { secretKey: Uint8Array; publicKey: Uint8Array }
  /** Device name for the handshake hello (diagnostics only on the Mac). */
  deviceLabel: string
  locale: Locale
  onEvent(event: RemoteEvent): void
  /** The Mac accepted `pair`/`auth`. */
  onAuthenticated(result: Extract<RemoteAuthResult, { ok: true }>, hello: RemoteServerHello): void
  /** After every successful hello (also after a reconnection): the client's user re-reads what follows. The client stays in 'syncing' until it resolves. */
  onHello(snapshot: RemoteSnapshot, hello: RemoteServerHello, reconnect: boolean): Promise<void>
  onState(state: ConnState): void
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000]
const CONNECT_TIMEOUT_MS = 8_000
const REQUEST_TIMEOUT_MS = 25_000
/** A command with images carries up to ~3 MB: on a slow network it takes longer. */
const ATTACH_TIMEOUT_MS = 90_000
/** After this much time (or attempts) without a connection it goes from "Reconnecting" to "Mac unreachable". */
const UNREACHABLE_AFTER_MS = 20_000
const UNREACHABLE_AFTER_ATTEMPTS = 3
const RATE_PER_SECOND = 15
/** With the connection in the foreground and long silence, check that the Mac responds. */
const LIVENESS_EVERY_MS = 30_000
const SILENT_AFTER_MS = 60_000
const PROBE_TIMEOUT_MS = 6_000
/**
 * Consecutive failed handshakes before saying the Mac's key changed (a single one may be a corrupted message or a Mac
 * restarting). With a wrong key the Mac cannot decrypt the first message and closes on us without replying: only a
 * close decided by the Mac (`rejected`) after our first message and before its reply counts; a network failure
 * or a Mac that disappears do not count.
 */
const HANDSHAKE_FAILURES_FOR_KEY_CHANGE = 3
/** The relay says "never seen" for a Mac we had already connected to: after this wait we conclude that the key (and the id) changed. */
const NEVER_SEEN_GRACE_MS = 3_000

export class RemoteClient {
  private readonly o: ClientOptions
  /** How we introduce ourselves on the next connection: after a successful `pair` it becomes `auth` (the one-time code is no longer valid). */
  private first: FirstMessage
  private link: RemoteLink | null = null
  private session: RemoteSession | null = null
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private nextRid = 0
  private stopped = true
  private everConnected = false
  private attempts = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private neverSeenTimer: ReturnType<typeof setTimeout> | null = null
  /** Since when the connection has been missing (null = present). */
  private downSince: number | null = null
  private state: ConnState = { kind: 'connecting', since: Date.now() }
  private tokens = RATE_PER_SECOND
  private tokensAt = Date.now()
  private ready = false
  private authenticated = false
  private handshakeFailures = 0
  /** Used to discard responses from an old connection. */
  private generation = 0
  hello: RemoteServerHello | null = null
  /** Last byte received from the Mac (messages or responses). */
  lastRx = Date.now()
  private liveness: ReturnType<typeof setInterval> | null = null

  /** `first` stays only here: after a successful `pair` it is replaced by `auth`, so the one-time code and the password do not stay in memory. */
  constructor(options: ClientOptions, first: FirstMessage) {
    this.o = options
    this.first = first
  }

  get isReady(): boolean {
    return this.ready
  }

  get current(): ConnState {
    return this.state
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.set({ kind: 'connecting', since: Date.now() })
    this.startLiveness()
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.liveness) clearInterval(this.liveness)
    this.liveness = null
    this.teardown(new Error('Disconnected'))
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  /** The app returns to the foreground or the user taps "Retry": no waiting for the backoff. */
  reconnectNow(): void {
    if (this.stopped || this.ready) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (!this.link) this.connect()
  }

  request<T = unknown>(command: RemoteCommand): Promise<T> {
    if (!this.session || !this.link || !this.ready) return Promise.reject(new Error('offline'))
    if (!this.take()) return Promise.reject(new Error(t('Too many requests. Slow down.')))
    const withImages = (command.type === 'session.send' || command.type === 'session.create') && !!command.attachments?.length
    return this.rawRequest<T>(command, withImages ? ATTACH_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
  }

  /**
   * Checks that the Mac responds (re-reads the snapshot, which also serves to realign). If it does not respond the connection
   * is considered lost and reconnection restarts. Resolves with the snapshot, or null if there is no connection.
   */
  async probe(): Promise<RemoteSnapshot | null> {
    if (!this.ready) {
      this.reconnectNow()
      return null
    }
    const generation = this.generation
    try {
      return await this.rawRequest<RemoteSnapshot>({ type: 'hello' }, PROBE_TIMEOUT_MS)
    } catch (error) {
      this.lost(generation, error instanceof Error ? error.message : 'No answer')
      return null
    }
  }

  private startLiveness(): void {
    if (this.liveness) return
    this.liveness = setInterval(() => {
      if (this.ready && Date.now() - this.lastRx > SILENT_AFTER_MS) void this.probe()
    }, LIVENESS_EVERY_MS)
  }

  private take(): boolean {
    const now = Date.now()
    this.tokens = Math.min(RATE_PER_SECOND * 2, this.tokens + ((now - this.tokensAt) / 1000) * RATE_PER_SECOND)
    this.tokensAt = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }

  private rawRequest<T>(command: RemoteCommand, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const session = this.session
    const link = this.link
    if (!session || !link) return Promise.reject(new Error('offline'))
    return new Promise<T>((resolve, reject) => {
      const rid = `m${++this.nextRid}`
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        reject(new Error(t('The Mac did not answer in time.')))
      }, timeoutMs)
      this.pending.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer })
      const message: ToRemoteHost = { rid, command }
      try {
        for (const bytes of session.seal(message)) link.send(bytes)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(rid)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  // ── Connection ──

  private set(state: ConnState): void {
    this.state = state
    this.o.onState(state)
  }

  /** Final state: everything stops and no retry. */
  private finalState(state: ConnState): void {
    this.stop()
    this.set(state)
  }

  private connect(): void {
    if (this.stopped) return
    const generation = ++this.generation
    this.attempts++
    const link = this.o.createLink()
    this.link = link
    this.session = null
    let handshake = this.newHandshake()
    /** False until the Mac's response to the handshake's first message has arrived. */
    let helloDone = false
    /** We sent the handshake's first message and are waiting for the Mac's response. */
    let awaitingHello = false
    link.onReady(() => {
      if (generation !== this.generation) return
      // Every "ready" (also a Mac back on the same relay) starts over: state back to "connecting" and a new time limit.
      this.resetSession()
      handshake = this.newHandshake()
      helloDone = false
      this.clearNeverSeen()
      this.set(this.everConnected ? { kind: 'reconnecting', since: this.downSince ?? Date.now() } : { kind: 'connecting', since: Date.now() })
      this.armConnectTimer(generation)
      try {
        awaitingHello = true
        link.send(handshake.start())
      } catch (error) {
        this.lost(generation, error instanceof Error ? error.message : String(error))
      }
    })
    link.onMacStatus?.((status) => {
      if (generation !== this.generation) return
      // The Mac disappeared: the encrypted session is gone and no handshake response is awaited anymore.
      if (!status.online) awaitingHello = false
      this.onMacStatus(generation, status)
    })
    link.onBytes((bytes) => {
      if (generation !== this.generation) return
      this.lastRx = Date.now()
      try {
        if (!helloDone) {
          let done: ReturnType<typeof handshake.finish>
          try {
            done = handshake.finish(bytes)
          } catch (error) {
            // The Mac is there but does not have the key we know: after two in a row it is not a corrupted message.
            if (++this.handshakeFailures >= HANDSHAKE_FAILURES_FOR_KEY_CHANGE) return this.finalState({ kind: 'key-changed' })
            throw error
          }
          this.handshakeFailures = 0
          helloDone = true
          awaitingHello = false
          this.session = done.session
          this.hello = done.hello
          if (this.connectTimer) clearTimeout(this.connectTimer)
          this.connectTimer = null
          this.sendFirst(done.session, link)
          return
        }
        const message = this.session!.open<FromRemoteHost>(bytes)
        if (message) this.dispatch(generation, message)
      } catch (error) {
        // Decryption or protocol: the connection cannot be recovered, it is closed again and retried.
        this.lost(generation, error instanceof Error ? error.message : String(error))
      }
    })
    link.onClose((reason, rejected) => {
      if (generation !== this.generation) return
      // The Mac closed on us after our first message and without replying: typical of a key that is no longer its own.
      if (awaitingHello && rejected && ++this.handshakeFailures >= HANDSHAKE_FAILURES_FOR_KEY_CHANGE) return this.finalState({ kind: 'key-changed' })
      this.lost(generation, reason)
    })
    this.armConnectTimer(generation)
    link.open()
  }

  private armConnectTimer(generation: number): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = setTimeout(() => {
      if (generation === this.generation && !this.session && this.state.kind !== 'mac-offline') this.lost(generation, 'Timed out')
    }, CONNECT_TIMEOUT_MS)
  }

  private newHandshake() {
    return clientHandshake({ macPublicKey: this.o.macPublicKey, hello: { device: this.o.deviceLabel, locale: this.o.locale } })
  }

  /** After the handshake the connection is not authenticated: the first message is `pair` or `auth`, signed over the handshake hash. */
  private sendFirst(session: RemoteSession, link: RemoteLink): void {
    const hash = session.handshakeHash
    const { deviceKey } = this.o
    const first = this.first
    const message: RemoteFirstMessage =
      first.mode === 'auth'
        ? { type: 'auth', deviceId: first.deviceId, sig: signChannelBinding(deviceKey.secretKey, 'auth', hash) }
        : {
            type: 'pair',
            token: first.token,
            device: { publicKey: toBase64Url(deviceKey.publicKey), name: first.device.name, platform: first.device.platform },
            ...(first.password ? { password: first.password } : {}),
            sig: signChannelBinding(deviceKey.secretKey, 'pair', hash)
          }
    for (const bytes of session.seal(message)) link.send(bytes)
  }

  /** The Mac's state from the relay. Offline: wait (the relay connection stays open); online: `onReady` arrives. */
  private onMacStatus(generation: number, status: RemoteMacStatus): void {
    if (status.online) return
    this.resetSession()
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
    // The Mac regenerated its key: it will not come back from this id.
    if (status.reason === 'rekeyed') return this.finalState({ kind: 'key-changed' })
    this.set({ kind: 'mac-offline', since: status.since, reason: status.reason, at: this.state.kind === 'mac-offline' ? this.state.at : Date.now() })
    // A Mac we had already connected to and that the relay has never seen: the id is no longer its own, i.e. the key changed.
    this.clearNeverSeen()
    if (status.since === null && this.first.mode === 'auth' && this.everConnected) {
      this.neverSeenTimer = setTimeout(() => {
        if (generation === this.generation && this.state.kind === 'mac-offline') this.finalState({ kind: 'key-changed' })
      }, NEVER_SEEN_GRACE_MS)
    }
  }

  private clearNeverSeen(): void {
    if (this.neverSeenTimer) clearTimeout(this.neverSeenTimer)
    this.neverSeenTimer = null
  }

  /** Forgets the encrypted session (not the connection): needed when the Mac disappears or returns on the same relay. */
  private resetSession(): void {
    this.ready = false
    this.authenticated = false
    this.session = null
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Disconnected'))
    }
    this.pending.clear()
  }

  private async afterAuth(generation: number): Promise<void> {
    try {
      const snapshot = await this.rawRequest<RemoteSnapshot>({ type: 'hello' })
      if (generation !== this.generation) return
      const reconnect = this.everConnected
      this.ready = true
      this.attempts = 0
      this.downSince = null
      this.set({ kind: 'syncing', since: Date.now() })
      // The hello command is the only one that passes before `ready`; the rest (watch, page) uses `request`.
      await this.o.onHello(snapshot, this.hello!, reconnect)
      if (generation !== this.generation) return
      this.everConnected = true
      this.set({ kind: 'connected', since: Date.now() })
    } catch (error) {
      if (generation === this.generation) this.lost(generation, error instanceof Error ? error.message : String(error))
    }
  }

  private dispatch(generation: number, message: FromRemoteHost): void {
    if (message.kind === 'auth') return this.onAuth(generation, message)
    if (message.kind === 'event') {
      this.o.onEvent(message.event)
      return
    }
    const waiter = this.pending.get(message.rid)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.pending.delete(message.rid)
    if (message.ok) waiter.resolve(message.data)
    else waiter.reject(new Error(message.error))
  }

  /** Outcome of pair/auth, or revocation notice with an open connection. */
  private onAuth(generation: number, result: RemoteAuthResult): void {
    if (result.ok) {
      if (this.authenticated) return
      this.authenticated = true
      this.first = { mode: 'auth', deviceId: result.deviceId }
      this.o.onAuthenticated(result, this.hello!)
      void this.afterAuth(generation)
      return
    }
    // During pairing every rejection (even "revoked" or "unknown") is a failed pairing, not a revocation of
    // an already-paired phone: no retry and nothing else is touched.
    if (this.first.mode === 'pair') return this.finalState({ kind: 'denied', code: result.code, error: result.error })
    // Already-paired phone: revoked or unknown, or the signature is no longer valid (different device key): the pairing is over.
    if (result.code === 'device-revoked' || result.code === 'unknown-device' || result.code === 'bad-signature') return this.finalState({ kind: 'revoked' })
    if (result.code === 'remote-disabled') {
      this.teardown(new Error('disabled'))
      this.set({ kind: 'disabled', since: Date.now() })
      this.scheduleRetry(15_000)
      return
    }
    this.lost(generation, result.error)
  }

  private teardown(error: Error): void {
    this.generation++
    this.ready = false
    this.authenticated = false
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
    this.clearNeverSeen()
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
    const link = this.link
    this.link = null
    this.session = null
    try {
      link?.close()
    } catch {
      // already closed
    }
  }

  private scheduleRetry(delay: number): void {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private lost(generation: number, reason?: string): void {
    if (generation !== this.generation || this.stopped) return
    this.teardown(new Error(reason ?? 'Connection lost'))
    const since = (this.downSince ??= Date.now())
    const unreachable = this.attempts >= UNREACHABLE_AFTER_ATTEMPTS || Date.now() - since >= UNREACHABLE_AFTER_MS
    if (unreachable) this.set({ kind: 'unreachable', since, reason })
    else this.set(this.everConnected ? { kind: 'reconnecting', since, reason } : { kind: 'connecting', since })
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)]
    this.scheduleRetry(delay * (0.8 + Math.random() * 0.4))
  }
}
