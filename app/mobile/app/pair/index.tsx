// Entry from a link: `ladder://pair#…` opened from outside (the phone camera, a message) lands here. The link is read and we
// go to the confirmation, without going through the scan. The link is never logged or saved.
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

  // The link may have already arrived (parked by +native-intent) or arrive later (useURL).
  const [parked] = useState(() => takePendingPairLink())
  // `useURL` also returns the link the app was opened with: if it has already been used (or discarded) it isn't read again.
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

  // If the link doesn't arrive (the route was opened by hand), start over from the camera.
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
