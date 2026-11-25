import { useRouter } from 'expo-router'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '@shared/i18n'
import { startDemo } from '@/host/controller'
import { useTheme } from '@/theme/theme'
import { Button } from '@/ui/Button'
import { Icon, type IconName } from '@/ui/Icon'
import { Logo } from '@/ui/Logo'
import { useDev } from '@/store/dev'
import { Text } from '@/ui/Text'

const CHIPS: { icon: IconName; label: () => string }[] = [
  { icon: 'lock', label: () => t('End-to-end encrypted') },
  { icon: 'user-off', label: () => t('No account') },
  { icon: 'sparkle', label: () => t('Your own agents & plans') }
]

/** Prima schermata: abbinare il Mac o provare la demo (anche in produzione: è quella per App Review). */
export default function Welcome() {
  const { c } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const caption = __DEV__ && useDev((d) => d.welcome) === 'caption'
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingTop: insets.top + 24, paddingBottom: 24 }}>
        {/* Colonna centrata: simbolo fermo (nessuna animazione: l'intro all'avvio ha già dato il movimento), titolo, testo e i tre punti. */}
        <View style={{ alignItems: 'center' }}>
          <Logo variant="mark" size={96} />
        </View>
        <Text variant="display" style={{ marginTop: 28, textAlign: 'center' }} accessibilityRole="header">
          {t('Ladder in your pocket')}
        </Text>
        <Text variant="bodyL" tone="muted" style={{ marginTop: 12, textAlign: 'center' }}>
          {t('See which sessions need you, approve a request, read the reply as it arrives. Your agents keep running on your Mac.')}
        </Text>
        {/* Tre capsule in una riga che va a capo, centrate (variante A); in sviluppo il driver può mostrare al loro posto una riga sola (B). */}
        {caption ? (
          <Text variant="caption" tone="muted" style={{ marginTop: 20, textAlign: 'center' }}>
            {t('End-to-end encrypted · No account')}
          </Text>
        ) : (
          <View style={{ marginTop: 20, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
            {CHIPS.map((chip) => (
              <View key={chip.icon} accessible accessibilityLabel={chip.label()} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: c.surface }}>
                <Icon name={chip.icon} size={15} color={c.accent} />
                <Text variant="caption" tone="muted">
                  {chip.label()}
                </Text>
              </View>
            ))}
          </View>
        )}
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
