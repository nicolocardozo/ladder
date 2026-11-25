// Abbinamento del telefono (LAD-51), TypeScript puro come noise.ts: gira uguale sul Mac, sul telefono (React Native / Hermes) e nelle prove.
// Contiene il formato del QR, l'impronta della chiave del Mac e le firme del dispositivo legate al canale.
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { REMOTE_PAIRING_VERSION, type RemoteAuthKind, type RemotePairingPayload } from '../protocol.ts'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const REVERSE = new Map([...ALPHABET].map((c, i) => [c, i]))

/** Base64url senza padding: niente Buffer né atob, che su Hermes possono mancare. */
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

/** Lancia se il testo non è base64url valido (caratteri fuori alfabeto, lunghezza impossibile). */
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

/** `ladder://pair#<base64url(JSON)>`: il contenuto sta nel frammento, che non parte mai verso un server. */
export function encodePairingUrl(payload: RemotePairingPayload): string {
  return PAIRING_URL_PREFIX + toBase64Url(encoder.encode(JSON.stringify(payload)))
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** Legge il testo di un QR. Lancia `Error('Invalid pairing code')` se non è un abbinamento di Ladder o ha una forma sbagliata. */
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
  // Servono la chiave del Mac (32 byte) e almeno una strada per raggiungerlo.
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

/** Impronta della chiave del Mac per il confronto a occhio, uguale su Mac e telefono: "7F3A 91C2 · E04B 5D18" (primi 8 byte di sha256). */
export function keyFingerprint(publicKey: Uint8Array): string {
  const hex = [...sha256(publicKey).subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} · ${hex.slice(8, 12)} ${hex.slice(12, 16)}`
}

/** Testo firmato dal dispositivo: lega la firma a questa connessione (hash dell'handshake Noise) e al tipo di messaggio. */
export function channelBinding(kind: RemoteAuthKind, handshakeHash: Uint8Array): Uint8Array {
  return encoder.encode(`ladder-device-v1|${kind}|${toBase64Url(handshakeHash)}`)
}

export interface DeviceKeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

/** Chiave Ed25519 del telefono: la privata resta nel suo archivio sicuro e non esce mai. */
export function generateDeviceKey(): DeviceKeyPair {
  const secretKey = ed25519.utils.randomSecretKey()
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
}

/** Firma (base64url) del testo di binding, per `pair` e `auth`. */
export function signChannelBinding(secretKey: Uint8Array, kind: RemoteAuthKind, handshakeHash: Uint8Array): string {
  return toBase64Url(ed25519.sign(channelBinding(kind, handshakeHash), secretKey))
}

/** False per qualunque firma o chiave malformata: non lancia mai. */
export function verifyChannelBinding(publicKey: Uint8Array, kind: RemoteAuthKind, handshakeHash: Uint8Array, signature: string): boolean {
  try {
    return ed25519.verify(fromBase64Url(signature), channelBinding(kind, handshakeHash), publicKey)
  } catch {
    return false
  }
}

/**
 * Id del Mac nei dati dei push (RemotePushData.mac): base64url(sha256('ladder-push|' + chiave del Mac in base64url)) ridotto a 16 caratteri.
 * Il telefono lo calcola dalla chiave del Mac che ha nel suo abbinamento (`RemotePairingPayload.key`) e lo confronta; non è l'id del relay,
 * quindi chi lo vede (Expo, Apple, Google) non può usarlo per entrare nella stanza del relay. Uguale su ogni trasporto.
 */
export function pushMacId(macKey: string): string {
  return toBase64Url(sha256(new TextEncoder().encode(`ladder-push|${macKey}`))).slice(0, 16)
}
