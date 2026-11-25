// One Durable Object per Mac (id = hash of its public key). Forwards bytes between the Mac and its phones without reading them:
// the content is end-to-end encrypted (Noise) and there is no key here. Message format: shared/remote/relay-protocol.ts.
// State on disk: only `mac` = { lastSeen, reason } (last time seen and why it disappeared). No message is stored or logged.
// Hibernation: sockets survive the object's eviction, so all per-socket state lives in attachments (max 2 KiB);
// the keepalive ping/pong is an auto-response and does not wake the object.
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

/** A Mac that has not authenticated within this time is closed; at most MAX_PENDING_MACS waiting (beyond that, the oldest makes room for the new one). */
const AUTH_TIMEOUT_MS = 10_000
const MAX_PENDING_MACS = 4
/**
 * A phone that has been waiting for the offline Mac longer than this is closed even if it sends pings (its client reconnects and gets the state):
 * eight sockets that only ping cannot keep all the seats busy. While the Mac is offline, a new phone also makes room
 * by evicting the one that has been waiting longest.
 */
const OFFLINE_WAIT_MS = 5 * 60_000
/** The alarm fires only at the next real deadline (auth, silence, offline wait), never at fixed intervals; never sooner than this. */
const MIN_ALARM_GAP_MS = 1_000
/** Mac control text messages (auth, state): small. */
const MAX_CONTROL_TEXT = 1024
/** Per-connection limits: messages per second and bytes per second (steady state) with a burst; the Mac carries all phones' traffic. */
const LIMITS = {
  phone: { msgsPerSec: 100, msgBurst: 200, bytesPerSec: 2 * 1024 * 1024, byteBurst: 8 * 1024 * 1024 },
  mac: { msgsPerSec: 400, msgBurst: 800, bytesPerSec: 8 * 1024 * 1024, byteBurst: 32 * 1024 * 1024 }
} as const

interface Attachment {
  role: 'mac' | 'phone'
  /** Mac id (from the address). */
  id: string
  /** Phone: connection number toward the Mac. */
  connId: number
  /** Mac: passed the challenge. */
  authed: boolean
  nonce: string
  /** Origin of the relay as this object sees it (part of the Mac's signature). */
  origin: string
  /** Phone: since when it has been waiting for the offline Mac (ms), 0 if the Mac is there. */
  waitingSince: number
  /** Open time and last activity seen by the object (the auto-answered ping is read separately). */
  at: number
  last: number
  /** Exit already handled: avoids double notifications (explicit close + close event). */
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

// No environment variables: the relay has no secrets or configuration.
type Env = Record<string, never>

export class RelayDurableObject extends DurableObject<Env> {
  /** Limit buckets: in memory, reset on hibernation (a limit, not a guarantee). */
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
      // Pending challenges at the limit: the oldest is closed, so someone who knows the id cannot keep the seats busy and lock out the real Mac.
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
      // Mac offline and seats full: the phone that has been waiting longest makes room.
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
        // Closing before returning the 101 response does not reach the client: close right after. `gone` keeps it from counting as an occupied seat.
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
      // The Mac carries all phones' traffic: closing it would drop them all. Excess messages are discarded.
      if (att.role === 'mac') return
      return this.kick(ws, att, RELAY_CLOSE.rateLimit, 'rate limit')
    }
    const now = Date.now()
    if (now - att.last > 5000) {
      att.last = now
      ws.serializeAttachment(att)
    }

    if (att.role === 'phone') {
      // From the phone only Noise bytes count; text does nothing (the ping has already been answered).
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
    // Completes the closing handshake (code 1005/1006 cannot be sent back).
    this.closeQuiet(ws, code === 1005 || code === 1006 ? 1000 : code, 'closed')
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onGone(ws)
  }

  /** Deadlines: unauthenticated Macs, silent sockets (no message or ping), phones waiting too long for the Mac. Then re-arms for the next one. */
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

