// Intercetta i link in ingresso prima che expo-router li instradi. `ladder://pair#<abbinamento>`: il frammento (che porta il codice
// monouso) non è parte del percorso, quindi lo si parcheggia in memoria e si manda a /pair, che lo legge.
import { isBlockedLink, linkHead } from '@/lib/deep-link'
import { setPendingPairLink } from '@/lib/pending-link'

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const hash = path.indexOf('#')
    const head = linkHead(path)
    // Un passo dell'abbinamento (password, nome…) non può saltare la conferma; gli sheet e il tab "+" non sono destinazioni: alla radice.
    if (isBlockedLink(path)) return '/'
    if (hash >= 0 && /^\/?pair$/i.test(head)) {
      setPendingPairLink(`ladder://pair${path.slice(hash)}`)
      return '/pair'
    }
  } catch {
    // un link strano non deve far cadere l'app: si lascia instradare com'è
  }
  return path
}
