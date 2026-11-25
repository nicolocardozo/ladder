// The pairing link that arrived from outside (deep link). expo-router sees it before the screen exists: app/+native-intent.tsx
// intercepts it and parks it here, the /pair screen picks it up on mount. In memory only, never in logs.
let pending: string | null = null

export const setPendingPairLink = (link: string): void => {
  pending = link
}

/** Returns it only once. */
export function takePendingPairLink(): string | null {
  const link = pending
  pending = null
  return link
}

/** Link already read (used or discarded): `useURL` keeps returning the one the app opened with, and it must not be read again. */
let consumed: string | null = null
export const markConsumed = (link: string): void => {
  consumed = link
}
export const wasConsumed = (link: string): boolean => consumed === link
