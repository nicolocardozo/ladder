// Phone access: paired devices, pairing code, password, log of remote actions.
// The code lives only in memory and is never logged; devices and the log live in the database (tables devices and remote_log).
// Relative imports: the file is tested with `node --test`.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import {
  REMOTE_MAX_PAIR_ATTEMPTS,
  REMOTE_PAIRING_TTL_MS,
  REMOTE_PAIRING_VERSION,
  REMOTE_PASSWORD_MAX,
  REMOTE_PASSWORD_MIN,
  type RemoteAuthErrorCode,
  type RemoteDeviceInfo,
  type RemoteLogAction,
  type RemoteLogEntry,
  type RemoteLogPage,
  type RemoteNotifyPrefs,
  type RemotePairingPayload,
  type RemotePairStart,
  type RemotePlatform
} from '../../shared/protocol.ts'
import { isLocale, t, type Locale } from '../../shared/i18n.ts'
import { encodePairingUrl, fromBase64Url, keyFingerprint, toBase64Url, verifyChannelBinding } from '../../shared/remote/pairing.ts'
import type { Db } from '../db.ts'
import { parseNotifyPrefs } from './push-policy.ts'

const PASSWORD_KEY = 'remote.password'
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }
/** Log: at most this many entries, and none older than this many days. */
export const LOG_MAX_ENTRIES = 1000
export const LOG_MAX_DAYS = 30
const PRUNE_EVERY = 50
/** Consecutive authentication errors from any origin within this window: beyond it, requests are refused without looking at them. */
export const FAILURE_WINDOW_MS = 60_000
export const FAILURE_LIMIT = 30
const MAX_NAME = 80

export interface DeviceRow {
  id: string
  name: string
  platform: RemotePlatform
  publicKey: string
  pushToken: string | null
  /** Push preferences (defaults if the phone has not sent any) and the app language. */
  notify: RemoteNotifyPrefs
  locale: Locale
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

export type AuthOutcome = { ok: true; device: DeviceRow; paired: boolean } | { ok: false; code: RemoteAuthErrorCode }

/** Where the Mac can be reached: decided by the channel, which knows what is on. */
export interface PairingRoute {
  macName: string
  /** X25519 public key of the Mac. */
  key: Uint8Array
  relay?: string
  id?: string
  ws?: string
}

export interface RemoteAccessOptions {
  /** Something the state shows has changed (expired QR, new device). */
  onChange?: () => void
  /** A phone has just paired. */
  onPaired?: (device: DeviceRow) => void
  now?: () => number
}

interface PairingState {
  token: string
  hash: Buffer
  expiresAt: number
  attempts: number
}

const sha = (text: string): Buffer => createHash('sha256').update(text).digest()
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Device name without control characters, at most 80 characters; null if it ends up empty. */
export function cleanDeviceName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME)
  return name || null
}

/** Text (already translated) for each authentication error code. */
export function authErrorText(code: RemoteAuthErrorCode): string {
  switch (code) {
    case 'bad-token':
      return t('This pairing code is not valid. Scan a new code on your Mac.')
    case 'token-expired':
      return t('This pairing code has expired. Scan a new code on your Mac.')
    case 'token-used':
      return t('This pairing code was already used. Scan a new code on your Mac.')
    case 'password-required':
      return t('Enter the password set on your Mac.')
    case 'wrong-password':
      return t('Wrong password.')
    case 'too-many-attempts':
      return t('Too many attempts. Scan a new code on your Mac.')
    case 'device-revoked':
      return t('This phone was removed on your Mac. Pair it again to reconnect.')
    case 'unknown-device':
      return t('Your Mac does not know this phone. Pair it again.')
    case 'bad-signature':
      return t('Could not verify this phone. Pair it again.')
    case 'remote-disabled':
      return t('Access from your phone is turned off on your Mac.')
    case 'invalid-request':
      return t('Invalid request.')
  }
}

