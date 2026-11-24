import { useRouter } from 'expo-router'
import { t } from '@shared/i18n'
import { PairStep } from '@/features/pair/PairStep'
import { resetTo } from '@/lib/nav'
import { usePairFlow } from '@/store/pair-flow'
import { Button } from '@/ui/Button'

/** Spiegazione delle notifiche. Il permesso e il push arrivano con LAD-53: per ora si prosegue. */
export default function Notifications() {
  const router = useRouter()
  const reset = usePairFlow((s) => s.reset)
  const done = () => {
    reset()
    resetTo(router, "/")
  }
  return (
    <PairStep
      icon="bell"
      back={false}
      title={t('Know when your agents need you')}
      body={t('Ladder can notify you when a session is waiting for you or has finished. Notifications never contain your messages or code.')}
      actions={
        <>
          <Button label={t('Turn on notifications')} variant="primary" onPress={done} />
          <Button label={t('Not now')} variant="quiet" onPress={done} />
        </>
      }
    />
  )
}
