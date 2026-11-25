// Il Mac ha tolto questo telefono (revoca, "rigenera chiave") o la sua chiave è cambiata: si spiega e si offre di abbinare di nuovo.
import { Redirect, useRouter } from 'expo-router'
import { t } from '@shared/i18n'
import { PairStep } from '@/features/pair/PairStep'
import { disconnect } from '@/host/controller'
import { useApp } from '@/store/app'
import { Button } from '@/ui/Button'

export default function Disconnected() {
  const router = useRouter()
  const conn = useApp((s) => s.conn)
  const mac = useApp((s) => s.macName)
  const keyChanged = conn.kind === 'key-changed'
  // Solo per i due stati finali: da un link diretto o dopo un nuovo abbinamento non si resta qui.
  if (conn.kind !== 'revoked' && !keyChanged) return <Redirect href="/" />
  const again = async () => {
    // Si dimentica tutto (abbinamento e chiave del dispositivo) e si riparte dalla fotocamera, con la schermata di benvenuto sotto.
    await disconnect()
    router.dismissAll()
    router.replace('/welcome')
    router.push('/pair/camera')
  }
  return (
    <PairStep
      icon="shield"
      back={false}
      title={keyChanged ? t('This Mac’s key changed') : t('Disconnected from your Mac')}
      body={
        keyChanged
          ? t('{mac} has a new security key, so this phone cannot trust it anymore. Pair again to keep using it.', { mac: mac ?? t('Your Mac') })
          : t('{mac} removed this phone. Pair again if you want to use it with that Mac.', { mac: mac ?? t('Your Mac') })
      }
      actions={<Button label={t('Pair again')} variant="primary" onPress={() => void again()} />}
    />
  )
}
