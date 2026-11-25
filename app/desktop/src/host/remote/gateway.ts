// Gateway remoto: porta il protocollo della finestra su una connessione cifrata (Noise NK), per il telefono.
// Non sa nulla del trasporto (WebSocket oggi, relay con LAD-50): riceve un RemoteLink già aperto.
// Import relativi (niente alias @shared): il file è provato in-process con `node --test`.
import { REMOTE_MAX_ATTACH_COMMAND, REMOTE_MAX_ATTACHMENTS, REMOTE_MAX_COMMAND } from '../../shared/protocol.ts'
import type { AgentId, AgentStatus, FromRemoteHost, HostCommand, HostEvent, PermissionLevel, RemoteAgentStatus, RemoteAuthErrorCode, RemoteCommand, RemoteEvent, RemoteLogAction, RemoteLogEntry, RemotePage, RemoteProfile, RemoteProjectDefaults, RemoteSessionCreate, RemoteSnapshot, RequestResponse, SessionSummary, SlashCommand } from '../../shared/protocol.ts'
import { isLocale, plural, t, type Locale } from '../../shared/i18n.ts'
import { serverHandshake, type RemoteSession } from '../../shared/remote/session.ts'
import type { NoiseKeyPair } from '../../shared/remote/noise.ts'
import { authErrorText, type DeviceRow, type RemoteAccess } from './access.ts'
import { searchFiles } from './file-search.ts'
import { carriesAttachmentsShape, declaredAttachments, isForwardedEventType, parseRemoteMessage, RemoteCommandError } from './allowlist.ts'
import { imagePlaceholder } from '../../shared/image-placeholder.ts'

/** Un canale di byte già aperto: un messaggio = un messaggio Noise. Lo implementano il WebSocket locale e (LAD-50) il relay. */
export interface RemoteLink {
  send(bytes: Uint8Array): void
  close(): void
  onBytes(handler: (bytes: Uint8Array) => void): void
  onClose(handler: () => void): void
  /** Byte in coda non ancora partiti; se manca, nessun controllo di coda. */
  buffered?(): number
  /** Il trasporto sa che l'altro capo è vivo (pong del WebSocket): conta come attività anche senza messaggi Noise. */
  onAlive?(handler: () => void): void
}

/** Quello che il gateway usa dell'Host. */
export interface RemoteHostApi {
  snapshot(): Promise<Extract<HostEvent, { type: 'snapshot' }>>
  handle(command: Exclude<RemoteCommand, { type: 'session.page' | 'session.watch' | 'device.push.set' | 'device.notify.set' | 'device.state' | 'project.sessions.archived' | 'session.create' | 'project.files.search' | 'agents.usage' }> | Extract<HostCommand, { type: 'session.create' | 'agents.usage' }>, origin: object): Promise<unknown>
  pageItems(sessionId: string, before?: number, limit?: number): RemotePage
  /** Tetto di permesso per progetto e preferenza di invio, per l'istantanea; manca = nessun tetto e 'steer'. */
  remoteExtras?(): Promise<{ permissionsMax: RemoteSnapshot['permissionsMax']; busySend: RemoteSnapshot['prefs']['busySend']; defaults?: RemoteSnapshot['defaults'] }>
  /**
   * LAD-89: controlli di `session.create` che richiedono lo stato dell'host (progetto, agente ammesso e disponibile, modello, effort, account).
   * Lancia un errore tradotto se qualcosa non va; torna i nomi per il log. Manca = nessun controllo oltre a quelli di createSession.
   */
  checkCreate?(command: RemoteSessionCreate): Promise<{ agent: string; project: string }>
  /**
   * LAD-90: agente e account di `agents.usage` controllati e normalizzati: agente sconosciuto o account inesistente (o di un altro agente) = errore;
   * il profilo predefinito (assente o `default:*`) torna senza `profileId`. Manca = si normalizza solo `default:*`.
   */
  usageTarget?(agent: string, profileId?: string): { agent: string; profileId?: string }
  /** LAD-92: elenco dei file di un progetto (percorsi relativi, .gitignore rispettato) per `project.files.search`. Errore tradotto se il progetto non esiste. */
  projectFiles?(projectId: string): Promise<string[]>
  /** Sessioni archiviate di un progetto (project.sessions.archived). */
  archivedSessions?(projectId: string, before?: number, limit?: number): SessionSummary[]
  connectionClosed(origin: object): void
  /** Titolo e opzioni di una richiesta, per il log delle azioni remote; manca = il log scrive solo "Responded". */
  requestInfo?(sessionId: string, requestId: string): { title: string; options: { id: string; kind: 'allow' | 'allow-always' | 'deny' }[] } | null
}

