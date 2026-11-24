// Abbinamento manuale di sviluppo (fino a LAD-51): indirizzo WebSocket del server locale dell'host, chiave pubblica del Mac
// (remote-identity.json, campo publicKey) e nome del dispositivo, salvati nel portachiavi. Raggiungibile solo nelle build di sviluppo.
import { Redirect, useRouter } from 'expo-router'
import { useState } from 'react'
import { Platform, ScrollView, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '@shared/i18n'
import { startRemote } from '@/host/controller'
import { isValidPairing } from '@/lib/pairing-url'
import { defaultDeviceName, savePairing } from '@/store/pairing'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Button } from '@/ui/Button'
import { ScreenHeader } from '@/ui/ScreenHeader'
import { Text } from '@/ui/Text'

export default function ConnectManual() {
  const { c } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [url, setUrl] = useState('ws://127.0.0.1:7777')
  const [key, setKey] = useState('')
  const [device, setDevice] = useState(defaultDeviceName())
  const valid = isValidPairing({ wsUrl: url, macKey: key })
  const field = { minHeight: 52, borderRadius: RADIUS.lg, backgroundColor: c.surface, color: c.text, paddingHorizontal: 16, fontSize: 15 }
  const connect = async () => {
    if (!valid) return
    const pairing = { wsUrl: url.trim(), macKey: key.trim(), device: device.trim() || defaultDeviceName() }
    await savePairing(pairing)
    void startRemote(pairing)
    router.replace('/')
  }
  // Solo sviluppo: in produzione un link diretto non deve poter aprire questa schermata.
  if (!__DEV__) return <Redirect href="/welcome" />
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title={t('Connect manually')} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <Text variant="body" tone="muted">
          {t('Development only. Start Ladder with LADDER_REMOTE_PORT set, then enter the address and the Mac public key from remote-identity.json.')}
        </Text>
        <Text variant="label" tone="muted">
          {t('WebSocket address')}
        </Text>
        <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={field} placeholderTextColor={c.textMuted} accessibilityLabel={t('WebSocket address')} />
        {Platform.OS === 'android' ? (
          <Text variant="caption" tone="muted">
            {t('On the Android emulator 127.0.0.1 is mapped to 10.0.2.2 automatically.')}
          </Text>
        ) : null}
        <Text variant="label" tone="muted">
          {t('Mac public key (base64url)')}
        </Text>
        <TextInput value={key} onChangeText={setKey} autoCapitalize="none" autoCorrect={false} multiline style={{ ...field, fontFamily: 'MonaspaceNeon-Regular', fontSize: 13, paddingTop: 14 }} placeholderTextColor={c.textMuted} accessibilityLabel={t('Mac public key')} />
        <Text variant="label" tone="muted">
          {t('Device name')}
        </Text>
        <TextInput value={device} onChangeText={setDevice} autoCorrect={false} style={field} placeholderTextColor={c.textMuted} accessibilityLabel={t('Device name')} />
        <Button label={t('Connect')} variant="primary" disabled={!valid} onPress={connect} style={{ marginTop: 8 }} />
      </ScrollView>
    </View>
  )
}
