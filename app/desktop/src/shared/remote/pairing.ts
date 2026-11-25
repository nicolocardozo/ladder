// Phone pairing, plain TypeScript like noise.ts: it runs the same on the Mac, on the phone (React Native / Hermes) and in tests.
// It holds the QR format, the Mac's key fingerprint and the device signatures bound to the channel.
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { REMOTE_PAIRING_VERSION, type RemoteAuthKind, type RemotePairingPayload } from '../protocol.ts'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const REVERSE = new Map([...ALPHABET].map((c, i) => [c, i]))

/** Base64url without padding: no Buffer or atob, which may be missing on Hermes. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]
  }
  return out
}

/** Throws if the text is not valid base64url (characters outside the alphabet, impossible length). */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error('Invalid base64url')
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let at = 0
  for (let i = 0; i < text.length; i += 4) {
    let n = 0
    let bits = 0
    for (let j = 0; j < 4 && i + j < text.length; j++) {
      const v = REVERSE.get(text[i + j])
      if (v === undefined) throw new Error('Invalid base64url')
      n = (n << 6) | v
      bits += 6
    }
    n <<= 24 - bits
    out[at++] = (n >> 16) & 255
    if (bits > 12) out[at++] = (n >> 8) & 255
    if (bits > 18) out[at++] = n & 255
  }
  return out
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export const PAIRING_URL_PREFIX = 'ladder://pair#'
const MAX_PAIRING_URL = 4096

/** `ladder://pair#<base64url(JSON)>`: the content lives in the fragment, which never goes to a server. */
export function encodePairingUrl(payload: RemotePairingPayload): string {
  return PAIRING_URL_PREFIX + toBase64Url(encoder.encode(JSON.stringify(payload)))
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** Reads a QR's text. Throws `Error('Invalid pairing code')` if it is not a Ladder pairing or has the wrong shape. */
export function decodePairingUrl(url: string): RemotePairingPayload {
  const fail = (): never => {
    throw new Error('Invalid pairing code')
  }
  const text = url.trim()
  if (text.length > MAX_PAIRING_URL || !text.toLowerCase().startsWith(PAIRING_URL_PREFIX)) return fail()
  let raw: unknown
  try {
    raw = JSON.parse(decoder.decode(fromBase64Url(text.slice(PAIRING_URL_PREFIX.length))))
  } catch {
    return fail()
  }
  if (typeof raw !== 'object' || raw === null) return fail()
  const p = raw as Record<string, unknown>
  if (p.v !== REMOTE_PAIRING_VERSION || !isText(p.mac, 64) || !isText(p.key, 64) || !isText(p.token, 128) || typeof p.exp !== 'number' || !Number.isFinite(p.exp) || typeof p.pw !== 'boolean') return fail()
  for (const field of ['relay', 'id', 'ws'] as const) if (p[field] !== undefined && !isText(p[field], 512)) return fail()
  // The Mac's key (32 bytes) and at least one way to reach it are required.
  let key: Uint8Array
  try {
    key = fromBase64Url(p.key as string)
  } catch {
    return fail()
  }
  if (key.length !== 32) return fail()
  const hasRelay = p.relay !== undefined && p.id !== undefined
  if (!hasRelay && p.ws === undefined) return fail()
  for (const field of ['relay', 'ws'] as const) if (p[field] !== undefined && !/^wss?:\/\//.test(p[field] as string)) return fail()
  return {
    v: REMOTE_PAIRING_VERSION,
    mac: p.mac as string,
    key: p.key as string,
    ...(hasRelay ? { relay: p.relay as string, id: p.id as string } : {}),
    ...(p.ws !== undefined ? { ws: p.ws as string } : {}),
    token: p.token as string,
    exp: p.exp,
    pw: p.pw
  }
}

/** Fingerprint of the Mac's key for eyeball comparison, identical on Mac and phone: "7F3A 91C2 · E04B 5D18" (first 8 bytes of sha256). */
export function keyFingerprint(publicKey: Uint8Array): string {
  const hex = [...sha256(publicKey).subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} · ${hex.slice(8, 12)} ${hex.slice(12, 16)}`
}

/** Text signed by the device: binds the signature to this connection (hash of the Noise handshake) and to the message type. */
export function channelBinding(kind: RemoteAuthKind, handshakeHash: Uint8Array): Uint8Array {
  return encoder.encode(`ladder-device-v1|${kind}|${toBase64Url(handshakeHash)}`)
}

export interface DeviceKeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

/** The phone's Ed25519 key: the private one stays in its secure storage and never leaves. */
export function generateDeviceKey(): DeviceKeyPair {
  const secretKey = ed25519.utils.randomSecretKey()
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
}

/** Signature (base64url) of the binding text, for `pair` and `auth`. */
export function signChannelBinding(secretKey: Uint8Array, kind: RemoteAuthKind, handshakeHash: Uint8Array): string {
  return toBase64Url(ed25519.sign(channelBinding(kind, handshakeHash), secretKey))
}

/** False for any malformed signature or key: never throws. */
export function verifyChannelBinding(publicKey: Uint8Array, kind: RemoteAuthKind, handshakeHash: Uint8Array, signature: string): boolean {
  try {
    return ed25519.verify(fromBase64Url(signature), channelBinding(kind, handshakeHash), publicKey)
  } catch {
    return false
  }
}

/**
 * Mac id in push data (RemotePushData.mac): base64url(sha256('ladder-push|' + Mac key in base64url)) cut to 16 characters.
 * The phone computes it from the Mac key it holds in its pairing (`RemotePairingPayload.key`) and compares it; it is not the relay id,
 * so whoever sees it (Expo, Apple, Google) cannot use it to enter the relay room. Identical on every transport.
 */
export function pushMacId(macKey: string): string {
  return toBase64Url(sha256(new TextEncoder().encode(`ladder-push|${macKey}`))).slice(0, 16)
}
