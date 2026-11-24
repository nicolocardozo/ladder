// Intercetta i link in ingresso prima che expo-router li instradi. `ladder://pair#<abbinamento>`: il frammento (che porta il codice
// monouso) non è parte del percorso, quindi lo si parcheggia in memoria e si manda a /pair, che lo legge.
import { setPendingPairLink } from '@/lib/pending-link'

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const hash = path.indexOf('#')
    const head = (hash >= 0 ? path.slice(0, hash) : path).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '/').replace(/\/+$/, '')
    // Un link verso un passo dell'abbinamento (password, nome…) non può saltare la conferma: si manda alla radice.
    if (/^\/?pair\/.+/i.test(head)) return '/'
    if (hash >= 0 && /^\/?pair$/i.test(head)) {
      setPendingPairLink(`ladder://pair${path.slice(hash)}`)
      return '/pair'
    }
  } catch {
    // un link strano non deve far cadere l'app: si lascia instradare com'è
  }
  return path
}
