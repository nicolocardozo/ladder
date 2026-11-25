import { useRouter } from 'expo-router'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '@shared/i18n'
import { startDemo } from '@/host/controller'
import { useTheme } from '@/theme/theme'
import { Button } from '@/ui/Button'
import { introState } from '@/ui/Intro'
import { Logo } from '@/ui/Logo'
import { Text } from '@/ui/Text'

/** Prima schermata: abbinare il Mac o provare la demo (anche in produzione: è quella per App Review). */
export default function Welcome() {
  const { c } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingTop: insets.top + 24, paddingBottom: 24 }}>
        {/* Il logo col suo accento: sale a gradini solo se l'intro è già chiusa (altrimenti ha appena fatto lo stesso), poi un'onda lenta. */}
        {/* Solo il simbolo: il nome compare già nel titolo qui sotto. */}
        <Logo variant="mark" size={96} enter={introState.done} idle />
        <Text variant="display" style={{ marginTop: 28 }} accessibilityRole="header">
          {t('Ladder in your pocket')}
        </Text>
        <Text variant="bodyL" tone="muted" style={{ marginTop: 12 }}>
          {t('See who is waiting for you, approve a request, read the reply as it arrives. Your agents keep running on your Mac.')}
        </Text>
        <View style={{ marginTop: 20, gap: 8 }}>
          {[t('End-to-end encrypted between your phone and your Mac'), t('Uses the agents and subscriptions you already have'), t('No account to create')].map((line) => (
            <View key={line} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent, marginTop: 9 }} />
              <Text variant="body" style={{ flex: 1 }}>
                {line}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
      <View style={{ padding: 16, paddingBottom: Math.max(insets.bottom, 16), gap: 8 }}>
        <Button label={t('Pair with your Mac')} variant="primary" onPress={() => router.push('/pair/camera')} />
        <Button
          label={t('Try demo')}
          onPress={() => {
            startDemo()
            router.replace('/')
          }}
        />
        {__DEV__ ? <Button label={t('Connect manually (development)')} variant="quiet" onPress={() => router.push('/connect-manual')} /> : null}
      </View>
    </View>
  )
}
