// Pure decisions on the push token: when to reuse the one that is already good and which Expo errors are transient. Tested with node --test.

/** Expo errors that go away on their own (network, server): any other (FCM/APNs credentials, projectId) is final for this build. */
export function isTransientTokenError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ERR_NOTIFICATIONS_NETWORK_ERROR' || code === 'ERR_NOTIFICATIONS_SERVER_ERROR'
}

/** Is the cached good token still valid? Yes unless a system token different from the one it corresponds to has arrived. */
export function cachedTokenStillValid(cached: { token: string; device: string | null } | null, device?: string): boolean {
  return !!cached && (!device || device === cached.device)
}

/** "Not configured" for transient errors only with no good token and after `limit` attempts in a row. */
export function notSetUpAfterTransient(hasCached: boolean, failures: number, limit = 3): boolean {
  return !hasCached && failures >= limit
}
