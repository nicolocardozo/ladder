// Ingresso da link: `ladder://pair#…` aperto da fuori (la fotocamera del telefono, un messaggio) porta qui. Si legge il link e si
// va alla conferma, senza passare dalla scansione. Il link non si logga e non si salva.
import * as Linking from 'expo-linking'
import { Redirect, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { PairStep } from '@/features/pair/PairStep'
import { isPairingLink, readPairingLink } from '@/lib/pair-link'
import { markConsumed, takePendingPairLink, wasConsumed } from '@/lib/pending-link'
import { usePairFlow } from '@/store/pair-flow'
import { Button } from '@/ui/Button'
import { linkErrorText } from '@/ui/auth-text'

export default function PairEntry() {
  const url = Linking.useURL()
  const router = useRouter()
  const set = usePairFlow((s) => s.set)
  const [error, setError] = useState<string | null>(null)
  const [waited, setWaited] = useState(false)

  // Il link può essere già arrivato (parcheggiato da +native-intent) o arrivare dopo (useURL).
  const [parked] = useState(() => takePendingPairLink())
  // `useURL` dà anche il link con cui l'app si è aperta: se è già stato usato (o scartato) non si rilegge.
  const link = parked ?? (url && isPairingLink(url) && !wasConsumed(url) ? url : null)

  useEffect(() => {
    if (!link) return
    markConsumed(link)
    const result = readPairingLink(link, Date.now(), { allowDirect: __DEV__ })
    if (result.ok) {
      set({ payload: result.payload, password: '', confirmed: false, failure: null })
      router.replace('/pair/confirm')
    } else setError(linkErrorText(result.reason))
  }, [link, router, set])

  // Se il link non arriva (si è aperta la rotta a mano), si riparte dalla fotocamera.
  useEffect(() => {
    const id = setTimeout(() => setWaited(true), 1_500)
    return () => clearTimeout(id)
  }, [])

  if (error)
    return (
      <PairStep icon="shield" back={false} title={t('This code does not work')} body={error} actions={<Button label={t('Scan a code')} variant="primary" onPress={() => router.replace('/pair/camera')} />} />
    )
  if (waited && !link) return <Redirect href="/pair/camera" />
  return null
}
