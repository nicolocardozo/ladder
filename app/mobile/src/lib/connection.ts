// From the raw reason of a connection error (WebSocket text, Noise error…) to a few translatable categories:
// the phone never shows the technical text.
export type ReasonKind = 'timeout' | 'refused' | 'lost' | 'secure'

export function reasonKind(reason: string | undefined): ReasonKind | null {
  if (!reason) return null
  const r = reason.toLowerCase()
  if (/timed out|timeout|did not answer|no answer/.test(r)) return 'timeout'
  // Encrypted channel errors: handshake, decryption, protocol version, malformed messages.
  if (/noise|decrypt|handshake|protocol|version|frame|remote:|invalid|unsupported/.test(r)) return 'secure'
  if (/lost|closed|reset|abort|disconnected|network/.test(r)) return 'lost'
  if (/refused|failed|unreachable|econn|enotfound|hostname|offline/.test(r)) return 'refused'
  return null
}
