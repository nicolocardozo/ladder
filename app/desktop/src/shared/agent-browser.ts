// Rules on the agent browser's addresses, shared by host (decides) and main (enforces).
// Pure functions: they can be tested without Electron.

/** Host name without the trailing dot and lowercase; IPv6 stays in square brackets, as in `URL.hostname`. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '')
}

/** Only the machine itself: localhost, *.localhost, 127.0.0.1 and ::1. Private networks (192.168.x, 10.x) don't count as local. */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host)
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]'
}

export const AGENT_URL_MAX = 2000

/** Address acceptable for the agent: http/https, no credentials in the address, limited length. */
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
