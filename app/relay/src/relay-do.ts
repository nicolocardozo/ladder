// Un Durable Object per ogni Mac (id = hash della sua chiave pubblica). Inoltra byte tra il Mac e i suoi telefoni senza leggerli:
// il contenuto è cifrato da capo a capo (Noise) e qui non c'è nessuna chiave. Formato dei messaggi: shared/remote/relay-protocol.ts.
// Stato su disco: solo `mac` = { lastSeen, reason } (ultima volta visto e perché è sparito). Nessun messaggio viene conservato né registrato.
// Hibernation: i socket sopravvivono all'eviction dell'oggetto, quindi tutto lo stato per socket sta negli attachment (max 2 KiB);
// il ping/pong del keepalive è un auto-response e non sveglia l'oggetto.
import { DurableObject } from 'cloudflare:workers'
import type { RemoteMacStatus, RemoteOfflineReason } from '../../desktop/src/shared/protocol.ts'
import {
  decodeFrame,
  encodeFrame,
  RELAY_CLOSE,
  RELAY_FRAME_CLOSE,
  RELAY_FRAME_DATA,
  RELAY_FRAME_OPEN,
  RELAY_IDLE_MS,
  RELAY_MAX_MAC_MESSAGE,
  RELAY_MAX_PHONES,
  RELAY_MAX_PHONE_MESSAGE,
  RELAY_PING,
  RELAY_PONG,
  toBase64Url,
  verifyAuth,
  type MacToRelay,
  type RelayToMac,
  type RelayToPhone
} from '../../desktop/src/shared/remote/relay-protocol.ts'

/** Un Mac che non si è autenticato entro questo tempo viene chiuso; al massimo MAX_PENDING_MACS in attesa (oltre, il più vecchio fa posto al nuovo). */
const AUTH_TIMEOUT_MS = 10_000
const MAX_PENDING_MACS = 4
/**
 * Un telefono che aspetta il Mac offline da più di così viene chiuso anche se manda ping (il suo client si riconnette e riceve lo stato):
 * otto socket che fanno solo ping non possono tenere occupati tutti i posti. Con il Mac offline, un telefono nuovo fa inoltre posto
 * cacciando quello in attesa da più tempo.
 */
const OFFLINE_WAIT_MS = 5 * 60_000
/** L'allarme scatta solo alla prossima scadenza vera (auth, silenzio, attesa offline), mai a intervalli fissi; mai prima di così. */
const MIN_ALARM_GAP_MS = 1_000
/** Messaggi di testo di controllo del Mac (auth, state): piccoli. */
const MAX_CONTROL_TEXT = 1024
/** Limiti per connessione: messaggi al secondo e byte al secondo (a regime) con una raffica; il Mac porta il traffico di tutti i telefoni. */
const LIMITS = {
  phone: { msgsPerSec: 100, msgBurst: 200, bytesPerSec: 2 * 1024 * 1024, byteBurst: 8 * 1024 * 1024 },
  mac: { msgsPerSec: 400, msgBurst: 800, bytesPerSec: 8 * 1024 * 1024, byteBurst: 32 * 1024 * 1024 }
} as const

interface Attachment {
  role: 'mac' | 'phone'
  /** Id del Mac (dall'indirizzo). */
  id: string
  /** Telefono: numero della connessione verso il Mac. */
  connId: number
  /** Mac: ha superato la sfida. */
  authed: boolean
  nonce: string
  /** Origine del relay come la vede questo oggetto (entra nella firma del Mac). */
  origin: string
  /** Telefono: da quando aspetta il Mac offline (ms), 0 se il Mac c'è. */
  waitingSince: number
  /** Apertura e ultima attività vista dall'oggetto (il ping auto-risposto si legge a parte). */
  at: number
  last: number
  /** Già gestita l'uscita: evita doppie notifiche (close esplicito + evento di chiusura). */
  gone: boolean
}

