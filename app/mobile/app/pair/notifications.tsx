import { useRouter } from 'expo-router'
import { useState } from 'react'
import { t } from '@shared/i18n'
import { PairStep } from '@/features/pair/PairStep'
import { requestPermission } from '@/host/push'
import { resetTo } from '@/lib/nav'
import { usePairFlow } from '@/store/pair-flow'
import { Button } from '@/ui/Button'

/**
 * Ultimo passo dell'abbinamento: spiega le notifiche (generiche, i dettagli restano nel canale cifrato) e poi chiede il permesso
 * di sistema. "Non ora" salta: si può attivarle dopo da Impostazioni → Notifiche. In ogni caso si va alla Home.
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
      body={t('Ladder can notify you when a session is waiting for you or has finished, while you are away from your Mac. Notifications only say that something needs you: your messages and code stay in the encrypted channel with your Mac.')}
      actions={
        <>
          <Button label={t('Turn on notifications')} variant="primary" onPress={() => void turnOn()} disabled={busy} />
          <Button label={t('Not now')} variant="quiet" onPress={done} disabled={busy} />
        </>
      }
    />
  )
}
