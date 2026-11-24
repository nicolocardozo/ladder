// Client del canale remoto: handshake Noise (iniziatore, chiave pubblica del Mac), hello, comandi con rid, eventi,
// riconnessione con backoff + nuovo hello. Non conosce lo store: parla con chi lo usa tramite callback.
// Limiti dell'host rispettati: 20 comandi/s (qui 15/s a regime), 1 MiB per comando, silenzio massimo 120 s (ci pensano i ping del server).
import type { FromRemoteHost, RemoteCommand, RemoteEvent, RemoteServerHello, RemoteSnapshot, ToRemoteHost } from '@shared/protocol'
import { t, type Locale } from '@shared/i18n'
import { clientHandshake, type RemoteSession } from '@shared/remote/session'
import type { LinkFactory, RemoteLink } from './link'

export type ConnState =
  | { kind: 'connecting'; since: number }
  | { kind: 'connected'; since: number }
  | { kind: 'reconnecting'; since: number; reason?: string }
  /** Collegato, ma sta rileggendo le chat dopo la riconnessione. */
  | { kind: 'syncing'; since: number }
  | { kind: 'unreachable'; since: number; reason?: string }

export interface ClientOptions {
  createLink: LinkFactory
  macPublicKey: Uint8Array
  device: string
  locale: Locale
  onEvent(event: RemoteEvent): void
  /** Dopo ogni hello riuscito (anche dopo una riconnessione): chi usa il client rilegge ciò che segue. Il client resta in 'syncing' finché non risolve. */
  onHello(snapshot: RemoteSnapshot, hello: RemoteServerHello, reconnect: boolean): Promise<void>
  onState(state: ConnState): void
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000]
const CONNECT_TIMEOUT_MS = 8_000
const REQUEST_TIMEOUT_MS = 25_000
/** Dopo tanto tempo (o tentativi) senza collegamento si passa da "Reconnecting" a "Mac unreachable". */
const UNREACHABLE_AFTER_MS = 20_000
const UNREACHABLE_AFTER_ATTEMPTS = 3
const RATE_PER_SECOND = 15
/** Con il collegamento in primo piano e silenzio da tanto, si controlla che il Mac risponda. */
const LIVENESS_EVERY_MS = 30_000
const SILENT_AFTER_MS = 60_000
const PROBE_TIMEOUT_MS = 6_000

export class RemoteClient {
  private readonly o: ClientOptions
  private link: RemoteLink | null = null
  private session: RemoteSession | null = null
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private nextRid = 0
  private stopped = true
  private everConnected = false
  private attempts = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  /** Da quando manca il collegamento (null = c'è). */
  private downSince: number | null = null
  private state: ConnState = { kind: 'connecting', since: Date.now() }
  private tokens = RATE_PER_SECOND
  private tokensAt = Date.now()
  private ready = false
  /** Serve a scartare le risposte di un collegamento vecchio. */
  private generation = 0
  hello: RemoteServerHello | null = null
  /** Ultimo byte ricevuto dal Mac (messaggi o risposte). */
  lastRx = Date.now()
  private liveness: ReturnType<typeof setInterval> | null = null

  constructor(options: ClientOptions) {
    this.o = options
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

  /** L'app torna in primo piano o l'utente tocca "Retry": niente attesa del backoff. */
  reconnectNow(): void {
    if (this.stopped || this.ready) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (!this.link) this.connect()
  }

  request<T = unknown>(command: RemoteCommand): Promise<T> {
    if (!this.session || !this.link || !this.ready) return Promise.reject(new Error('offline'))
    if (!this.take()) return Promise.reject(new Error(t('Too many requests. Slow down.')))
    return this.rawRequest<T>(command)
  }

  /**
   * Controlla che il Mac risponda (rilegge lo snapshot, che serve anche a riallinearsi). Se non risponde il collegamento
   * si considera perso e riparte la riconnessione. Risolve con lo snapshot, o null se non c'è collegamento.
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

  // ── Connessione ──

  private set(state: ConnState): void {
    this.state = state
    this.o.onState(state)
  }

  private connect(): void {
    if (this.stopped) return
    const generation = ++this.generation
    this.attempts++
    const handshake = clientHandshake({ macPublicKey: this.o.macPublicKey, hello: { device: this.o.device, locale: this.o.locale } })
    const link = this.o.createLink()
    this.link = link
    this.session = null
    let helloDone = false
    link.onOpen(() => {
      if (generation !== this.generation) return
      try {
        link.send(handshake.start())
      } catch (error) {
        this.lost(generation, error instanceof Error ? error.message : String(error))
      }
    })
    link.onBytes((bytes) => {
      if (generation !== this.generation) return
      this.lastRx = Date.now()
      try {
        if (!helloDone) {
          helloDone = true
          const { session, hello } = handshake.finish(bytes)
          this.session = session
          this.hello = hello
          if (this.connectTimer) clearTimeout(this.connectTimer)
          this.connectTimer = null
          void this.afterHandshake(generation)
          return
        }
        const message = this.session!.open<FromRemoteHost>(bytes)
        if (message) this.dispatch(message)
      } catch (error) {
        // Decifratura o protocollo: il collegamento non si recupera, si richiude e si riprova.
        this.lost(generation, error instanceof Error ? error.message : String(error))
      }
    })
    link.onClose((reason) => {
      if (generation === this.generation) this.lost(generation, reason)
    })
    this.connectTimer = setTimeout(() => {
      if (generation === this.generation && !this.ready) this.lost(generation, 'Timed out')
    }, CONNECT_TIMEOUT_MS)
    link.open()
  }

  private async afterHandshake(generation: number): Promise<void> {
    try {
      const snapshot = await this.rawRequest<RemoteSnapshot>({ type: 'hello' })
      if (generation !== this.generation) return
      const reconnect = this.everConnected
      this.ready = true
      this.attempts = 0
      this.downSince = null
      this.set({ kind: 'syncing', since: Date.now() })
      // Il comando hello è l'unico che passa prima di `ready`; il resto (watch, page) usa `request`.
      await this.o.onHello(snapshot, this.hello!, reconnect)
      if (generation !== this.generation) return
      this.everConnected = true
      this.set({ kind: 'connected', since: Date.now() })
    } catch (error) {
      if (generation === this.generation) this.lost(generation, error instanceof Error ? error.message : String(error))
    }
  }

  private dispatch(message: FromRemoteHost): void {
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

  private teardown(error: Error): void {
    this.generation++
    this.ready = false
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
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
      // già chiuso
    }
  }

  private lost(generation: number, reason?: string): void {
    if (generation !== this.generation || this.stopped) return
    this.teardown(new Error(reason ?? 'Connection lost'))
    const since = (this.downSince ??= Date.now())
    const unreachable = this.attempts >= UNREACHABLE_AFTER_ATTEMPTS || Date.now() - since >= UNREACHABLE_AFTER_MS
    if (unreachable) this.set({ kind: 'unreachable', since, reason })
    else this.set(this.everConnected ? { kind: 'reconnecting', since, reason } : { kind: 'connecting', since })
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)]
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay * (0.8 + Math.random() * 0.4))
  }
}
