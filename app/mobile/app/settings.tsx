import { useRouter } from 'expo-router'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Constants from 'expo-constants'
import { t, LOCALES } from '@shared/i18n'
import { disconnect } from '@/host/controller'
import { resetTo } from '@/lib/nav'
import { useApp } from '@/store/app'
import { pushStatusLabel } from '@/host/push'
import { usePrefs } from '@/store/prefs'
import { usePush } from '@/store/push'
import { themeById } from '@/theme/theme'
import { useTheme } from '@/theme/theme'
import { Group, Row } from '@/ui/List'
import { ScreenHeader } from '@/ui/ScreenHeader'

export default function Settings() {
  const { c, info } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const prefs = usePrefs((s) => s.theme)
  const language = usePrefs((s) => s.language)
  const mode = useApp((s) => s.mode)
  const macName = useApp((s) => s.macName)
  const permission = usePush((s) => s.permission)
  const tokenFailed = usePush((s) => s.tokenFailed)
  const themeValue = prefs.matchSystem ? t('Match system') : prefs.choice === 'mac' ? t('Same as Mac') : themeById(prefs.choice).name
  const languageValue = language === 'system' ? t('System') : (LOCALES.find((l) => l.id === language)?.name ?? '')
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title={t('Settings')} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        <Group>
          <Row label={t('Mac and connection')} value={macName ?? ''} onPress={() => router.push('/mac')} last />
        </Group>
        {mode === 'remote' ? (
          <Group>
            <Row label={t('Notifications')} value={pushStatusLabel(permission, tokenFailed)} onPress={() => router.push('/notifications')} last />
          </Group>
        ) : null}
        <Group title={t('Appearance')}>
          <Row label={t('Theme')} value={themeValue} detail={prefs.matchSystem || prefs.choice !== 'mac' ? undefined : info.name} onPress={() => router.push('/theme')} />
          <Row label={t('Language')} value={languageValue} onPress={() => router.push('/language')} last />
        </Group>
        <Group title={t('About')}>
          <Row label={t('Version')} value={Constants.expoConfig?.version ?? ''} last />
        </Group>
        {mode === 'demo' ? (
          <Group footer={t('You are looking at sample data. Nothing is connected to a real Mac.')}>
            <Row label={t('Exit demo')} destructive onPress={() => void disconnect().then(() => resetTo(router, '/welcome'))} last />
          </Group>
        ) : null}
      </ScrollView>
    </View>
  )
}
