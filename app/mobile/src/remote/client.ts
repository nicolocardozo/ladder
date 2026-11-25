// Client del canale remoto (protocollo 2): handshake Noise NK (iniziatore, chiave pubblica del Mac), poi il primo messaggio firmato
// (`pair` la prima volta, `auth` le volte dopo), poi `hello` e i comandi con rid, gli eventi, la riconnessione con backoff.
// Non conosce lo store: parla con chi lo usa tramite callback. Limiti dell'host rispettati: 20 comandi/s (qui 15/s),
// 1 MiB per comando, silenzio massimo 120 s (ci pensano i ping di relay e server).
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
  /** Collegato, ma sta rileggendo le chat dopo la riconnessione. */
  | { kind: 'syncing'; since: number }
  | { kind: 'unreachable'; since: number; reason?: string }
  /** Il relay è raggiungibile ma il Mac no: `reason` e `since` (ultima volta che il relay l'ha visto) li dà il relay. */
  | { kind: 'mac-offline'; since: number | null; reason: RemoteOfflineReason; /** Da quando il telefono lo vede offline (orologio del telefono). */ at: number }
  /** "Access from your phone" è spento sul Mac: si riprova con calma. */
  | { kind: 'disabled'; since: number }
  // Stati finali: il client si ferma e chi lo usa mostra una schermata.
  /** Il Mac ha revocato questo telefono (o non lo conosce più). */
  | { kind: 'revoked' }
  /** La chiave del Mac non è più quella dell'abbinamento. */
  | { kind: 'key-changed' }
  /** L'abbinamento è stato rifiutato (codice scaduto, password sbagliata…). */
  | { kind: 'denied'; code: RemoteAuthErrorCode; error: string }

/** Come il telefono si presenta dopo l'handshake. */
export type FirstMessage =
  | { mode: 'auth'; deviceId: string }
  | { mode: 'pair'; token: string; password?: string; device: { name: string; platform: RemotePlatform } }

export interface ClientOptions {
  createLink: LinkFactory
  macPublicKey: Uint8Array
  /** Chiave Ed25519 del telefono (la privata non esce da qui: serve solo a firmare). */
  deviceKey: { secretKey: Uint8Array; publicKey: Uint8Array }
  /** Nome del dispositivo per l'hello dell'handshake (solo diagnostica sul Mac). */
  deviceLabel: string
  locale: Locale
  onEvent(event: RemoteEvent): void
  /** Il Mac ha accettato `pair`/`auth`. */
  onAuthenticated(result: Extract<RemoteAuthResult, { ok: true }>, hello: RemoteServerHello): void
  /** Dopo ogni hello riuscito (anche dopo una riconnessione): chi usa il client rilegge ciò che segue. Il client resta in 'syncing' finché non risolve. */
  onHello(snapshot: RemoteSnapshot, hello: RemoteServerHello, reconnect: boolean): Promise<void>
  onState(state: ConnState): void
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000]
const CONNECT_TIMEOUT_MS = 8_000
const REQUEST_TIMEOUT_MS = 25_000
/** Un comando con immagini porta fino a ~3 MB: su una rete lenta ci vuole più tempo. */
const ATTACH_TIMEOUT_MS = 90_000
/** Dopo tanto tempo (o tentativi) senza collegamento si passa da "Reconnecting" a "Mac unreachable". */
const UNREACHABLE_AFTER_MS = 20_000
const UNREACHABLE_AFTER_ATTEMPTS = 3
const RATE_PER_SECOND = 15
/** Con il collegamento in primo piano e silenzio da tanto, si controlla che il Mac risponda. */
const LIVENESS_EVERY_MS = 30_000
const SILENT_AFTER_MS = 60_000
const PROBE_TIMEOUT_MS = 6_000
/**
 * Handshake falliti di fila prima di dire che la chiave del Mac è cambiata (uno solo può essere un messaggio rovinato o un Mac
 * che si riavvia). Con una chiave sbagliata il Mac non riesce a decifrare il primo messaggio e ci chiude senza rispondere: conta
 * solo una chiusura decisa dal Mac (`rejected`) dopo il nostro primo messaggio e prima della sua risposta; un guasto di rete
 * o un Mac che sparisce non contano.
 */
const HANDSHAKE_FAILURES_FOR_KEY_CHANGE = 3
/** Il relay dice "mai visto" per un Mac con cui ci eravamo già collegati: dopo questa attesa si conclude che la chiave (e l'id) sono cambiati. */
const NEVER_SEEN_GRACE_MS = 3_000

