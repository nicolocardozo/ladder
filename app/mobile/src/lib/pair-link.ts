// Reading of the pairing link (`ladder://pair#…`, from the QR or a deep link) and what is needed to show it. Pure logic only
// (tested with node --test). Uses the shared helpers of shared/remote/pairing.ts with a relative import: the @shared alias does not
// exist outside Metro, and this file also runs under `node`.
import type { RemotePairingPayload } from '../../../desktop/src/shared/protocol.ts'
import { decodePairingUrl, fromBase64Url, keyFingerprint, PAIRING_URL_PREFIX } from '../../../desktop/src/shared/remote/pairing.ts'

export type PairLinkResult = { ok: true; payload: RemotePairingPayload } | { ok: false; reason: 'invalid' | 'expired' | 'no-relay'; mac?: string }

/**
 * Is the text (QR or link) a valid, not yet expired Ladder pairing? A code without a relay (direct WebSocket only) is
 * a development thing: it is accepted only with `allowDirect` (development builds), never in production.
 */
export function readPairingLink(text: string, now = Date.now(), opts: { allowDirect?: boolean } = {}): PairLinkResult {
  let payload: RemotePairingPayload
  try {
    payload = decodePairingUrl(text)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  // The Mac's clock and the phone's may differ slightly: the Mac decides the real expiry, here only the clear-cut case.
  if (payload.exp <= now) return { ok: false, reason: 'expired', mac: payload.mac }
  if (!opts.allowDirect && !(payload.relay && payload.id)) return { ok: false, reason: 'no-relay', mac: payload.mac }
  return { ok: true, payload }
}

export const isPairingLink = (text: string): boolean => text.trim().toLowerCase().startsWith(PAIRING_URL_PREFIX)

/** Fingerprint of the Mac's key for confirmation ("7F3A 91C2 · E04B 5D18"), the same one the Mac shows. */
export function payloadFingerprint(payload: RemotePairingPayload): string {
  return keyFingerprint(fromBase64Url(payload.key))
}

/** Where the phone will connect: the relay's name, or "direct" for the local development WebSocket. */
export function routeOf(payload: Pick<RemotePairingPayload, 'relay' | 'id' | 'ws'>): { kind: 'relay'; host: string } | { kind: 'direct'; host: string } {
  if (payload.relay && payload.id) return { kind: 'relay', host: hostOf(payload.relay) }
  return { kind: 'direct', host: hostOf(payload.ws ?? '') }
}

function hostOf(url: string): string {
  const m = /^wss?:\/\/([^/?#]+)/i.exec(url)
  return m ? m[1] : url
}