interface StoredMac {
  lastSeen: number
  reason: RemoteOfflineReason
}

interface Bucket {
  msgs: number
  bytes: number
  at: number
}

// Nessuna variabile d'ambiente: il relay non ha segreti né configurazione.
type Env = Record<string, never>

export class RelayDurableObject extends DurableObject<Env> {
  /** Secchielli dei limiti: in memoria, si azzerano con l'hibernation (un limite, non una garanzia). */
  private readonly buckets = new Map<WebSocket, Bucket>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG))
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const id = url.pathname.split('/')[2] ?? ''
    const role = url.searchParams.get('role')
    if (role !== 'mac' && role !== 'phone') return new Response('Bad request', { status: 400 })
    const now = Date.now()
    const origin = url.origin
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    if (role === 'mac') {
      // Sfide in attesa al limite: si chiude la più vecchia, così chi conosce l'id non può tenere occupati i posti e bloccare il Mac vero.
      const pending = this.pendingMacs()
      if (pending.length >= MAX_PENDING_MACS) {
        const [oldest] = pending.sort((a, b) => a.att.at - b.att.at)
        await this.kick(oldest.ws, oldest.att, RELAY_CLOSE.authFailed, 'superseded')
      }
      const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
      this.ctx.acceptWebSocket(server, ['mac'])
      server.serializeAttachment({ role, id, connId: 0, authed: false, nonce, origin, waitingSince: 0, at: now, last: now, gone: false } satisfies Attachment)
      this.sendJson<RelayToMac>(server, { t: 'challenge', nonce })
    } else {
      const mac = this.authedMac()
      let active = this.activePhones()
      // Mac offline e posti finiti: fa posto il telefono in attesa da più tempo.
      if (active.length >= RELAY_MAX_PHONES && !mac) {
        const [oldest] = active.filter((p) => p.att.waitingSince > 0).sort((a, b) => a.att.waitingSince - b.att.waitingSince)
        if (oldest) {
          await this.kick(oldest.ws, oldest.att, RELAY_CLOSE.idle, 'evicted')
          active = this.activePhones()
        }
      }
      const full = active.length >= RELAY_MAX_PHONES
      const connId = this.freeConnId()
      this.ctx.acceptWebSocket(server, ['phone', `c${connId}`])
      server.serializeAttachment({ role, id, connId, authed: false, nonce: '', origin, waitingSince: mac || full ? 0 : now, at: now, last: now, gone: full } satisfies Attachment)
      if (full) {
        // Chiudere prima di restituire la risposta 101 non arriva al client: si chiude subito dopo. `gone` evita che conti come posto occupato.
        setTimeout(() => this.closeQuiet(server, RELAY_CLOSE.tooManyPhones, 'too many phones'), 50)
      } else if (mac) {
        this.sendJson<RelayToPhone>(server, { t: 'mac', online: true })
        this.sendBytes(mac, encodeFrame(RELAY_FRAME_OPEN, connId))
      } else {
        this.sendJson<RelayToPhone>(server, { t: 'mac', ...(await this.offlineStatus()) })
      }
    }
    await this.arm()
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = this.attachmentOf(ws)
    if (!att || att.gone) return
    const size = typeof message === 'string' ? message.length : message.byteLength
    if (size > (att.role === 'mac' ? (typeof message === 'string' ? MAX_CONTROL_TEXT : RELAY_MAX_MAC_MESSAGE) : RELAY_MAX_PHONE_MESSAGE)) return this.kick(ws, att, RELAY_CLOSE.tooBig, 'message too big')
    if (!this.take(ws, att.role, size)) {
      // Il Mac porta il traffico di tutti i telefoni: chiuderlo li farebbe cadere tutti. Si scartano i messaggi in eccesso.
      if (att.role === 'mac') return
      return this.kick(ws, att, RELAY_CLOSE.rateLimit, 'rate limit')
    }
    const now = Date.now()
    if (now - att.last > 5000) {
      att.last = now
      ws.serializeAttachment(att)
    }

    if (att.role === 'phone') {
      // Dal telefono contano solo i byte Noise; il testo non fa nulla (il ping è già stato risposto).
      if (typeof message === 'string') return
      const mac = this.authedMac()
      if (mac) this.sendBytes(mac, encodeFrame(RELAY_FRAME_DATA, att.connId, new Uint8Array(message)))
      return
    }

    if (typeof message === 'string') return void (await this.onMacControl(ws, att, message))
    if (!att.authed) return this.kick(ws, att, RELAY_CLOSE.authFailed, 'not authenticated')
    const frame = decodeFrame(new Uint8Array(message))
    if (!frame) return this.kick(ws, att, RELAY_CLOSE.badRequest, 'bad frame')
    const phone = this.ctx.getWebSockets(`c${frame.connId}`)[0]
    if (!phone) return
    if (frame.type === RELAY_FRAME_DATA) {
      if (!this.attachmentOf(phone)?.gone) this.sendBytes(phone, frame.payload)
    }
    else if (frame.type === RELAY_FRAME_CLOSE) {
      const phoneAtt = this.attachmentOf(phone)
      if (!phoneAtt || phoneAtt.gone) return
      this.markGone(phone, phoneAtt)
      this.closeQuiet(phone, RELAY_CLOSE.macClosed, 'closed by Mac')
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.onGone(ws)
    // Completa l'handshake di chiusura (il codice 1005/1006 non si può rimandare).
    this.closeQuiet(ws, code === 1005 || code === 1006 ? 1000 : code, 'closed')
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onGone(ws)
  }

  /** Scadenze: Mac non autenticati, socket silenziosi (nessun messaggio né ping), telefoni in attesa del Mac da troppo. Poi riarma per la prossima. */
  override async alarm(): Promise<void> {
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws)
      if (!att || att.gone) continue
      const expiry = this.expiryOf(ws, att)
      if (expiry.at > now) continue
      await this.kick(ws, att, expiry.code, expiry.reason)
    }
    await this.arm(true)
  }

  /** Quando e perché un socket scade. Il ping auto-risposto non sveglia l'oggetto: se ne legge l'ora qui. */
  private expiryOf(ws: WebSocket, att: Attachment): { at: number; code: number; reason: string } {
    if (att.role === 'mac' && !att.authed) return { at: att.at + AUTH_TIMEOUT_MS, code: RELAY_CLOSE.authFailed, reason: 'auth timeout' }
    const last = Math.max(att.last, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0)
    const idle = { at: last + RELAY_IDLE_MS, code: RELAY_CLOSE.idle, reason: 'idle' }
    if (att.role === 'phone' && att.waitingSince > 0 && att.waitingSince + OFFLINE_WAIT_MS < idle.at) return { at: att.waitingSince + OFFLINE_WAIT_MS, code: RELAY_CLOSE.idle, reason: 'waiting too long' }
    return idle
  }

  /** Programma l'allarme alla scadenza più vicina (solo se è prima di quello già programmato, salvo `force`); nessun socket = nessun allarme. */
  private async arm(force = false): Promise<void> {
    let next = Infinity
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws)
      if (att && !att.gone) next = Math.min(next, this.expiryOf(ws, att).at)
    }
    if (next === Infinity) return void (await this.ctx.storage.deleteAlarm())
    next = Math.max(next, Date.now() + MIN_ALARM_GAP_MS)
    const current = await this.ctx.storage.getAlarm()
    if (force || current === null || current > next) await this.ctx.storage.setAlarm(next)
  }

  // ── Mac ───────────────────────────────────────────────────────────────────

  private async onMacControl(ws: WebSocket, att: Attachment, text: string): Promise<void> {
    let message: MacToRelay
    try {
      message = JSON.parse(text) as MacToRelay
    } catch {
      return this.kick(ws, att, RELAY_CLOSE.badRequest, 'bad message')
    }
    if (message.t === 'auth') {
      if (att.authed || typeof message.key !== 'string' || typeof message.sig !== 'string' || !verifyAuth(att.origin, att.id, att.nonce, message)) {
        return this.kick(ws, att, RELAY_CLOSE.authFailed, 'authentication failed')
      }
      // Il Mac autenticato prende il posto di un eventuale altro: l'altro viene chiuso e la sua uscita non conta come "Mac sparito".
      for (const other of this.ctx.getWebSockets('mac')) {
        const otherAtt = this.attachmentOf(other)
        if (other === ws || !otherAtt?.authed) continue
        this.markGone(other, otherAtt)
        this.closeQuiet(other, RELAY_CLOSE.replaced, 'replaced')
      }
      att.authed = true
      ws.serializeAttachment(att)
      await this.ctx.storage.put<StoredMac>('mac', { lastSeen: Date.now(), reason: 'offline' })
      this.sendJson<RelayToMac>(ws, { t: 'ready', maxPhones: RELAY_MAX_PHONES })
      // Ogni telefono già qui riceve un nuovo collegamento: il Mac lo apre, il telefono rifà l'handshake.
      for (const phone of this.phones()) {
        const phoneAtt = this.attachmentOf(phone)
        if (!phoneAtt || phoneAtt.gone) continue
        this.sendBytes(ws, encodeFrame(RELAY_FRAME_OPEN, phoneAtt.connId))
        this.sendJson<RelayToPhone>(phone, { t: 'mac', online: true })
        if (phoneAtt.waitingSince) {
          phoneAtt.waitingSince = 0
          phone.serializeAttachment(phoneAtt)
        }
      }
      await this.arm(true)
      return
    }
    if (message.t === 'state' && att.authed) {
      if (message.state === 'asleep' || message.state === 'quit' || message.state === 'rekeyed') {
        // Il Mac sta per sparire: lo si dice subito ai telefoni, senza aspettare che la connessione muoia.
        await this.macGone(ws, att, message.state)
        this.closeQuiet(ws, 1000, message.state)
      }
      return
    }
    return this.kick(ws, att, RELAY_CLOSE.badRequest, 'bad message')
  }

  /** Il Mac autenticato se n'è andato (a meno che un altro abbia già preso il suo posto): si ricorda perché e si avvisano i telefoni. */
  private async macGone(ws: WebSocket, att: Attachment, reason: RemoteOfflineReason): Promise<void> {
    if (att.gone) return
    this.markGone(ws, att)
    if (this.authedMac(ws)) return
    const stored: StoredMac = { lastSeen: Date.now(), reason }
    await this.ctx.storage.put('mac', stored)
    const now = Date.now()
    for (const phone of this.phones()) {
      const phoneAtt = this.attachmentOf(phone)
      if (!phoneAtt || phoneAtt.gone) continue
      this.sendJson<RelayToPhone>(phone, { t: 'mac', online: false, since: stored.lastSeen, reason })
      // Da ora aspetta il Mac: la sua attesa ha un tetto (OFFLINE_WAIT_MS).
      phoneAtt.waitingSince = now
      phone.serializeAttachment(phoneAtt)
    }
    await this.arm()
  }

  // ── Uscite e chiusure ─────────────────────────────────────────────────────

  private async onGone(ws: WebSocket): Promise<void> {
    const att = this.attachmentOf(ws)
    if (!att) return
    this.buckets.delete(ws)
    if (att.role === 'mac') {
      if (att.authed) await this.macGone(ws, att, 'offline')
      else this.markGone(ws, att)
      return
    }
    if (att.gone) return
    this.markGone(ws, att)
    const mac = this.authedMac()
    if (mac) this.sendBytes(mac, encodeFrame(RELAY_FRAME_CLOSE, att.connId))
  }

  /** Segna l'uscita come gestita (anche su disco, perché sopravviva all'hibernation) e libera il suo secchiello. */
  private markGone(ws: WebSocket, att: Attachment): void {
    att.gone = true
    ws.serializeAttachment(att)
    this.buckets.delete(ws)
  }

  /** Chiude un socket per colpa sua e ne gestisce l'uscita subito (il close server-side non sempre genera l'evento). */
  private async kick(ws: WebSocket, att: Attachment, code: number, reason: string): Promise<void> {
    if (att.role === 'mac' && att.authed) await this.macGone(ws, att, 'offline')
    else await this.onGone(ws)
    this.buckets.delete(ws)
    this.closeQuiet(ws, code, reason)
  }

  // ── Utilità ───────────────────────────────────────────────────────────────

  private attachmentOf(ws: WebSocket): Attachment | null {
    try {
      return (ws.deserializeAttachment() as Attachment | null) ?? null
    } catch {
      return null
    }
  }

  /** Mac autenticato, escluso eventualmente `except`. */
  private authedMac(except?: WebSocket): WebSocket | null {
    for (const ws of this.ctx.getWebSockets('mac')) {
      if (ws === except) continue
      const att = this.attachmentOf(ws)
      if (att?.authed && !att.gone) return ws
    }
    return null
  }

  /** Mac con la sfida in sospeso (escluse le uscite già gestite). */
  private pendingMacs(): { ws: WebSocket; att: Attachment }[] {
    return this.ctx.getWebSockets('mac').flatMap((ws) => {
      const att = this.attachmentOf(ws)
      return att && !att.authed && !att.gone ? [{ ws, att }] : []
    })
  }

  private phones(): WebSocket[] {
    return this.ctx.getWebSockets('phone')
  }

  /** Telefoni che occupano un posto (quelli già usciti non contano). */
  private activePhones(): { ws: WebSocket; att: Attachment }[] {
    return this.phones().flatMap((ws) => {
      const att = this.attachmentOf(ws)
      return att && !att.gone ? [{ ws, att }] : []
    })
  }

  private freeConnId(): number {
    for (;;) {
      const id = crypto.getRandomValues(new Uint32Array(1))[0]
      if (id !== 0 && this.ctx.getWebSockets(`c${id}`).length === 0) return id
    }
  }

  private async offlineStatus(): Promise<Extract<RemoteMacStatus, { online: false }>> {
    const stored = await this.ctx.storage.get<StoredMac>('mac')
    return stored ? { online: false, since: stored.lastSeen, reason: stored.reason } : { online: false, since: null, reason: 'unknown' }
  }

  /** Un gettone per messaggio e uno per byte; false se uno dei due secchielli è vuoto. */
  private take(ws: WebSocket, role: 'mac' | 'phone', bytes: number): boolean {
    const limit = LIMITS[role]
    const now = Date.now()
    let bucket = this.buckets.get(ws)
    if (!bucket) {
      bucket = { msgs: limit.msgBurst, bytes: limit.byteBurst, at: now }
      this.buckets.set(ws, bucket)
    }
    const seconds = (now - bucket.at) / 1000
    bucket.at = now
    bucket.msgs = Math.min(limit.msgBurst, bucket.msgs + seconds * limit.msgsPerSec) - 1
    bucket.bytes = Math.min(limit.byteBurst, bucket.bytes + seconds * limit.bytesPerSec) - bytes
    return bucket.msgs >= 0 && bucket.bytes >= 0
  }

  private sendJson<T>(ws: WebSocket, message: T): void {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // socket già chiuso: la sua uscita arriva da sola
    }
  }

  private sendBytes(ws: WebSocket, bytes: Uint8Array): void {
    try {
      ws.send(bytes)
    } catch {
      // idem
    }
  }

  private closeQuiet(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason)
    } catch {
      // già chiuso
    }
  }
}