export class RemoteClient {
  private readonly o: ClientOptions
  /** Come ci presentiamo alla prossima connessione: dopo un `pair` riuscito diventa `auth` (il codice monouso non vale più). */
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
  /** Da quando manca il collegamento (null = c'è). */
  private downSince: number | null = null
  private state: ConnState = { kind: 'connecting', since: Date.now() }
  private tokens = RATE_PER_SECOND
  private tokensAt = Date.now()
  private ready = false
  private authenticated = false
  private handshakeFailures = 0
  /** Serve a scartare le risposte di un collegamento vecchio. */
  private generation = 0
  hello: RemoteServerHello | null = null
  /** Ultimo byte ricevuto dal Mac (messaggi o risposte). */
  lastRx = Date.now()
  private liveness: ReturnType<typeof setInterval> | null = null

  /** `first` resta solo qui: dopo un `pair` riuscito viene sostituito da `auth`, così il codice monouso e la password non restano in memoria. */
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
    const withImages = (command.type === 'session.send' || command.type === 'session.create') && !!command.attachments?.length
    return this.rawRequest<T>(command, withImages ? ATTACH_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
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

  /** Stato finale: si ferma tutto e non si riprova. */
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
    /** Falso finché non è arrivata la risposta del Mac al primo messaggio dell'handshake. */
    let helloDone = false
    /** Abbiamo mandato il primo messaggio dell'handshake e aspettiamo la risposta del Mac. */
    let awaitingHello = false
    link.onReady(() => {
      if (generation !== this.generation) return
      // Ogni "pronto" (anche un Mac tornato sullo stesso relay) riparte da capo: stato di nuovo "in connessione" e nuovo limite di tempo.
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
      // Il Mac è sparito: la sessione cifrata non c'è più e non si aspetta più nessuna risposta dell'handshake.
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
            // Il Mac c'è ma non ha la chiave che conosciamo: dopo due volte di fila non è un messaggio rovinato.
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
        // Decifratura o protocollo: il collegamento non si recupera, si richiude e si riprova.
        this.lost(generation, error instanceof Error ? error.message : String(error))
      }
    })
    link.onClose((reason, rejected) => {
      if (generation !== this.generation) return
      // Il Mac ci ha chiusi dopo il nostro primo messaggio e senza rispondere: tipico di una chiave che non è più la sua.
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

  /** Dopo l'handshake la connessione non è autenticata: il primo messaggio è `pair` o `auth`, firmato sull'hash dell'handshake. */
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

  /** Stato del Mac dal relay. Offline: si aspetta (il collegamento al relay resta aperto); online: arriva `onReady`. */
  private onMacStatus(generation: number, status: RemoteMacStatus): void {
    if (status.online) return
    this.resetSession()
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
    // Il Mac ha rigenerato la chiave: da questo id non tornerà più.
    if (status.reason === 'rekeyed') return this.finalState({ kind: 'key-changed' })
    this.set({ kind: 'mac-offline', since: status.since, reason: status.reason, at: this.state.kind === 'mac-offline' ? this.state.at : Date.now() })
    // Un Mac con cui eravamo già collegati e che il relay non ha mai visto: l'id non è più il suo, cioè la chiave è cambiata.
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

  /** Dimentica la sessione cifrata (non il collegamento): serve quando il Mac sparisce o torna sullo stesso relay. */
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
      // Il comando hello è l'unico che passa prima di `ready`; il resto (watch, page) usa `request`.
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

  /** Esito di pair/auth, o avviso di revoca a connessione aperta. */
  private onAuth(generation: number, result: RemoteAuthResult): void {
    if (result.ok) {
      if (this.authenticated) return
      this.authenticated = true
      this.first = { mode: 'auth', deviceId: result.deviceId }
      this.o.onAuthenticated(result, this.hello!)
      void this.afterAuth(generation)
      return
    }
    // Durante l'abbinamento ogni rifiuto (anche "revocato" o "sconosciuto") è un abbinamento non riuscito, non una revoca di
    // un telefono già abbinato: non si ritenta e non si tocca nient'altro.
    if (this.first.mode === 'pair') return this.finalState({ kind: 'denied', code: result.code, error: result.error })
    // Telefono già abbinato: revocato o sconosciuto, oppure la firma non vale più (chiave del dispositivo diversa): l'abbinamento è finito.
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
      // già chiuso
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
