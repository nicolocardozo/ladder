// Dal motivo grezzo di un errore di connessione (testo del WebSocket, errore di Noise…) a poche categorie traducibili:
// il telefono non mostra mai il testo tecnico.
export type ReasonKind = 'timeout' | 'refused' | 'lost' | 'secure'

export function reasonKind(reason: string | undefined): ReasonKind | null {
  if (!reason) return null
  const r = reason.toLowerCase()
  if (/timed out|timeout|did not answer|no answer/.test(r)) return 'timeout'
  // Errori del canale cifrato: handshake, decifratura, versione del protocollo, messaggi malformati.
  if (/noise|decrypt|handshake|protocol|version|frame|remote:|invalid|unsupported/.test(r)) return 'secure'
  if (/lost|closed|reset|abort|disconnected|network/.test(r)) return 'lost'
  if (/refused|failed|unreachable|econn|enotfound|hostname|offline/.test(r)) return 'refused'
  return null
}