export interface RemoteGatewayOptions {
  host: RemoteHostApi
  identity: NoiseKeyPair
  /** LAD-51: dispositivi, codice di abbinamento e log. Ogni connessione deve autenticarsi con questo prima di qualunque comando. */
  access: RemoteAccess
  /** Nome del Mac e versione di Ladder, per l'hello. */
  macName: string
  appVersion: string
  log?: (message: string) => void
  /** Orologio; solo le prove lo cambiano. */
  now?: () => number
  /** Silenzio massimo dopo l'handshake; solo le prove lo cambiano. */
  idleTimeoutMs?: number
  /** LAD-54: chiamata quando cambia il numero di telefoni collegati (autenticazione riuscita o connessione chiusa). */
  onClients?: (count: number) => void
  /** LAD-51: chiamata quando un dispositivo si collega o si scollega del tutto (per lo stato della finestra). */
  onDevices?: () => void
  /** LAD-51: nuova voce nel log delle azioni remote. */
  onLog?: (entry: RemoteLogEntry) => void
}

/** LAD-53: per quanto tempo vale "in primo piano" senza nuove notizie dalla connessione. */
export const FOREGROUND_TTL_MS = 30_000
export const MAX_WATCHED = 8
const MAX_IN_FLIGHT = 64
/** Oltre questa coda di invio la connessione è troppo lenta e si chiude. */
const MAX_BUFFERED = 64 * 1024 * 1024
/** Dall'apertura della connessione all'autenticazione: handshake Noise compreso. */
const HANDSHAKE_TIMEOUT_MS = 10_000
/** Connessioni aperte ma non ancora autenticate: oltre, le nuove si chiudono (non tolgono posto ai telefoni abbinati). */
export const MAX_UNAUTHENTICATED = 4
/** Connessioni remote contemporanee e silenzio massimo dopo l'handshake (messaggi o pong del trasporto). */
export const MAX_CONNECTIONS = 8
export const IDLE_TIMEOUT_MS = 120_000
/** Comandi al secondo (a regime) e raffica massima per connessione; oltre rispondono con un errore, e dopo troppi rifiuti di fila la connessione si chiude. */
/** LAD-90: una lettura vera dei limiti d'uso ogni 60 secondi per agente+profilo e connessione; nel mezzo vale l'ultimo valore. */
export const USAGE_REFRESH_MS = 60_000
const MAX_USAGE_KEYS = 32
const MAX_USAGE_CACHE = 64
/** LAD-89: nuove sessioni dal telefono, per dispositivo: a raffica 3, poi 5 al minuto. */
export const CREATE_BURST = 3
export const CREATE_PER_MINUTE = 5
/** LAD-92: immagini dal telefono, per dispositivo: a raffica 6, poi 10 al minuto (contano su `session.send` e `session.create`). */
export const IMAGE_BURST = 6
export const IMAGE_PER_MINUTE = 10
/** LAD-92: ricerche di file (menzioni `@`), per dispositivo: a raffica 10, poi 4 al secondo. L'elenco dei file di un progetto resta in cache 10 secondi. */
export const SEARCH_BURST = 10
export const SEARCH_PER_SECOND = 4
export const FILES_CACHE_MS = 10_000
const MAX_FILES_CACHE = 16
/** Attesa prima di rimandare i predefiniti (più cambi ravvicinati = un solo evento). */
const DEFAULTS_DEBOUNCE_MS = 300
export const RATE_PER_SECOND = 20
export const RATE_BURST = 40
const MAX_REJECTED_IN_A_ROW = 100
/** LAD-92: un allegato non valido pesa come tanti rifiuti: 5 di fila chiudono la connessione. */
const ATTACHMENT_ERROR_WEIGHT = 20

