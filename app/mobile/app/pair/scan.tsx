import { CameraView } from 'expo-camera'
import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { View } from 'react-native'
import { t } from '@shared/i18n'
import { readPairingLink } from '@/lib/pair-link'
import { usePairFlow } from '@/store/pair-flow'
import { useTheme } from '@/theme/theme'
import { ScreenHeader } from '@/ui/ScreenHeader'
import { Text } from '@/ui/Text'
import { linkErrorText } from '@/ui/auth-text'

/** Scansione del QR: legge `ladder://pair#…` e porta alla conferma. Il contenuto del codice non si logga mai. */
export default function Scan() {
  const { c } = useTheme()
  const router = useRouter()
  const set = usePairFlow((s) => s.set)
  const [error, setError] = useState<string | null>(null)
  // La fotocamera legge solo mentre la schermata è davanti: con la conferma (o altro) sopra non si scansiona.
  const [focused, setFocused] = useState(true)
  const lastError = useRef(0)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const onScan = ({ data }: { data: string }) => {
    if (!focused) return
    const result = readPairingLink(data, Date.now(), { allowDirect: __DEV__ })
    if (result.ok) {
      set({ payload: result.payload, password: '', confirmed: false, failure: null })
      setFocused(false)
      router.push('/pair/confirm')
      return
    }
    // Un codice sbagliato non si rilegge cento volte al secondo: il messaggio resta e si riprova dopo un attimo.
    if (Date.now() - lastError.current < 1_500) return
    lastError.current = Date.now()
    setError(linkErrorText(result.reason))
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title={t('Step 2 of 4')} />
      <View style={{ flex: 1, margin: 16, borderRadius: 20, overflow: 'hidden', backgroundColor: c.surface }}>
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={focused ? onScan : undefined} />
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 220, height: 220, borderRadius: 24, borderWidth: 3, borderColor: error ? c.error : c.accent }} />
        </View>
      </View>
      <View style={{ paddingHorizontal: 24, paddingBottom: 24, gap: 8 }}>
        <Text variant="body" tone={error ? 'error' : 'muted'} style={{ textAlign: 'center' }} accessibilityLiveRegion="polite">
          {error ?? t('Point the camera at the code on your Mac.')}
        </Text>
      </View>
    </View>
  )
}
