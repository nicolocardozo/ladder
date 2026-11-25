// Push notifications to phones, sent straight to Expo's service (→ APNs / FCM): no server of ours.
// Content is generic (title "Ladder" + one sentence per event type): project names and texts never go through Expo,
// Apple or Google; on tap, the phone reads the details from the encrypted channel. Tokens are never written in full to the log.
// No Expo access token: it is only needed with "enhanced security" on in the Expo project, which is not planned here.
// Relative imports: the file is tested with `node --test` (with a fake fetch: tests never call Expo).
import { REMOTE_PUSH_CHANNEL, REMOTE_PUSH_TITLE, type PushEvent, type RemotePushData } from '../../shared/protocol.ts'
import type { DeviceRow, RemoteAccess } from './access.ts'
import { pushBody, wantsPush } from './push-policy.ts'

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'
/** Expo limits: 100 messages per send request, 1000 ids per receipts request. */
export const MAX_BATCH = 100
const MAX_RECEIPT_BATCH = 1000
const TIMEOUT_MS = 15_000
/** Receipts are read after ~15 minutes (Expo keeps them 24 hours); at most this many pending. */
export const RECEIPT_DELAY_MS = 15 * 60_000
const MAX_PENDING_RECEIPTS = 500
/** After MessageRateExceeded (or a 429) nothing is sent for this long: lost pushes are not retried (no storms). */
export const BACKOFF_MS = 60_000
/** An extra push for the same event (for example an error reported from two places) within this window is dropped. */
const DEDUPE_MS = 5_000
/** Push expiry if the phone is unreachable: a request older than an hour is no longer useful. */
const TTL_SECONDS = 3600

export type FetchLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface ExpoMessage {
  to: string
  title: string
  body: string
  data: RemotePushData
  sound: 'default'
  priority: 'high'
  channelId: string
  ttl: number
}

interface Ticket {
  status?: string
  id?: string
  message?: string
  details?: { error?: string }
}