/** Istantanea ridotta: niente bozze, terminali, scorciatoie, collegamenti, profili; della UI solo gruppi e seenAt. */
/** LAD-90: niente email dell'account né percorso della CLI verso il telefono. */
export function toRemoteAgent(status: AgentStatus): RemoteAgentStatus {
  const { email: _email, path: _path, ...rest } = status
  return { ...rest, error: status.error ? safeError(status.error) : null }
}

/** Di un agente contano per i predefiniti disponibilità e modelli (con effort e predefiniti), non i limiti d'uso. */
function agentSignature(status: AgentStatus): string {
  return JSON.stringify([status.available, status.models.map((m) => [m.id, m.isDefault ?? false, m.defaultEffort ?? null, m.efforts ?? null])])
}

/** L'errore di un agente può citare percorsi o output della CLI: al telefono va una riga breve senza percorsi. */
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

/** Una connessione remota: è anche l'`origin` che l'Host associa alle iscrizioni. */
class RemoteConnection {
  readonly link: RemoteLink
  session: RemoteSession | null = null
  /** Nome dichiarato nell'hello (non autenticato): solo per il log di diagnostica. */
  device = ''
  /** LAD-51: dispositivo autenticato; null finché non ha mandato `pair` o `auth`. */
  auth: DeviceRow | null = null
  authenticating = false
  /** LAD-53: lingua dell'app dall'hello (non autenticato: si salva solo dopo l'autenticazione). */
  locale: Locale | null = null
  /** LAD-53: ultimo comando ricevuto (traffico dell'applicazione: pong e keepalive del trasporto non contano). */
  activeAt = 0
  /** Sessioni seguite, dalla meno recente (ordine di inserimento della Map). */
  readonly watched = new Map<string, true>()
  inFlight = 0
  closed = false
  handshakeTimer: ReturnType<typeof setTimeout> | null = null
  idleTimer: ReturnType<typeof setTimeout> | null = null
  /** Secchiello di gettoni per il limite di richieste. */
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
      // In inglese `t` restituisce la chiave stessa: il testo breve è "Full".
      const label = t('Full access (short)')
      return label === 'Full access (short)' ? 'Full' : label
    }
  }
}

