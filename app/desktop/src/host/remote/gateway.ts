// Gateway remoto: porta il protocollo della finestra su una connessione cifrata (Noise NK), per il telefono.
// Non sa nulla del trasporto (WebSocket oggi, relay con LAD-50): riceve un RemoteLink già aperto.
// Import relativi (niente alias @shared): il file è provato in-process con `node --test`.
import type { FromRemoteHost, HostEvent, PermissionLevel, RemoteAuthErrorCode, RemoteCommand, RemoteEvent, RemoteLogAction, RemoteLogEntry, RemotePage, RemoteSnapshot, RequestResponse, SessionSummary } from '../../shared/protocol.ts'
import { t } from '../../shared/i18n.ts'
import { serverHandshake, type RemoteSession } from '../../shared/remote/session.ts'
import type { NoiseKeyPair } from '../../shared/remote/noise.ts'
import { authErrorText, type DeviceRow, type RemoteAccess } from './access.ts'
import { isForwardedEventType, parseRemoteMessage, RemoteCommandError } from './allowlist.ts'

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
  handle(command: Exclude<RemoteCommand, { type: 'session.page' | 'session.watch' | 'device.push.set' | 'project.sessions.archived' }>, origin: object): Promise<unknown>
  pageItems(sessionId: string, before?: number, limit?: number): RemotePage
  /** Tetto di permesso per progetto e preferenza di invio, per l'istantanea; manca = nessun tetto e 'steer'. */
  remoteExtras?(): Promise<{ permissionsMax: RemoteSnapshot['permissionsMax']; busySend: RemoteSnapshot['prefs']['busySend'] }>
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
  /** Silenzio massimo dopo l'handshake; solo le prove lo cambiano. */
  idleTimeoutMs?: number
  /** LAD-54: chiamata quando cambia il numero di telefoni collegati (autenticazione riuscita o connessione chiusa). */
  onClients?: (count: number) => void
  /** LAD-51: chiamata quando un dispositivo si collega o si scollega del tutto (per lo stato della finestra). */
  onDevices?: () => void
  /** LAD-51: nuova voce nel log delle azioni remote. */
  onLog?: (entry: RemoteLogEntry) => void
}

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
export const RATE_PER_SECOND = 20
export const RATE_BURST = 40
const MAX_REJECTED_IN_A_ROW = 100

/** Istantanea ridotta: niente bozze, terminali, scorciatoie, collegamenti, profili; della UI solo gruppi e seenAt. */
export function toRemoteSnapshot(full: Extract<HostEvent, { type: 'snapshot' }>, extras: Pick<RemoteSnapshot, 'permissionsMax' | 'prefs'>): RemoteSnapshot {
  const ui: RemoteSnapshot['ui'] = {}
  for (const [projectId, state] of Object.entries(full.ui)) {
    ui[projectId] = {
      ...(state.groups ? { groups: state.groups } : {}),
      ...(state.groupOf ? { groupOf: state.groupOf } : {}),
      ...(state.seenAt !== undefined ? { seenAt: state.seenAt } : {})
    }
  }
  return { type: 'snapshot', projects: full.projects, sessions: full.sessions, ui, ...(full.projectGroups ? { projectGroups: full.projectGroups } : {}), agents: full.agents, permissionsMax: extras.permissionsMax, prefs: extras.prefs }
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

  /** Il dispositivo è stato rinominato: le connessioni aperte usano il nome nuovo (log e `viaDevice`). */
  deviceRenamed(deviceId: string, name: string): void {
    for (const conn of this.connections) if (conn.auth?.id === deviceId) conn.auth = { ...conn.auth, name }
  }

  /** Manda ai telefoni collegati le preferenze del Mac di adesso (evento `remote.prefs`). */
  async pushPrefs(): Promise<void> {
    const extras = await this.options.host.remoteExtras?.()
    const event: RemoteEvent = { type: 'remote.prefs', prefs: { busySend: extras?.busySend ?? 'steer', allowFull: this.options.access.allowFull } }
    for (const conn of this.connections) if (conn.auth) this.send(conn, { kind: 'event', event })
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
          link.send(reply)
          this.options.log?.(`connection opened, waiting for authentication (device: ${JSON.stringify(conn.device)})`)
          return
        }
        const message = conn.session.open<unknown>(bytes)
        if (message !== null) this.onMessage(conn, message)
      } catch (error) {
        // Decifratura fallita, versione diversa, messaggio troppo grande, JSON rotto: la connessione non si recupera.
        this.drop(conn, error instanceof Error ? error.message : String(error))
      }
    })
  }

  /** Istantanea per il telefono: quella ridotta più tetti di permesso e preferenze del Mac. */
  private async buildSnapshot(full: Extract<HostEvent, { type: 'snapshot' }>): Promise<RemoteSnapshot> {
    const extras = (await this.options.host.remoteExtras?.()) ?? { permissionsMax: {}, busySend: 'steer' as const }
    return toRemoteSnapshot(full, { permissionsMax: extras.permissionsMax, prefs: { busySend: extras.busySend, allowFull: this.options.access.allowFull } })
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
    } else if (isForwardedEventType(event.type)) out = event as RemoteEvent
    else return
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
    let rid: string | undefined
    let command: RemoteCommand
    try {
      const parsed = parseRemoteMessage(value, { invalid: t('Invalid request.'), notAllowed: t('This request is not available from the phone.') })
      rid = parsed.rid
      command = parsed.command
    } catch (error) {
      if (error instanceof RemoteCommandError && error.rid) this.send(conn, { kind: 'result', rid: error.rid, ok: false, error: error.message })
      else if (!(error instanceof RemoteCommandError)) this.drop(conn, 'bad message')
      return
    }
    if (!this.allow(conn)) {
      if (++conn.rejected >= MAX_REJECTED_IN_A_ROW) this.drop(conn, 'rate limit')
      else if (rid) this.send(conn, { kind: 'result', rid, ok: false, error: t('Too many requests. Slow down.') })
      return
    }
    conn.rejected = 0
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
        return null
      case 'session.send': {
        // Gli allegati non passano dal telefono.
        const { attachments: _attachments, ...rest } = command
        const result = await host.handle(rest, conn)
        this.record(conn, 'send', command.sessionId, t('Message ({n} chars)', { n: command.text.length }))
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
