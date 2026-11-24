// Decisioni pure sul token push: quando riusare quello già buono e quali errori di Expo sono passeggeri. Provate con node --test.

/** Errori di Expo che passano da soli (rete, server): qualunque altro (credenziali FCM/APNs, projectId) è definitivo per questa build. */
export function isTransientTokenError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ERR_NOTIFICATIONS_NETWORK_ERROR' || code === 'ERR_NOTIFICATIONS_SERVER_ERROR'
}

/** Il token buono in cache vale ancora? Sì se non è arrivato un token di sistema diverso da quello a cui corrisponde. */
export function cachedTokenStillValid(cached: { token: string; device: string | null } | null, device?: string): boolean {
  return !!cached && (!device || device === cached.device)
}

/** "Non configurato" per errori passeggeri solo senza token buono e dopo `limit` tentativi di fila. */
export function notSetUpAfterTransient(hasCached: boolean, failures: number, limit = 3): boolean {
  return !hasCached && failures >= limit
}