/** Riassunto breve per il log: "Approved: Run command"; mai il testo di una risposta libera. */
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
  /** LAD-53: ultimo device.state per dispositivo. */
  private readonly foreground = new Map<string, { foreground: boolean; at: number; conn: RemoteConnection }>()
  /** LAD-90: ultimo valore dei limiti letto per agente+profilo (di qualunque connessione). */
  private readonly usageCache = new Map<string, RemoteAgentStatus>()
  /** LAD-90: ultima lettura vera per dispositivo (non per connessione: riconnettersi non azzera il limite) e agente+account. */
  private readonly usageReads = new Map<string, Map<string, number>>()
  /** LAD-89: gettoni delle nuove sessioni per dispositivo. */
  private readonly createBuckets = new Map<string, { tokens: number; at: number }>()
  /** LAD-89: generazione dell'ultimo invio di predefiniti (un invio più vecchio che finisce dopo è scartato) e firma degli agenti già visti. */
  private defaultsGen = 0
  private readonly agentSigs = new Map<string, string>()
  /** LAD-92: gettoni delle immagini e delle ricerche per dispositivo; elenchi di file per progetto (e quelli in lettura adesso). */
  private readonly imageBuckets = new Map<string, { tokens: number; at: number }>()
  private readonly searchBuckets = new Map<string, { tokens: number; at: number }>()
  private readonly filesCache = new Map<string, { at: number; files: string[] }>()
  private readonly filesReading = new Map<string, Promise<string[]>>()
  /** LAD-89: ultimi predefiniti mandati ai telefoni e timer dell'invio ritardato. */
  private lastDefaults = ''
  private defaultsTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: RemoteGatewayOptions) {
    this.options = options
    this.identity = options.identity
  }

  /** Nuova identità del Mac (rigenerazione della chiave): vale per le connessioni nuove. */
  setIdentity(identity: NoiseKeyPair): void {
    this.identity = identity
  }

  get size(): number {
    return this.connections.size
  }

  /** Telefoni collegati: connessioni autenticate. */
  get clients(): number {
    let n = 0
    for (const conn of this.connections) if (conn.auth) n++
    return n
  }

  /** Id dei dispositivi con almeno una connessione autenticata. */
  connectedDevices(): Set<string> {
    const ids = new Set<string>()
    for (const conn of this.connections) if (conn.auth) ids.add(conn.auth.id)
    return ids
  }

  /**
   * LAD-53: dispositivi con l'app in primo piano, per l'ultimo `device.state` del dispositivo (su qualunque connessione).
   * Vale solo se la connessione che l'ha riportato è ancora aperta e o l'ha riportato meno di 30 secondi fa o ha mandato comandi
   * negli ultimi 30 secondi: una connessione muta o caduta non toglie i push.
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

  /** Il dispositivo è stato rinominato: le connessioni aperte usano il nome nuovo (log e `viaDevice`). */
  deviceRenamed(deviceId: string, name: string): void {
    for (const conn of this.connections) if (conn.auth?.id === deviceId) conn.auth = { ...conn.auth, name }
  }

  /** Manda ai telefoni collegati le preferenze del Mac di adesso (evento `remote.prefs`). */
  async pushPrefs(): Promise<void> {
    const extras = await this.options.host.remoteExtras?.()
    const event: RemoteEvent = { type: 'remote.prefs', prefs: { busySend: extras?.busySend ?? 'steer', allowFull: this.options.access.allowFull } }
    for (const conn of this.connections) if (conn.auth) this.send(conn, { kind: 'event', event })
    // Il permesso proposto dipende da "Allow Full access from phone".
    this.pushDefaults(true)
  }

  /** 'full' proposto con "Allow Full access from phone" spento diventa 'edit': il telefono non deve proporre un livello che il Mac rifiuta. */
  private phoneDefaults(defaults: Record<string, RemoteProjectDefaults> | undefined): Record<string, RemoteProjectDefaults> {
    if (!defaults) return {}
    if (this.options.access.allowFull) return defaults
    const out: Record<string, RemoteProjectDefaults> = {}
    for (const [id, d] of Object.entries(defaults)) out[id] = d.permission === 'full' ? { ...d, permission: 'edit' } : d
    return out
  }

  /**
   * LAD-89: manda ai telefoni i predefiniti e i tetti di permesso di adesso (evento `remote.defaults`), solo se sono cambiati dall'ultimo invio.
   * Ritardato di 300 ms (più cambi = un invio); `now` salta l'attesa.
   */
  pushDefaults(now = false): void {
    if (this.defaultsTimer) clearTimeout(this.defaultsTimer)
    const run = () => {
      this.defaultsTimer = null
      // Nessun telefono: il prossimo parte da un hello fresco, e il confronto con l'ultimo invio non vale più.
      if (![...this.connections].some((c) => c.auth)) {
        this.lastDefaults = ''
        return
      }
      const gen = ++this.defaultsGen
      void this.options.host
        .remoteExtras?.()
        .then((extras) => {
          // Un invio più nuovo è partito mentre questo leggeva: il suo risultato è più recente.
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

  /** Revoca: avvisa il telefono e chiude subito tutte le connessioni di quel dispositivo. */
  disconnectDevice(deviceId: string): void {
    for (const conn of [...this.connections]) if (conn.auth?.id === deviceId) this.reject(conn, 'device-revoked')
  }

  /** Chiude tutte le connessioni, autenticate o no (rigenerazione della chiave, canale spento); i telefoni abbinati sono avvisati. */
  disconnectAll(): void {
    for (const conn of [...this.connections]) {
      if (conn.auth) this.reject(conn, 'device-revoked')
      else this.drop(conn)
    }
  }

  /** Prende in carico una connessione nuova: handshake, poi comandi. */
  accept(link: RemoteLink): void {
    // Pieno di connessioni non autenticate (o di posti): si chiude la più vecchia di quelle, non la nuova, così chi tiene occupati i posti non tiene fuori i telefoni veri.
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
          // Il timer di handshake resta: vale fino all'autenticazione (pair/auth), non solo fino al primo messaggio.
          conn.session = session
          conn.device = client.device.slice(0, 80)
          conn.locale = isLocale(client.locale) ? client.locale : null
          link.send(reply)
          this.options.log?.(`connection opened, waiting for authentication (device: ${JSON.stringify(conn.device)})`)
          return
        }
        const message = conn.session.open<unknown>(bytes)
        if (message !== null) {
          // LAD-92: dopo l'autenticazione il limite è più largo, ma solo i messaggi con immagini possono superare REMOTE_MAX_COMMAND.
          if (conn.session.lastSize > REMOTE_MAX_COMMAND && !carriesAttachmentsShape(message)) throw new Error('message too large')
          this.onMessage(conn, message)
        }
      } catch (error) {
        // Decifratura fallita, versione diversa, messaggio troppo grande, JSON rotto: la connessione non si recupera.
        this.drop(conn, error instanceof Error ? error.message : String(error))
      }
    })
  }

  /** Istantanea per il telefono: quella ridotta più tetti di permesso e preferenze del Mac. */
  private async buildSnapshot(full: Extract<HostEvent, { type: 'snapshot' }>): Promise<RemoteSnapshot> {
    const extras = (await this.options.host.remoteExtras?.()) ?? { permissionsMax: {}, busySend: 'steer' as const }
    const defaults = this.phoneDefaults((extras as { defaults?: RemoteSnapshot['defaults'] }).defaults)
    return toRemoteSnapshot(full, { permissionsMax: extras.permissionsMax, defaults, prefs: { busySend: extras.busySend, allowFull: this.options.access.allowFull } })
  }

  /** Un evento dell'host: va ai client remoti solo se è tra quelli ammessi (e, per le chat, solo a chi segue la sessione). */
  broadcast(event: HostEvent): void {
    if (this.connections.size === 0) return
    let out: RemoteEvent
    if (event.type === 'snapshot') {
      // Lo snapshot ha bisogno di dati asincroni (tetti di permesso): parte appena sono pronti.
      void this.buildSnapshot(event)
        .then((snapshot) => {
          for (const conn of this.connections) if (conn.auth) this.send(conn, { kind: 'event', event: snapshot })
        })
        .catch(() => undefined)
      return
    } else if (isForwardedEventType(event.type)) {
      // LAD-90: l'email dell'account e il percorso della CLI non escono dal Mac.
      if (event.type === 'agent.status') out = { ...event, status: toRemoteAgent(event.status) } as unknown as RemoteEvent
      // LAD-90: l'account senza la cartella di configurazione.
      else if (event.type === 'profile.upsert') out = { type: 'profile.upsert', profile: { id: event.profile.id, agent: event.profile.agent, name: event.profile.name, isDefault: event.profile.isDefault } satisfies RemoteProfile }
      else out = event as RemoteEvent
      // LAD-89: modelli (non i soli limiti d'uso), agenti, progetti e account cambiano i predefiniti mostrati al telefono.
      if (event.type === 'agent.status') {
        const sig = agentSignature(event.status)
        const id = `${event.status.agent}|${event.status.profileId ?? ''}`
        if (this.agentSigs.get(id) !== sig) {
          this.agentSigs.set(id, sig)
          this.pushDefaults()
        }
      } else if (event.type === 'project.upsert' || event.type === 'project.removed' || event.type === 'profile.upsert' || event.type === 'profile.removed') this.pushDefaults()
    } else return
    // replace: true (anche da session.open sul Mac) porta la chat intera: al telefono va solo l'ultima pagina, calcolata una volta.
    let lastPage: RemoteEvent | null | undefined
    for (const conn of this.connections) {
      if (!conn.auth) continue
      if ((out.type === 'session.items' || out.type === 'session.subagents') && !conn.watched.has(out.sessionId)) continue
      if (out.type === 'session.items' && out.replace) {
        if (lastPage === undefined) {
          try {
            lastPage = { type: 'session.items', sessionId: out.sessionId, items: this.options.host.pageItems(out.sessionId).items, replace: true }
          } catch {
            lastPage = null // sessione sparita: niente da mandare
          }
        }
        if (lastPage) this.send(conn, { kind: 'event', event: lastPage })
        continue
      }
      this.send(conn, { kind: 'event', event: out })
    }
  }

  /** Attività sulla connessione: l'orologio del silenzio riparte. */
  private touch(conn: RemoteConnection): void {
    if (conn.closed || !conn.auth) return
    if (conn.idleTimer) clearTimeout(conn.idleTimer)
    conn.idleTimer = setTimeout(() => this.drop(conn, 'idle timeout'), this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS)
    conn.idleTimer.unref()
  }

  /** Un gettone per comando; True se c'era. */
  private allow(conn: RemoteConnection): boolean {
    const now = Date.now()
    conn.tokens = Math.min(RATE_BURST, conn.tokens + ((now - conn.tokensAt) / 1000) * RATE_PER_SECOND)
    conn.tokensAt = now
    if (conn.tokens < 1) return false
    conn.tokens -= 1
    return true
  }

  /** Chiude tutte le connessioni (spegnimento del canale). */
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
        // database chiuso mentre si spegne
      }
    }
    try {
      conn.link.close()
    } catch {
      // già chiusa
    }
    // Iscrizioni a git e file che l'host associa alla connessione: spariscono con lei.
    try {
      this.options.host.connectionClosed(conn)
    } catch (error) {
      console.error('[remote] connectionClosed', error instanceof Error ? error.message : String(error))
    }
    if (device) this.options.onDevices?.()
    if (reason) this.options.log?.(`connection closed: ${reason}`)
  }

  /** Autenticazione fallita o revoca: il telefono riceve il codice (e il testo tradotto), poi la connessione si chiude. */
  private reject(conn: RemoteConnection, code: RemoteAuthErrorCode): void {
    this.send(conn, { kind: 'auth', ok: false, code, error: authErrorText(code) })
    this.drop(conn, `authentication: ${code}`)
  }

  /** Il primo messaggio: `pair` o `auth`. Qualunque altra cosa, o un secondo messaggio mentre si verifica, chiude la connessione. */
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
        // LAD-92: solo ora (autenticato) la connessione può ricevere messaggi con immagini.
        session.setMaxInbound(REMOTE_MAX_ATTACH_COMMAND)
        // LAD-53: la lingua dell'app decide il testo dei push; senza, resta quella salvata (o inglese).
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

  /** Scrive nel log delle azioni remote; un errore del database non ferma il comando. */
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
    // Prima i limiti, poi il lavoro vero (validare e decodificare le immagini costa): servono solo la forma e l'id della richiesta.
    const shape = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { rid?: unknown; command?: { type?: unknown; sessionId?: unknown } }) : null
    // Un rid presente ma storto è un client che non rispetta il protocollo: la connessione si chiude (come fa parseRemoteMessage).
    if (shape && shape.rid !== undefined && !(typeof shape.rid === 'string' && shape.rid.length > 0 && shape.rid.length <= 128)) return this.drop(conn, 'bad message')
    const early = shape && typeof shape.rid === 'string' ? shape.rid : undefined
    if (!this.allow(conn)) {
      if (++conn.rejected >= MAX_REJECTED_IN_A_ROW) this.drop(conn, 'rate limit')
      else if (early) this.send(conn, { kind: 'result', rid: early, ok: false, error: t('Too many requests. Slow down.') })
      return
    }
    // LAD-92: le immagini dichiarate contano subito sul limite del dispositivo (anche se poi non passano i controlli).
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
      // Allegati non validi ripetuti: un'app che si comporta bene non li manda; si chiude dopo pochi (5) tentativi di fila.
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

  /** Un gettone per nuova sessione, per dispositivo: raffica 3, poi 5 al minuto. */
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

  /** Gettoni per dispositivo: `cost` alla volta; true se c'erano. `refill` = gettoni al millisecondo. */
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

  /** Rimette `cost` gettoni nel secchiello del dispositivo (una richiesta contata ma poi rifiutata per altro). */
  private refundFrom(buckets: Map<string, { tokens: number; at: number }>, conn: RemoteConnection, burst: number, cost: number): void {
    const bucket = buckets.get(conn.auth?.id ?? '')
    if (bucket) bucket.tokens = Math.min(burst, bucket.tokens + cost)
  }

  /** Elenco dei file del progetto, in cache per FILES_CACHE_MS; letture contemporanee dello stesso progetto (cache fredda) ne fanno una sola. */
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
          // Più recente in fondo; oltre MAX_WATCHED la meno recente smette di essere seguita.
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
        // La finestra mostra "Notifiche attive" dal token.
        this.options.onDevices?.()
        return null
      case 'device.notify.set':
        if (conn.auth) this.options.access.setNotifyPrefs(conn.auth.id, command.prefs)
        return null
      case 'device.state':
        if (conn.auth) this.foreground.set(conn.auth.id, { foreground: command.foreground, at: this.now(), conn })
        return null
      case 'session.create': {
        // Limite proprio per dispositivo: ogni tentativo conta, anche se poi non passa i controlli; un rifiuto finisce nel log.
        if (!this.takeCreate(conn)) {
          // Rifiutata per il limite delle sessioni: le immagini già contate tornano al dispositivo.
          if (command.attachments?.length) this.refundFrom(this.imageBuckets, conn, IMAGE_BURST, command.attachments.length)
          this.record(conn, 'create', null, t('New session refused: too many requests'))
          throw new Error(t('Too many new sessions. Try again in a moment.'))
        }
        // Le immagini sono già state contate (e validate) da onMessage.
        const images = command.attachments?.length ?? 0
        const info = (await host.checkCreate?.(command)) ?? { agent: command.agent, project: command.projectId }
        const base = t('New session: {agent} in {project}', { agent: info.agent, project: info.project })
        const detail = images > 0 ? t('{detail} ({images})', { detail: base, images: plural(images, '{n} image', '{n} images', { n: images }) }) : base
        if (command.permission === 'full' && !this.options.access.allowFull) {
          this.record(conn, 'create', null, t('{detail} (blocked)', { detail }))
          throw new Error(t('Full access cannot be turned on from the phone. Allow it in Settings on your Mac.'))
        }
        // Chat, nessun worktree, nessun allegato: il comando si ricostruisce campo per campo (il testo non va nel log).
        const created = (await host.handle({ type: 'session.create', projectId: command.projectId, agent: command.agent, text: images > 0 && !command.text.trim() ? imagePlaceholder(images) : command.text, model: command.model, effort: command.effort, permission: command.permission, ...(command.profileId ? { profileId: command.profileId } : {}), mode: 'chat', ...(images > 0 ? { attachments: command.attachments } : {}) }, conn)) as SessionSummary | null
        this.record(conn, 'create', created?.id ?? null, detail)
        return created
      }
      case 'project.files.search': {
        if (!this.takeFrom(this.searchBuckets, conn, SEARCH_BURST, SEARCH_PER_SECOND / 1000, 1)) throw new Error(t('Too many requests. Slow down.'))
        return searchFiles(await this.projectFiles(command.projectId), command.query, command.limit)
      }
      case 'agents.usage': {
        // Agente e account verificati prima di tutto (niente chiavi inventate); il predefinito ha una sola chiave.
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
        // LAD-92: immagini già contate e validate da onMessage; nel log si scrive solo quante sono. Un messaggio di sole immagini
        // porta il testo segnaposto della finestra: l'agente non accetta un blocco di testo vuoto.
        const images = command.attachments?.length ?? 0
        const result = await host.handle(images > 0 && !command.text.trim() ? { ...command, text: imagePlaceholder(images) } : command, conn)
        this.record(conn, 'send', command.sessionId, images > 0 ? plural(images, 'Message with {n} image', 'Message with {n} images', { n: images }) : t('Message ({n} chars)', { n: command.text.length }))
        return result
      }
      case 'session.command': {
        // Il comando deve essere nell'elenco attuale della sessione (lo stesso di `session.commands`); gli argomenti non vanno nel log.
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
        // Il livello vero è quello dopo il tetto del progetto.
        this.record(conn, 'permission', command.sessionId, t('Permission → {level}', { level: levelName(result?.permission ?? command.permission) }))
        return result
      }
      default:
        return host.handle(command, conn)
    }
  }
}