/** `ExponentPushToken[abcd…]`: only the start of a token is shown. */
export function maskToken(token: string): string {
  const inner = /^(Expo(?:nent)?PushToken)\[(.*)\]$/.exec(token)
  return inner ? `${inner[1]}[${inner[2].slice(0, 4)}…]` : `${token.slice(0, 4)}…`
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface PushServiceOptions {
  access: Pick<RemoteAccess, 'pushTargets' | 'clearPushToken' | 'enabled'>
  /** Mac id for `RemotePushData.mac`. */
  macId: () => string
  /** Devices with the app in the foreground right now (RemoteGateway.foregroundDevices). */
  foreground: () => ReadonlySet<string>
  fetch?: FetchLike
  now?: () => number
  log?: (message: string) => void
}

export class PushService {
  private readonly options: PushServiceOptions
  private readonly doFetch: FetchLike
  private pausedUntil = 0
  private pending: { id: string; token: string; at: number }[] = []
  private receiptTimer: ReturnType<typeof setTimeout> | null = null
  private recent = new Map<string, number>()
  private warnedCredentials = false

  constructor(options: PushServiceOptions) {
    this.options = options
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init))
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private log(message: string): void {
    this.options.log?.(`push: ${message}`)
  }

  /** Devices to send this event to now: with a token, event wanted, outside quiet hours, app not in the foreground. */
  targets(event: PushEvent): DeviceRow[] {
    if (!this.options.access.enabled) return []
    const at = this.now()
    const foreground = this.options.foreground()
    return this.options.access.pushTargets().filter((d) => d.pushToken !== null && !foreground.has(d.id) && wantsPush(d.notify, event.kind, at))
  }

  /** An event decided by main: sends it to the right devices. Never throws. */
  async notify(event: PushEvent): Promise<void> {
    try {
      const at = this.now()
      const key = `${event.kind}|${event.sessionId}|${event.itemId ?? ''}`
      for (const [k, when] of this.recent) if (at - when > DEDUPE_MS) this.recent.delete(k)
      if (this.recent.has(key)) return
      const targets = this.targets(event)
      if (targets.length === 0) return
      this.recent.set(key, at)
      const mac = this.options.macId()
      const messages = targets.map((d) => message(d, event, mac))
      await this.send(messages)
    } catch (error) {
      this.log(`notify failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Sends to Expo in groups of 100 and handles the outcome of each message. Never throws. */
  async send(messages: ExpoMessage[]): Promise<void> {
    for (let i = 0; i < messages.length; i += MAX_BATCH) {
      // Paused (even if triggered by a previous group): the rest is dropped.
      if (this.now() < this.pausedUntil) {
        this.log(`paused (rate limit), dropping ${messages.length - i} message(s)`)
        return
      }
      const batch = messages.slice(i, i + MAX_BATCH)
      try {
        const response = await this.doFetch(EXPO_PUSH_URL, { method: 'POST', headers: HEADERS, body: JSON.stringify(batch), signal: AbortSignal.timeout(TIMEOUT_MS) })
        if (response.status === 429) {
          this.pausedUntil = this.now() + BACKOFF_MS
          this.log('rate limited by Expo (429), pausing')
          return
        }
        const body = await response.json().catch(() => null)
        if (!response.ok) {
          this.log(`Expo answered ${response.status}${firstError(body)}`)
          continue
        }
        const tickets = isObject(body) && Array.isArray(body.data) ? (body.data as Ticket[]) : null
        if (!tickets) {
          this.log('unexpected answer from Expo')
          continue
        }
        this.handleTickets(batch, tickets)
      } catch (error) {
        // Network absent or timed out: the push is lost, the next event retries.
        this.log(`send failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private handleTickets(batch: ExpoMessage[], tickets: Ticket[]): void {
    batch.forEach((msg, index) => {
      const ticket = tickets[index]
      if (!ticket) return
      if (ticket.status === 'ok') {
        if (ticket.id) this.remember(ticket.id, msg.to)
        return
      }
      const code = ticket.details?.error
      if (code === 'DeviceNotRegistered') {
        this.options.access.clearPushToken(msg.to)
        this.log(`token ${maskToken(msg.to)} is no longer registered, cleared`)
      } else if (code === 'MessageRateExceeded') {
        this.pausedUntil = this.now() + BACKOFF_MS
        this.log('MessageRateExceeded, pausing')
      } else if (code === 'InvalidCredentials') {
        // APNs/FCM credentials of the Expo project: independent of the token, so tokens stay. Logged once only.
        if (!this.warnedCredentials) this.log('InvalidCredentials: the Expo project push credentials are not valid (tokens kept)')
        this.warnedCredentials = true
      } else if (code === 'MessageTooBig') {
        this.log(`MessageTooBig for ${maskToken(msg.to)}`)
      } else {
        this.log(`ticket error ${code ?? 'unknown'} for ${maskToken(msg.to)}`)
      }
    })
  }

  private remember(id: string, token: string): void {
    this.pending.push({ id, token, at: this.now() })
    if (this.pending.length > MAX_PENDING_RECEIPTS) this.pending.splice(0, this.pending.length - MAX_PENDING_RECEIPTS)
    if (!this.receiptTimer) {
      this.receiptTimer = setTimeout(() => {
        this.receiptTimer = null
        void this.pollReceipts()
      }, RECEIPT_DELAY_MS + 1000)
      this.receiptTimer.unref()
    }
  }

  /** Reads the receipts of messages at least 15 minutes old: a DeviceNotRegistered removes the token. Never throws. */
  async pollReceipts(): Promise<void> {
    const at = this.now()
    const due = this.pending.filter((p) => at - p.at >= RECEIPT_DELAY_MS)
    this.pending = this.pending.filter((p) => at - p.at < RECEIPT_DELAY_MS)
    for (let i = 0; i < due.length; i += MAX_RECEIPT_BATCH) {
      const batch = due.slice(i, i + MAX_RECEIPT_BATCH)
      try {
        const response = await this.doFetch(EXPO_RECEIPTS_URL, { method: 'POST', headers: HEADERS, body: JSON.stringify({ ids: batch.map((p) => p.id) }), signal: AbortSignal.timeout(TIMEOUT_MS) })
        const body = await response.json().catch(() => null)
        const receipts = response.ok && isObject(body) && isObject(body.data) ? body.data : null
        if (!receipts) continue
        for (const p of batch) {
          const receipt = receipts[p.id]
          if (isObject(receipt) && receipt.status === 'error' && isObject(receipt.details) && receipt.details.error === 'DeviceNotRegistered') {
            this.options.access.clearPushToken(p.token)
            this.log(`receipt: token ${maskToken(p.token)} is no longer registered, cleared`)
          }
        }
      } catch (error) {
        this.log(`receipts failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (this.pending.length > 0 && !this.receiptTimer) {
      this.receiptTimer = setTimeout(() => {
        this.receiptTimer = null
        void this.pollReceipts()
      }, 60_000)
      this.receiptTimer.unref()
    }
  }

  stop(): void {
    if (this.receiptTimer) clearTimeout(this.receiptTimer)
    this.receiptTimer = null
    this.pending = []
  }
}

const HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' }

function firstError(body: unknown): string {
  if (!isObject(body) || !Array.isArray(body.errors) || !isObject(body.errors[0])) return ''
  const e = body.errors[0]
  return `: ${typeof e.code === 'string' ? e.code : 'error'}`
}

/**
 * The message for a device. iOS: default sound. Android: `sessions` channel (created by the app) and high priority.
 * Expo exposes neither threadId nor collapseId: no per-session grouping (the app can do it from `data`, if needed).
 */
export function message(device: Pick<DeviceRow, 'pushToken' | 'locale'>, event: PushEvent, mac: string): ExpoMessage {
  return {
    to: device.pushToken as string,
    title: REMOTE_PUSH_TITLE,
    body: pushBody(event.kind, device.locale),
    data: { v: 1, kind: event.kind, sessionId: event.sessionId, itemId: event.itemId, mac },
    sound: 'default',
    priority: 'high',
    channelId: REMOTE_PUSH_CHANNEL,
    ttl: TTL_SECONDS
  }
}
