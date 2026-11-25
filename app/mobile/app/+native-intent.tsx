// Intercepts incoming links before expo-router routes them. `ladder://pair#<pairing>`: the fragment (which carries the one-time
// code) is not part of the path, so it is parked in memory and we go to /pair, which reads it.
import { isBlockedLink, linkHead } from '@/lib/deep-link'
import { setPendingPairLink } from '@/lib/pending-link'

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const hash = path.indexOf('#')
    const head = linkHead(path)
    // A pairing step (password, name…) can't skip the confirmation; sheets and the "+" tab are not destinations: go to the root.
    if (isBlockedLink(path)) return '/'
    if (hash >= 0 && /^\/?pair$/i.test(head)) {
      setPendingPairLink(`ladder://pair${path.slice(hash)}`)
      return '/pair'
    }
  } catch {
    // a strange link must not crash the app: let it route as it is
  }
  return path
}
