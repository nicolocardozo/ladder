import { CameraView } from 'expo-camera'
import { useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { View } from 'react-native'
import { t } from '@shared/i18n'
import { fingerprint, isValidMacKey, parsePairingUrl } from '@/lib/pairing-url'
import { usePairFlow } from '@/store/pair-flow'
import { useTheme } from '@/theme/theme'
import { Button } from '@/ui/Button'
import { ScreenHeader } from '@/ui/ScreenHeader'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { Group, Row } from '@/ui/List'

/** Scansione del QR e sheet di conferma (nome del Mac, impronta della chiave, relay). Lettura del codice provvisoria fino a LAD-51. */
export default function Scan() {
  const { c } = useTheme()
  const router = useRouter()
  const flow = usePairFlow()
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const handled = useRef(false)
  const onScan = ({ data }: { data: string }) => {
    if (handled.current) return
    const parsed = parsePairingUrl(data)
    if (!parsed || !isValidMacKey(parsed.macKey)) {
      setError(t('This is not a Ladder pairing code.'))
      return
    }
    handled.current = true
    flow.set({ ...parsed, macName: parsed.macName || t('Your Mac') })
    setConfirm(true)
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title={t('Step 2 of 4')} />
      <View style={{ flex: 1, margin: 16, borderRadius: 20, overflow: 'hidden', backgroundColor: c.surface }}>
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />
        <View pointerEvents="none" style={{ ...absoluteCenter, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 220, height: 220, borderRadius: 24, borderWidth: 3, borderColor: c.accent }} />
        </View>
      </View>
      <View style={{ paddingHorizontal: 24, paddingBottom: 24, gap: 8 }}>
        <Text variant="body" tone={error ? 'error' : 'muted'} style={{ textAlign: 'center' }}>
          {error ?? t('Point the camera at the code on your Mac.')}
        </Text>
      </View>
      <Sheet
        visible={confirm}
        onClose={() => {
          setConfirm(false)
          handled.current = false
        }}
        title={t('Pair with this Mac?')}
      >
        <Group>
          <Row label={t('Mac')} value={flow.draft.macName} />
          <Row label={t('Key fingerprint')} value={fingerprint(flow.draft.macKey)} />
          <Row label={t('Relay')} value={t('Direct (development)')} last />
        </Group>
        <View style={{ padding: 16, gap: 8 }}>
          <Text variant="caption" tone="muted">
            {t('Check that the fingerprint matches the one shown on your Mac.')}
          </Text>
          <Button
            label={t('Pair')}
            variant="primary"
            onPress={() => {
              setConfirm(false)
              router.push('/pair/password')
            }}
          />
        </View>
      </Sheet>
    </View>
  )
}

const absoluteCenter = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 }
