// Regole sugli indirizzi del browser dell'agente (LAD-57 parte 2), condivise da host (decide) e main (fa rispettare).
// Funzioni pure: si provano senza Electron.

/** Nome dell'host senza punto finale e in minuscolo; l'IPv6 resta tra parentesi quadre, come in `URL.hostname`. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '')
}

/** Solo il computer stesso: localhost, *.localhost, 127.0.0.1 e ::1. Le reti private (192.168.x, 10.x) non contano come locali. */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host)
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]'
}

export const AGENT_URL_MAX = 2000

/** Indirizzo accettabile per l'agente: http/https, senza credenziali nell'indirizzo, lunghezza limitata. */
export function parseAgentUrl(input: string): { ok: true; url: URL; host: string; local: boolean } | { ok: false; reason: 'invalid' | 'scheme' | 'credentials' | 'long' } {
  const text = input.trim()
  if (text.length > AGENT_URL_MAX) return { ok: false, reason: 'long' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' }
  if (url.username || url.password) return { ok: false, reason: 'credentials' }
  const host = normalizeHost(url.hostname)
  return { ok: true, url, host, local: isLoopbackHost(host) }
}
