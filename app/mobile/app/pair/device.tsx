import { Redirect, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { TextInput } from 'react-native'
import { t } from '@shared/i18n'
import { PairStep } from '@/features/pair/PairStep'
import { startRemote } from '@/host/controller'
import { usePairFlow } from '@/store/pair-flow'
import { isValidPairing } from '@/lib/pairing-url'
import { defaultDeviceName, savePairing } from '@/store/pairing'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Button } from '@/ui/Button'

/** Nome del dispositivo, poi prima connessione. */
export default function Device() {
  const { c } = useTheme()
  const router = useRouter()
  const { draft, set } = usePairFlow()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!draft.device) set({ device: defaultDeviceName() })
  }, [draft.device, set])
  // Si arriva qui solo dopo aver letto un codice valido: da un link diretto, con la bozza vuota, si riparte dalla fotocamera.
  const valid = isValidPairing(draft)
  const connect = async () => {
    if (!valid) return
    setBusy(true)
    const pairing = { wsUrl: draft.wsUrl, macKey: draft.macKey.trim(), device: draft.device.trim() || defaultDeviceName(), macName: draft.macName || undefined }
    await savePairing(pairing)
    void startRemote(pairing)
    router.replace('/pair/notifications')
  }
  if (!valid) return <Redirect href="/pair/camera" />
  return (
    <PairStep
      icon="laptop"
      step={t('Step 4 of 4')}
      title={t('Name this phone')}
      body={t('Your Mac shows this name in its list of paired devices, so you can recognise the phone and remove it later.')}
      actions={<Button label={t('Connect')} variant="primary" disabled={busy || !draft.device.trim()} onPress={connect} />}
    >
      <TextInput
        value={draft.device}
        onChangeText={(device) => set({ device })}
        autoCorrect={false}
        placeholder={t('Device name')}
        placeholderTextColor={c.textMuted}
        accessibilityLabel={t('Device name')}
        style={{ marginTop: 24, minHeight: 52, borderRadius: RADIUS.lg, backgroundColor: c.surface, color: c.text, paddingHorizontal: 16, fontSize: 17 }}
      />
    </PairStep>
  )
}
