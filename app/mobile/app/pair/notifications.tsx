import { useRouter } from 'expo-router'
import { useState } from 'react'
import { t } from '@shared/i18n'
import { PairStep } from '@/features/pair/PairStep'
import { requestPermission } from '@/host/push'
import { resetTo } from '@/lib/nav'
import { usePairFlow } from '@/store/pair-flow'
import { Button } from '@/ui/Button'

/**
 * Last pairing step: explains the notifications (generic, the details stay in the encrypted channel) and then asks for the system
 * permission. "Not now" skips: they can be turned on later from Settings → Notifications. Either way we go to the Home.
 */
export default function Notifications() {
  const router = useRouter()
  const reset = usePairFlow((s) => s.reset)
  const [busy, setBusy] = useState(false)
  const done = () => {
    reset()
    resetTo(router, '/')
  }
  const turnOn = async () => {
    if (busy) return
    setBusy(true)
    try {
      await requestPermission()
    } finally {
      done()
    }
  }
  return (
    <PairStep
      icon="bell"
      back={false}
      title={t('Know when your agents need you')}
      body={t('Ladder can notify you when a session needs you or has finished, while you are away from your Mac. Notifications only say that something needs you: your messages and code stay in the encrypted channel with your Mac.')}
      actions={
        <>
          <Button label={t('Turn on notifications')} variant="primary" onPress={() => void turnOn()} disabled={busy} />
          <Button label={t('Not now')} variant="quiet" onPress={done} disabled={busy} />
        </>
      }
    />
  )
}
