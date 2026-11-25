// Lettura del link di abbinamento (`ladder://pair#…`, dal QR o da un deep link) e ciò che serve a mostrarlo. Solo logica pura
// (provata con node --test). Usa i helper condivisi di shared/remote/pairing.ts con import relativo: l'alias @shared non
// esiste fuori da Metro, e questo file gira anche sotto `node`.
import type { RemotePairingPayload } from '../../../desktop/src/shared/protocol.ts'
import { decodePairingUrl, fromBase64Url, keyFingerprint, PAIRING_URL_PREFIX } from '../../../desktop/src/shared/remote/pairing.ts'

export type PairLinkResult = { ok: true; payload: RemotePairingPayload } | { ok: false; reason: 'invalid' | 'expired' | 'no-relay'; mac?: string }

/**
 * Il testo (QR o link) è un abbinamento di Ladder valido e non ancora scaduto? Un codice senza relay (solo WebSocket diretto) è
 * una cosa da sviluppo: lo si accetta solo con `allowDirect` (le build di sviluppo), mai in produzione.
 */
export function readPairingLink(text: string, now = Date.now(), opts: { allowDirect?: boolean } = {}): PairLinkResult {
  let payload: RemotePairingPayload
  try {
    payload = decodePairingUrl(text)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  // L'orologio del Mac e quello del telefono possono differire di poco: la scadenza vera la decide il Mac, qui solo il caso chiaro.
  if (payload.exp <= now) return { ok: false, reason: 'expired', mac: payload.mac }
  if (!opts.allowDirect && !(payload.relay && payload.id)) return { ok: false, reason: 'no-relay', mac: payload.mac }
  return { ok: true, payload }
}

export const isPairingLink = (text: string): boolean => text.trim().toLowerCase().startsWith(PAIRING_URL_PREFIX)

/** Impronta della chiave del Mac per la conferma ("7F3A 91C2 · E04B 5D18"), uguale a quella che mostra il Mac. */
export function payloadFingerprint(payload: RemotePairingPayload): string {
  return keyFingerprint(fromBase64Url(payload.key))
}

/** Dove si collegherà il telefono: il nome del relay, o "direct" per il WebSocket locale di sviluppo. */
export function routeOf(payload: Pick<RemotePairingPayload, 'relay' | 'id' | 'ws'>): { kind: 'relay'; host: string } | { kind: 'direct'; host: string } {
  if (payload.relay && payload.id) return { kind: 'relay', host: hostOf(payload.relay) }
  return { kind: 'direct', host: hostOf(payload.ws ?? '') }
}

function hostOf(url: string): string {
  const m = /^wss?:\/\/([^/?#]+)/i.exec(url)
  return m ? m[1] : url
}