  /** When and why a socket expires. The auto-answered ping does not wake the object: its time is read here. */
  private expiryOf(ws: WebSocket, att: Attachment): { at: number; code: number; reason: string } {
    if (att.role === 'mac' && !att.authed) return { at: att.at + AUTH_TIMEOUT_MS, code: RELAY_CLOSE.authFailed, reason: 'auth timeout' }
    const last = Math.max(att.last, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0)
    const idle = { at: last + RELAY_IDLE_MS, code: RELAY_CLOSE.idle, reason: 'idle' }
    if (att.role === 'phone' && att.waitingSince > 0 && att.waitingSince + OFFLINE_WAIT_MS < idle.at) return { at: att.waitingSince + OFFLINE_WAIT_MS, code: RELAY_CLOSE.idle, reason: 'waiting too long' }
    return idle
  }

  /** Schedules the alarm at the nearest deadline (only if earlier than the one already scheduled, unless `force`); no sockets = no alarm. */
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
      // The authenticated Mac takes the place of any other: the other is closed and its exit does not count as "Mac gone".
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
      // Every phone already here gets a new link: the Mac opens it, the phone redoes the handshake.
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
        // The Mac is about to go away: phones are told right away, without waiting for the connection to die.
        await this.macGone(ws, att, message.state)
        this.closeQuiet(ws, 1000, message.state)
      }
      return
    }
    return this.kick(ws, att, RELAY_CLOSE.badRequest, 'bad message')
  }

  /** The authenticated Mac has left (unless another has already taken its place): the reason is remembered and phones are notified. */
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
      // From now on it is waiting for the Mac: the wait has a cap (OFFLINE_WAIT_MS).
      phoneAtt.waitingSince = now
      phone.serializeAttachment(phoneAtt)
    }
    await this.arm()
  }

  // ── Exits and closes ──────────────────────────────────────────────────────

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

  /** Marks the exit as handled (also on disk, so it survives hibernation) and frees its bucket. */
  private markGone(ws: WebSocket, att: Attachment): void {
    att.gone = true
    ws.serializeAttachment(att)
    this.buckets.delete(ws)
  }

  /** Closes a socket because of its own fault and handles its exit right away (a server-side close does not always raise the event). */
  private async kick(ws: WebSocket, att: Attachment, code: number, reason: string): Promise<void> {
    if (att.role === 'mac' && att.authed) await this.macGone(ws, att, 'offline')
    else await this.onGone(ws)
    this.buckets.delete(ws)
    this.closeQuiet(ws, code, reason)
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  private attachmentOf(ws: WebSocket): Attachment | null {
    try {
      return (ws.deserializeAttachment() as Attachment | null) ?? null
    } catch {
      return null
    }
  }

  /** Authenticated Mac, optionally excluding `except`. */
  private authedMac(except?: WebSocket): WebSocket | null {
    for (const ws of this.ctx.getWebSockets('mac')) {
      if (ws === except) continue
      const att = this.attachmentOf(ws)
      if (att?.authed && !att.gone) return ws
    }
    return null
  }

  /** Mac with a pending challenge (excluding exits already handled). */
  private pendingMacs(): { ws: WebSocket; att: Attachment }[] {
    return this.ctx.getWebSockets('mac').flatMap((ws) => {
      const att = this.attachmentOf(ws)
      return att && !att.authed && !att.gone ? [{ ws, att }] : []
    })
  }

  private phones(): WebSocket[] {
    return this.ctx.getWebSockets('phone')
  }

  /** Phones occupying a seat (those already gone don't count). */
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

  /** One token per message and one per byte; false if either bucket is empty. */
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
      // socket already closed: its exit arrives on its own
    }
  }

  private sendBytes(ws: WebSocket, bytes: Uint8Array): void {
    try {
      ws.send(bytes)
    } catch {
      // same
    }
  }

  private closeQuiet(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason)
    } catch {
      // already closed
    }
  }
}
