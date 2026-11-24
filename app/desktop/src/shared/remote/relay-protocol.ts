// Formato dei messaggi tra Mac, relay e telefono (LAD-50). TypeScript puro: lo usano il relay (Worker), l'host e il telefono.
//
// Endpoint: `<relay>/v1/<id>?role=mac|phone` (WebSocket). `id` = base64url(sha256(chiave pubblica Ed25519 del Mac))[0..32].
//
// Telefono: i messaggi binari sono messaggi Noise passati tali e quali (nessuna busta); quelli di testo sono controlli del relay
//   {"t":"mac","online":true} | {"t":"mac","online":false,"since":<ms|null>,"reason":"offline|asleep|quit|unknown"}.
//   Ogni `online:true` è un collegamento nuovo con il Mac: l'handshake Noise riparte da capo.
//   Il testo "ping" riceve "pong" dal relay (tiene viva la connessione senza svegliarlo).
//
// Mac: un solo socket per tutti i telefoni. Messaggi di testo = controlli JSON:
//   relay→Mac  {"t":"challenge","nonce":"<b64url>"}   all'apertura
//   Mac→relay  {"t":"auth","key":"<b64url Ed25519>","sig":"<b64url>"}   firma di authPayload(origin, id, nonce)
//   relay→Mac  {"t":"ready","maxPhones":n}
//   Mac→relay  {"t":"state","state":"asleep|quit|awake"}   asleep/quit: il relay chiude il socket e ricorda il motivo
// I messaggi binari sono frame: [tipo u8][connId u32 BE][payload].
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { RemoteMacStatus } from '../protocol.ts'
import { NOISE_MAX_MESSAGE } from './limits.ts'

export const RELAY_VERSION = 'v1'
export const RELAY_ID_LENGTH = 32
export const RELAY_MAX_PHONES = 8
/** Massimo di un messaggio WebSocket dal telefono (un messaggio Noise) e dal Mac (messaggio Noise + intestazione del frame). */
export const RELAY_MAX_PHONE_MESSAGE = NOISE_MAX_MESSAGE
export const RELAY_FRAME_HEADER = 5
export const RELAY_MAX_MAC_MESSAGE = NOISE_MAX_MESSAGE + RELAY_FRAME_HEADER

/** Tipi di frame sul socket del Mac. */
export const RELAY_FRAME_DATA = 1
/** relay→Mac: un telefono si è connesso (o, dopo un nuovo collegamento del Mac, è ancora lì). */
export const RELAY_FRAME_OPEN = 2
/** In entrambe le direzioni: quel telefono non c'è più / il Mac lo chiude. */
export const RELAY_FRAME_CLOSE = 3

/** Testo di keepalive: il relay risponde da solo (auto-response di Cloudflare). */
export const RELAY_PING = 'ping'
export const RELAY_PONG = 'pong'
/** Ogni quanto telefono e Mac mandano `ping`; il relay chiude chi tace da più di RELAY_IDLE_MS. */
export const RELAY_PING_INTERVAL_MS = 20_000
export const RELAY_IDLE_MS = 100_000

/** Codici di chiusura WebSocket usati dal relay (4000-4999: applicativi). */
export const RELAY_CLOSE = {
  badRequest: 4000,
  /** Un altro Mac con la stessa chiave ha preso il posto. */
  replaced: 4001,
  authFailed: 4003,
  tooManyPhones: 4004,
  /** Il Mac ha chiuso quel telefono. */
  macClosed: 4005,
  idle: 4006,
  rateLimit: 4008,
  tooBig: 4009
} as const

export type MacLiveState = 'asleep' | 'quit' | 'awake'

export type RelayToMac = { t: 'challenge'; nonce: string } | { t: 'ready'; maxPhones: number }
export type MacToRelay = { t: 'auth'; key: string; sig: string } | { t: 'state'; state: MacLiveState }
export type RelayToPhone = { t: 'mac' } & RemoteMacStatus

const encoder = new TextEncoder()

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Null se il testo non è base64url valido. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Id del Mac sul relay: deriva dalla chiave pubblica, così chi non ha la chiave privata non può prendere quel posto. */
export function relayIdFromPublicKey(publicKey: Uint8Array): string {
  return toBase64Url(sha256(publicKey)).slice(0, RELAY_ID_LENGTH)
}

export const isRelayId = (value: string): boolean => value.length === RELAY_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(value)

/**
 * Origine del relay (schema + host[:porta]) nella forma che ne vede il Worker: wss→https, ws→http, porta predefinita omessa.
 * Entra nella firma, così una sfida firmata per un relay non vale su un altro (un relay malevolo che inoltra la sfida di uno vero).
 * Se il relay sta dietro un proxy che cambia l'host, Mac e relay vedono origini diverse e l'autenticazione fallisce.
 */
export function relayOrigin(base: string): string {
  const url = new URL(base)
  if (url.protocol === 'wss:') url.protocol = 'https:'
  else if (url.protocol === 'ws:') url.protocol = 'http:'
  return url.origin
}

/** Testo che il Mac firma per dimostrare di possedere la chiave dell'id, su quel relay. */
export function authPayload(origin: string, id: string, nonce: string): Uint8Array {
  return encoder.encode(`ladder-relay-v2|${origin}|${id}|${nonce}`)
}

export function signAuth(secretKey: Uint8Array, origin: string, id: string, nonce: string): MacToRelay {
  return { t: 'auth', key: toBase64Url(ed25519.getPublicKey(secretKey)), sig: toBase64Url(ed25519.sign(authPayload(origin, id, nonce), secretKey)) }
}

/** Verifica l'autenticazione del Mac: la chiave presentata deve dare l'id e la firma deve valere per quel relay e quel nonce. */
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

/** Indirizzo WebSocket di un id sul relay. Accetta ws(s):// e http(s)://; il testo in chiaro (ws, http) solo verso questo computer. */
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
