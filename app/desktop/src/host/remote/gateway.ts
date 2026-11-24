// Gateway remoto: porta il protocollo della finestra su una connessione cifrata (Noise NK), per il telefono.
// Non sa nulla del trasporto (WebSocket oggi, relay con LAD-50): riceve un RemoteLink già aperto.
// Import relativi (niente alias @shared): il file è provato in-process con `node --test`.
import type { FromRemoteHost, HostEvent, RemoteCommand, RemoteEvent, RemotePage, RemoteSnapshot } from '../../shared/protocol.ts'
import { t } from '../../shared/i18n.ts'
import { serverHandshake, type RemoteSession } from '../../shared/remote/session.ts'
import type { NoiseKeyPair } from '../../shared/remote/noise.ts'
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
  handle(command: Exclude<RemoteCommand, { type: 'session.page' | 'session.watch' }>, origin: object): Promise<unknown>
  pageItems(sessionId: string, before?: number, limit?: number): RemotePage
  connectionClosed(origin: object): void
}

export interface RemoteGatewayOptions {
  host: RemoteHostApi
  identity: NoiseKeyPair
  /** Nome del Mac e versione di Ladder, per l'hello. */
  macName: string
  appVersion: string
  log?: (message: string) => void
  /** Silenzio massimo dopo l'handshake; solo le prove lo cambiano. */
  idleTimeoutMs?: number
}

export const MAX_WATCHED = 8
const MAX_IN_FLIGHT = 64
/** Oltre questa coda di invio la connessione è troppo lenta e si chiude. */
const MAX_BUFFERED = 64 * 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 10_000
/** Connessioni remote contemporanee e silenzio massimo dopo l'handshake (messaggi o pong del trasporto). */
export const MAX_CONNECTIONS = 8
export const IDLE_TIMEOUT_MS = 120_000
/** Comandi al secondo (a regime) e raffica massima per connessione; oltre rispondono con un errore, e dopo troppi rifiuti di fila la connessione si chiude. */
export const RATE_PER_SECOND = 20
export const RATE_BURST = 40
const MAX_REJECTED_IN_A_ROW = 100

/** Istantanea ridotta: niente bozze, terminali, scorciatoie, collegamenti, profili; della UI solo gruppi e seenAt. */
export function toRemoteSnapshot(full: Extract<HostEvent, { type: 'snapshot' }>): RemoteSnapshot {
  const ui: RemoteSnapshot['ui'] = {}
  for (const [projectId, state] of Object.entries(full.ui)) {
    ui[projectId] = {
      ...(state.groups ? { groups: state.groups } : {}),
      ...(state.groupOf ? { groupOf: state.groupOf } : {}),
      ...(state.seenAt !== undefined ? { seenAt: state.seenAt } : {})
    }
  }
  return { type: 'snapshot', projects: full.projects, sessions: full.sessions, ui, ...(full.projectGroups ? { projectGroups: full.projectGroups } : {}), agents: full.agents }
}

/** Una connessione remota: è anche l'`origin` che l'Host associa alle iscrizioni. */
class RemoteConnection {
  readonly link: RemoteLink
  session: RemoteSession | null = null
  device = ''
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

export class RemoteGateway {
  private readonly options: RemoteGatewayOptions
  private readonly connections = new Set<RemoteConnection>()

  constructor(options: RemoteGatewayOptions) {
    this.options = options
  }

  get size(): number {
    return this.connections.size
  }

  /** Prende in carico una connessione nuova: handshake, poi comandi. */
  accept(link: RemoteLink): void {
    if (this.connections.size >= MAX_CONNECTIONS) {
      link.close()
      return
    }
    const conn = new RemoteConnection(link)
    this.connections.add(conn)
    const handshake = serverHandshake({ identity: this.options.identity, hello: { mac: this.options.macName, app: this.options.appVersion } })
    conn.handshakeTimer = setTimeout(() => this.drop(conn, 'handshake timeout'), HANDSHAKE_TIMEOUT_MS)
    link.onClose(() => this.drop(conn))
    link.onAlive?.(() => this.touch(conn))
    link.onBytes((bytes) => {
      if (conn.closed) return
      this.touch(conn)
      try {
        if (!conn.session) {
          const { reply, session, client } = handshake.accept(bytes)
          if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer)
          conn.handshakeTimer = null
          conn.session = session
          this.touch(conn)
          conn.device = client.device.slice(0, 80)
          link.send(reply)
          this.options.log?.(`connection opened (device: ${JSON.stringify(conn.device)})`)
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

  /** Un evento dell'host: va ai client remoti solo se è tra quelli ammessi (e, per le chat, solo a chi segue la sessione). */
  broadcast(event: HostEvent): void {
    if (this.connections.size === 0) return
    let out: RemoteEvent
    if (event.type === 'snapshot') out = toRemoteSnapshot(event)
    else if (isForwardedEventType(event.type)) out = event as RemoteEvent
    else return
    // replace: true (anche da session.open sul Mac) porta la chat intera: al telefono va solo l'ultima pagina, calcolata una volta.
    let lastPage: RemoteEvent | null | undefined
    for (const conn of this.connections) {
      if (!conn.session) continue
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
    if (conn.closed || !conn.session) return
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
    if (reason) this.options.log?.(`connection closed: ${reason}`)
  }

  private onMessage(conn: RemoteConnection, value: unknown): void {
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
      case 'hello': {
        return toRemoteSnapshot(await host.snapshot())
      }
      case 'session.send': {
        // Gli allegati non passano dal telefono.
        const { attachments: _attachments, ...rest } = command
        return host.handle(rest, conn)
      }
      case 'session.respond':
        return host.handle({ ...command, via: 'phone' }, conn)
      default:
        return host.handle(command, conn)
    }
  }
}