export class RemoteAccess {
  private readonly db: Db
  private readonly options: RemoteAccessOptions
  private active: PairingState | null = null
  /** Last finished code (expired or used), to tell the phone why it is no longer valid. */
  private spent: { hash: Buffer; reason: 'token-expired' | 'token-used' } | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private failures: number[] = []
  private inserts = 0
  /** Off: no authentication and no QR. Set by the channel. */
  enabled = false
  /** "Allow Full access from phone". */
  allowFull = true

  constructor(db: Db, options: RemoteAccessOptions = {}) {
    this.db = db
    this.options = options
    this.prune()
    // The log is also pruned by age: a Mac that stays on for weeks without actions does not keep old entries.
    setInterval(() => this.prune(), 86_400_000).unref()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  // ── Pairing code ─────────────────────────────────────────────────────────

  /** Creates the code (replaces the active one). Throws if the channel is off. */
  startPairing(route: PairingRoute): RemotePairStart {
    if (!this.enabled) throw new Error(t('Access from your phone is turned off.'))
    this.retire(null)
    const token = toBase64Url(randomBytes(32))
    const expiresAt = this.now() + REMOTE_PAIRING_TTL_MS
    this.active = { token, hash: sha(token), expiresAt, attempts: 0 }
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null
      if (this.active && this.now() >= this.active.expiresAt) {
        this.retire('token-expired')
        this.options.onChange?.()
      }
    }, REMOTE_PAIRING_TTL_MS + 50)
    this.expiryTimer.unref()
    const payload: RemotePairingPayload = {
      v: REMOTE_PAIRING_VERSION,
      mac: route.macName,
      key: toBase64Url(route.key),
      ...(route.relay && route.id ? { relay: route.relay, id: route.id } : {}),
      ...(route.ws ? { ws: route.ws } : {}),
      token,
      exp: expiresAt,
      pw: this.hasPassword()
    }
    return { url: encodePairingUrl(payload), payload, fingerprint: keyFingerprint(route.key), expiresAt }
  }

  cancelPairing(): void {
    if (!this.active) return
    this.retire(null)
    this.options.onChange?.()
  }

  /** The active code, if it is still valid (an expired one does not count). */
  pairing(): { expiresAt: number } | null {
    if (this.active && this.now() >= this.active.expiresAt) this.retire('token-expired')
    return this.active ? { expiresAt: this.active.expiresAt } : null
  }

  /** Removes the active code; `reason` is remembered as the last finished code. */
  private retire(reason: 'token-expired' | 'token-used' | null): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    if (this.active && reason) this.spent = { hash: this.active.hash, reason }
    this.active = null
  }

  // ── Authentication ───────────────────────────────────────────────────────

  /**
   * The first message of a connection. `handshakeHash`: that of the Noise session, which the signature is bound to.
   * Does not throw: every failure is a code.
   */
  async authenticate(message: unknown, handshakeHash: Uint8Array): Promise<AuthOutcome> {
    if (!this.enabled) return { ok: false, code: 'remote-disabled' }
    try {
      // `auth`: only the signature decides and there is no global limit (it is cheap): someone with the Mac's key, or a revoked phone retrying
      // continuously, cannot lock the other phones out.
      if (isObject(message) && message.type === 'auth') return this.auth(message, handshakeHash)
      if (!isObject(message) || message.type !== 'pair') return { ok: false, code: 'invalid-request' }
      // `pair`: global error limit (also protects the password's scrypt), in addition to the per-code limit.
      const now = this.now()
      this.failures = this.failures.filter((at) => now - at < FAILURE_WINDOW_MS)
      if (this.failures.length >= FAILURE_LIMIT) return { ok: false, code: 'too-many-attempts' }
      const outcome = await this.pair(message, handshakeHash)
      if (!outcome.ok) this.failures.push(now)
      return outcome
    } catch {
      return { ok: false, code: 'invalid-request' }
    }
  }

  private auth(message: Record<string, unknown>, handshakeHash: Uint8Array): AuthOutcome {
    if (typeof message.deviceId !== 'string' || message.deviceId.length > 64 || typeof message.sig !== 'string' || message.sig.length > 200) return { ok: false, code: 'invalid-request' }
    const device = this.device(message.deviceId)
    if (!device) return { ok: false, code: 'unknown-device' }
    // Signature first, then revocation: whoever lacks the device key cannot find out whether the id was revoked.
    if (!verifyChannelBinding(fromBase64Url(device.publicKey), 'auth', handshakeHash, message.sig)) return { ok: false, code: 'bad-signature' }
    if (device.revokedAt !== null) return { ok: false, code: 'device-revoked' }
    this.touch(device.id)
    return { ok: true, device, paired: false }
  }

  private async pair(message: Record<string, unknown>, handshakeHash: Uint8Array): Promise<AuthOutcome> {
    const { token, device: info, password, sig } = message
    if (typeof token !== 'string' || token.length > 200 || typeof sig !== 'string' || sig.length > 200 || !isObject(info)) return { ok: false, code: 'invalid-request' }
    const name = cleanDeviceName(info.name)
    const platform = info.platform
    if (!name || (platform !== 'ios' && platform !== 'android') || typeof info.publicKey !== 'string' || info.publicKey.length > 64) return { ok: false, code: 'invalid-request' }
    if (password !== undefined && (typeof password !== 'string' || password.length > REMOTE_PASSWORD_MAX)) return { ok: false, code: 'invalid-request' }
    let publicKey: Uint8Array
    try {
      publicKey = fromBase64Url(info.publicKey)
    } catch {
      return { ok: false, code: 'invalid-request' }
    }
    if (publicKey.length !== 32) return { ok: false, code: 'invalid-request' }

    // Code: constant-time comparison on the hashes (same length).
    if (this.active && this.now() >= this.active.expiresAt) this.retire('token-expired')
    const state = this.active
    const hash = sha(token)
    if (!state || !timingSafeEqual(hash, state.hash)) {
      if (this.spent && timingSafeEqual(hash, this.spent.hash)) return { ok: false, code: this.spent.reason }
      return { ok: false, code: 'bad-token' }
    }
    // Every attempt on a real code counts; at the limit the code is burned.
    state.attempts++
    const fail = (code: RemoteAuthErrorCode): AuthOutcome => {
      if (state.attempts >= REMOTE_MAX_PAIR_ATTEMPTS && this.active === state) {
        this.retire('token-used')
        this.options.onChange?.()
        return { ok: false, code: 'too-many-attempts' }
      }
      return { ok: false, code }
    }
    if (!verifyChannelBinding(publicKey, 'pair', handshakeHash, sig)) return fail('bad-signature')
    if (this.hasPassword()) {
      if (password === undefined || password === '') return fail('password-required')
      if (!(await this.checkPassword(password))) return fail('wrong-password')
    }
    // During password verification the code may have been used by another connection or cancelled.
    if (this.active !== state) return { ok: false, code: 'token-used' }
    this.retire('token-used')
    const device = this.insertDevice(info.publicKey, name, platform)
    this.options.onPaired?.(device)
    this.options.onChange?.()
    return { ok: true, device, paired: true }
  }

  // ── Password ─────────────────────────────────────────────────────────────

  hasPassword(): boolean {
    return this.db.prepare('select 1 as x from kv where key = ?').get(PASSWORD_KEY) !== undefined
  }

  /** null removes the password. Throws (translated message) if the length is not valid. */
  async setPassword(password: string | null): Promise<void> {
    if (password === null) {
      this.db.prepare('delete from kv where key = ?').run(PASSWORD_KEY)
      return
    }
    if (typeof password !== 'string' || password.length < REMOTE_PASSWORD_MIN || password.length > REMOTE_PASSWORD_MAX) {
      throw new Error(t('The password must have between {min} and {max} characters.', { min: REMOTE_PASSWORD_MIN, max: REMOTE_PASSWORD_MAX }))
    }
    const salt = randomBytes(16)
    const hash = await derive(password, salt)
    this.db.prepare('insert or replace into kv (key, value) values (?, ?)').run(PASSWORD_KEY, JSON.stringify({ v: 1, ...SCRYPT, salt: salt.toString('base64'), hash: hash.toString('base64') }))
  }

  private async checkPassword(password: string): Promise<boolean> {
    const row = this.db.prepare('select value from kv where key = ?').get(PASSWORD_KEY) as { value: string } | undefined
    if (!row) return true
    const stored = JSON.parse(row.value) as { salt: string; hash: string }
    const expected = Buffer.from(stored.hash, 'base64')
    const actual = await derive(password, Buffer.from(stored.salt, 'base64'))
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  // ── Devices ──────────────────────────────────────────────────────────────

  private rowOf(r: Record<string, unknown>): DeviceRow {
    return {
      id: r.id as string,
      name: r.name as string,
      platform: r.platform as RemotePlatform,
      publicKey: r.public_key as string,
      pushToken: (r.push_token as string | null) ?? null,
      notify: parseNotifyPrefs(r.notify),
      locale: isLocale(r.locale) ? r.locale : 'en',
      createdAt: r.created_at as number,
      lastSeenAt: (r.last_seen_at as number | null) ?? null,
      revokedAt: (r.revoked_at as number | null) ?? null
    }
  }

  device(id: string): DeviceRow | null {
    const row = this.db.prepare('select * from devices where id = ?').get(id)
    return row ? this.rowOf(row) : null
  }

  /** Non-revoked devices, most recent first. */
  devices(): DeviceRow[] {
    return this.db
      .prepare('select * from devices where revoked_at is null order by created_at desc, rowid desc')
      .all()
      .map((r) => this.rowOf(r))
  }

  /** For the window state. `connected`: ids with an authenticated connection. */
  info(connected: ReadonlySet<string>): RemoteDeviceInfo[] {
    return this.devices().map((d) => this.infoOf(d, connected.has(d.id)))
  }

  infoOf(d: DeviceRow, connected: boolean): RemoteDeviceInfo {
    return { id: d.id, name: d.name, platform: d.platform, createdAt: d.createdAt, lastSeenAt: connected ? this.now() : d.lastSeenAt, connected, pushEnabled: d.pushToken !== null }
  }

  /** A phone with the same key that is already paired (and not revoked) keeps its id: pairing again is idempotent. */
  private insertDevice(publicKey: string, name: string, platform: RemotePlatform): DeviceRow {
    const now = this.now()
    const existing = this.db.prepare('select * from devices where public_key = ? and revoked_at is null').get(publicKey)
    if (existing) {
      this.db.prepare('update devices set name = ?, platform = ?, last_seen_at = ? where id = ?').run(name, platform, now, existing.id as string)
      return this.device(existing.id as string)!
    }
    const id = toBase64Url(randomBytes(12))
    this.db.prepare('insert into devices (id, name, platform, public_key, push_token, created_at, last_seen_at, revoked_at) values (?, ?, ?, ?, null, ?, ?, null)').run(id, name, platform, publicKey, now, now)
    return this.device(id)!
  }

  touch(id: string): void {
    this.db.prepare('update devices set last_seen_at = ? where id = ?').run(this.now(), id)
  }

  /** False if the device does not exist or was already revoked. */
  revoke(id: string): boolean {
    return Number(this.db.prepare('update devices set revoked_at = ?, push_token = null where id = ? and revoked_at is null').run(this.now(), id).changes) > 0
  }

  revokeAll(): void {
    this.db.prepare('update devices set revoked_at = ?, push_token = null where revoked_at is null').run(this.now())
  }

  /** Returns the cleaned name. */
  rename(id: string, name: unknown): string {
    const clean = cleanDeviceName(name)
    if (!clean) throw new Error(t('Enter a name for the device.'))
    if (Number(this.db.prepare('update devices set name = ? where id = ? and revoked_at is null').run(clean, id).changes) === 0) throw new Error(t('Device not found.'))
    return clean
  }

  /** Push notification token; null removes it. */
  setPushToken(id: string, token: string | null, platform: RemotePlatform): void {
    // The same token on another row (re-paired phone): it is removed, so duplicate pushes do not arrive.
    if (token) this.db.prepare('update devices set push_token = null where push_token = ? and id != ? and revoked_at is null').run(token, id)
    this.db.prepare('update devices set push_token = ?, platform = ? where id = ? and revoked_at is null').run(token, platform, id)
  }

  /** Removes a token that Expo says is no longer valid (DeviceNotRegistered); only if it is still the saved one. */
  clearPushToken(token: string): void {
    const changed = Number(this.db.prepare('update devices set push_token = null where push_token = ?').run(token).changes) > 0
    if (changed) this.options.onChange?.()
  }

  /** Push preferences of the device (already validated by the allowlist). */
  setNotifyPrefs(id: string, prefs: RemoteNotifyPrefs): void {
    this.db.prepare('update devices set notify = ? where id = ? and revoked_at is null').run(JSON.stringify(prefs), id)
  }

  /** Language declared by the phone in the handshake; saved only if it changes. */
  setLocale(id: string, locale: Locale): void {
    this.db.prepare('update devices set locale = ? where id = ? and revoked_at is null and (locale is null or locale != ?)').run(locale, id, locale)
  }

  /** Devices that can receive a push: not revoked and with a token. */
  pushTargets(): DeviceRow[] {
    return this.db
      .prepare('select * from devices where revoked_at is null and push_token is not null')
      .all()
      .map((r) => this.rowOf(r))
  }

  // ── Log of remote actions ────────────────────────────────────────────────

  /** `detail`: short, non-sensitive summary, already translated. */
  record(device: Pick<DeviceRow, 'id' | 'name'>, action: RemoteLogAction, sessionId: string | null, detail: string): RemoteLogEntry {
    const at = this.now()
    const clean = detail.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200)
    const result = this.db.prepare('insert into remote_log (device_id, at, action, session_id, detail) values (?, ?, ?, ?, ?)').run(device.id, at, action, sessionId, clean)
    if (++this.inserts % PRUNE_EVERY === 0) this.prune()
    return { id: Number(result.lastInsertRowid), deviceId: device.id, deviceName: device.name, at, action, sessionId, detail: clean }
  }

  list(before?: number, limit?: number): RemoteLogPage {
    const size = Math.min(Math.max(Math.floor(Number.isFinite(limit) ? (limit as number) : 50), 1), 200)
    const rows = this.db
      .prepare(
        `select l.id, l.device_id, l.at, l.action, l.session_id, l.detail, coalesce(d.name, '') as name
         from remote_log l left join devices d on d.id = l.device_id
         where (? is null or l.id < ?) order by l.id desc limit ?`
      )
      .all(before ?? null, before ?? null, size + 1)
    const entries = rows.slice(0, size).map((r) => ({
      id: r.id as number,
      deviceId: r.device_id as string,
      deviceName: (r.name as string) || t('Unknown device'),
      at: r.at as number,
      action: r.action as RemoteLogAction,
      sessionId: (r.session_id as string | null) ?? null,
      detail: r.detail as string
    }))
    return { entries, hasMore: rows.length > size }
  }

  private prune(): void {
    this.db
      .prepare('delete from remote_log where at < ? or id <= coalesce((select id from remote_log order by id desc limit 1 offset ?), 0)')
      .run(this.now() - LOG_MAX_DAYS * 86_400_000, LOG_MAX_ENTRIES)
  }
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (error, key) => (error ? reject(error) : resolve(key)))
  })
}
