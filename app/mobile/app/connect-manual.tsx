// Development only: paste a pairing link (`ladder://pair#…`, printed by remote-host-harness) and continue along the same
// path as the QR (confirm → password → name → connect). Reachable only in development builds.
import { Redirect, useRouter } from 'expo-router'
import { useState } from 'react'
import { ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '@shared/i18n'
import { readPairingLink } from '@/lib/pair-link'
import { usePairFlow } from '@/store/pair-flow'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Button } from '@/ui/Button'
import { KeyboardLift } from '@/ui/KeyboardLift'
import { ScreenHeader } from '@/ui/ScreenHeader'
import { Text } from '@/ui/Text'
import { TextInput } from '@/ui/TextInput'
import { linkErrorText } from '@/ui/auth-text'

export default function ConnectManual() {
  const { c } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const set = usePairFlow((s) => s.set)
  const [link, setLink] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Development only: in production a direct link must not be able to open this screen.
  if (!__DEV__) return <Redirect href="/welcome" />
  const go = () => {
    const result = readPairingLink(link, Date.now(), { allowDirect: true })
    if (!result.ok) return setError(linkErrorText(result.reason))
    set({ payload: result.payload, password: '', confirmed: false, failure: null })
    router.push('/pair/confirm')
  }
  return (
    <KeyboardLift style={{ backgroundColor: c.background }}>
      <ScreenHeader title={t('Connect manually')} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <Text variant="body" tone="muted">
          {t('Development only. Paste the pairing link that remote-host-harness prints. It continues like a scanned code.')}
        </Text>
        <TextInput
          value={link}
          onChangeText={(v) => {
            setLink(v)
            setError(null)
          }}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          placeholder="ladder://pair#…"
          placeholderTextColor={c.textMuted}
          accessibilityLabel={t('Pairing link')}
          style={{ minHeight: 120, borderRadius: RADIUS.lg, backgroundColor: c.surface, color: c.text, paddingHorizontal: 16, paddingTop: 14, fontFamily: 'MonaspaceNeon-Regular', fontSize: 13 }}
        />
        {error ? (
          <Text variant="body" tone="error">
            {error}
          </Text>
        ) : null}
        <Button label={t('Continue')} variant="primary" disabled={link.trim().length === 0} onPress={go} />
      </ScrollView>
    </KeyboardLift>
  )
}
