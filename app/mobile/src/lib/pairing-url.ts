// Validazione e lettura dei dati di abbinamento. Solo logica pura (provata con node --test).

/** base64url → byte (32 per una chiave Noise). */
export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function isValidMacKey(text: string): boolean {
  try {
    return /^[A-Za-z0-9_-]+$/.test(text.trim()) && fromBase64Url(text.trim()).length === 32
  } catch {
    return false
  }
}

/** Un abbinamento si salva solo se ha un indirizzo WebSocket e una chiave del Mac da 32 byte: mai sovrascrivere uno buono con uno incompleto. */
export function isValidPairing(draft: { wsUrl: string; macKey: string }): boolean {
  return /^wss?:\/\/\S+$/.test(draft.wsUrl.trim()) && isValidMacKey(draft.macKey)
}

/**
 * Formato provvisorio del codice, finché non c'è LAD-51: `ladder://pair?k=<chiave base64url>&u=<ws://…>&n=<nome del Mac>`.
 * Con il relay il codice porterà l'id del Mac, la chiave e l'indirizzo del relay al posto di `u`.
 */
export function parsePairingUrl(data: string): { macKey: string; wsUrl: string; macName: string } | null {
  const m = /^ladder:\/\/pair\?(.*)$/.exec(data.trim())
  if (!m) return null
  const params = new URLSearchParams(m[1])
  const macKey = params.get('k')
  const wsUrl = params.get('u')
  if (!macKey || !wsUrl) return null
  return { macKey, wsUrl, macName: params.get('n') ?? '' }
}

/** Impronta della chiave da mostrare nella conferma: i primi 12 caratteri in gruppi da 4. */
export function fingerprint(macKey: string): string {
  return (macKey.slice(0, 12).match(/.{1,4}/g) ?? []).join(' ')
}
