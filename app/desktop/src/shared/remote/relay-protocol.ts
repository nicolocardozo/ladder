// Message format between Mac, relay and phone. Plain TypeScript: used by the relay (Worker), the host and the phone.
//
// Endpoint: `<relay>/v1/<id>?role=mac|phone` (WebSocket). `id` = base64url(sha256(the Mac's Ed25519 public key))[0..32].
//
// Phone: binary messages are Noise messages passed through as they are (no envelope); text ones are relay controls
//   {"t":"mac","online":true} | {"t":"mac","online":false,"since":<ms|null>,"reason":"offline|asleep|quit|rekeyed|unknown"}.
//   Every `online:true` is a new link with the Mac: the Noise handshake starts over.
//   The text "ping" gets "pong" from the relay (keeps the connection alive without waking the Mac).
//
// Mac: a single socket for all phones. Text messages = JSON controls:
//   relay→Mac  {"t":"challenge","nonce":"<b64url>"}   on open
//   Mac→relay  {"t":"auth","key":"<b64url Ed25519>","sig":"<b64url>"}   signature of authPayload(origin, id, nonce)
//   relay→Mac  {"t":"ready","maxPhones":n}
//   Mac→relay  {"t":"state","state":"asleep|quit|rekeyed|awake"}   asleep/quit/rekeyed: the relay closes the socket and remembers the reason
//     (rekeyed = the Mac regenerated its key: it will not return under this id, and the reason stays as long as the relay remembers the id)
// Binary messages are frames: [type u8][connId u32 BE][payload].
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { RemoteMacStatus } from '../protocol.ts'
import { NOISE_MAX_MESSAGE } from './limits.ts'

export const RELAY_VERSION = 'v1'
export const RELAY_ID_LENGTH = 32
export const RELAY_MAX_PHONES = 8
/** Maximum size of a WebSocket message from the phone (one Noise message) and from the Mac (Noise message + frame header). */
export const RELAY_MAX_PHONE_MESSAGE = NOISE_MAX_MESSAGE
export const RELAY_FRAME_HEADER = 5
export const RELAY_MAX_MAC_MESSAGE = NOISE_MAX_MESSAGE + RELAY_FRAME_HEADER

/** Frame types on the Mac's socket. */
export const RELAY_FRAME_DATA = 1
/** relay→Mac: a phone connected (or, after the Mac reconnects, is still there). */
export const RELAY_FRAME_OPEN = 2
/** In both directions: that phone is gone / the Mac closes it. */
export const RELAY_FRAME_CLOSE = 3

/** Keepalive text: the relay answers by itself (Cloudflare auto-response). */
export const RELAY_PING = 'ping'
export const RELAY_PONG = 'pong'
/** How often phone and Mac send `ping`; the relay closes whoever has been silent for more than RELAY_IDLE_MS. */
export const RELAY_PING_INTERVAL_MS = 20_000
export const RELAY_IDLE_MS = 100_000

/** WebSocket close codes used by the relay (4000-4999: application-defined). */
export const RELAY_CLOSE = {
  badRequest: 4000,
  /** Another Mac with the same key took over. */
  replaced: 4001,
  authFailed: 4003,
  tooManyPhones: 4004,
  /** The Mac closed that phone. */
  macClosed: 4005,
  idle: 4006,
  rateLimit: 4008,
  tooBig: 4009
} as const

export type MacLiveState = 'asleep' | 'quit' | 'rekeyed' | 'awake'

export type RelayToMac = { t: 'challenge'; nonce: string } | { t: 'ready'; maxPhones: number }
export type MacToRelay = { t: 'auth'; key: string; sig: string } | { t: 'state'; state: MacLiveState }
export type RelayToPhone = { t: 'mac' } & RemoteMacStatus

const encoder = new TextEncoder()

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Null if the text is not valid base64url. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Mac id on the relay: derived from the public key, so whoever lacks the private key cannot take that spot. */
export function relayIdFromPublicKey(publicKey: Uint8Array): string {
  return toBase64Url(sha256(publicKey)).slice(0, RELAY_ID_LENGTH)
}

export const isRelayId = (value: string): boolean => value.length === RELAY_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(value)

/**
 * Relay origin (scheme + host[:port]) in the form the Worker sees it: wss→https, ws→http, default port omitted.
 * It goes into the signature, so a challenge signed for one relay is not valid on another (a malicious relay forwarding a real one's challenge).
 * If the relay sits behind a proxy that changes the host, Mac and relay see different origins and authentication fails.
 */
export function relayOrigin(base: string): string {
  const url = new URL(base)
  if (url.protocol === 'wss:') url.protocol = 'https:'
  else if (url.protocol === 'ws:') url.protocol = 'http:'
  return url.origin
}

/** Text the Mac signs to prove it owns the id's key, on that relay. */
export function authPayload(origin: string, id: string, nonce: string): Uint8Array {
  return encoder.encode(`ladder-relay-v2|${origin}|${id}|${nonce}`)
}

export function signAuth(secretKey: Uint8Array, origin: string, id: string, nonce: string): MacToRelay {
  return { t: 'auth', key: toBase64Url(ed25519.getPublicKey(secretKey)), sig: toBase64Url(ed25519.sign(authPayload(origin, id, nonce), secretKey)) }
}

/** Verifies the Mac's authentication: the presented key must yield the id and the signature must be valid for that relay and that nonce. */
export function verifyAuth(origin: string, id: string, nonce: string, message: { key: string; sig: string }): boolean {
  const key = fromBase64Url(message.key)
  const sig = fromBase64Url(message.sig)
  if (!key || !sig || key.length !== 32 || sig.length !== 64) return false
  if (relayIdFromPublicKey(key) !== id) return false
  try {
    return ed25519.verify(sig, authPayload(origin, id, nonce), key)
  } catch {
    return false
  }
}

export function encodeFrame(type: number, connId: number, payload?: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(RELAY_FRAME_HEADER + (payload?.length ?? 0))
  out[0] = type
  new DataView(out.buffer).setUint32(1, connId, false)
  if (payload) out.set(payload, RELAY_FRAME_HEADER)
  return out
}

export function decodeFrame(bytes: Uint8Array): { type: number; connId: number; payload: Uint8Array } | null {
  if (bytes.length < RELAY_FRAME_HEADER) return null
  return { type: bytes[0], connId: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false), payload: bytes.subarray(RELAY_FRAME_HEADER) }
}

/** WebSocket address of an id on the relay. Accepts ws(s):// and http(s)://; plain text (ws, http) only toward this computer. */
export function relayEndpoint(base: string, id: string, role: 'mac' | 'phone'): string {
  const url = new URL(base)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('Relay URL must start with wss:// (or ws:// for localhost).')
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol === 'ws:' && !local) throw new Error('Relay URL must use wss:// except for localhost.')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${RELAY_VERSION}/${id}`
  url.search = `?role=${role}`
  url.hash = ''
  return url.toString()
}
