import { useRouter } from 'expo-router'
import { useMemo } from 'react'
import { ScrollView } from 'react-native'
import { Stack } from 'expo-router'
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
import { useNow } from '@/lib/use-now'
import { buildUsageAccounts, usageAlert, worstText, worstWindow } from '@/lib/usage'
import { AlertGlyph } from '@/features/usage/UsageBits'
import { Group, Row } from '@/ui/List'
import { TabHeader, useTabHeaderPad } from '@/ui/TabHeader'

export default function Settings() {
  const { c, info } = useTheme()
  const headerPad = useTabHeaderPad()
  const router = useRouter()
  const prefs = usePrefs((s) => s.theme)
  const language = usePrefs((s) => s.language)
  const mode = useApp((s) => s.mode)
  const macName = useApp((s) => s.macName)
  const permission = usePush((s) => s.permission)
  const tokenFailed = usePush((s) => s.tokenFailed)
  // Limits row: the worst window among the subscriptions, with the warning sign if it is close to the limit.
  const agents = useApp((s) => s.agents)
  const profiles = useApp((s) => s.profiles)
  const now = useNow(60_000)
  const worst = useMemo(() => worstWindow(buildUsageAccounts(agents, profiles), now), [agents, profiles, now])
  const worstAlert = worst ? usageAlert([worst.usage]) : null
  const themeValue = prefs.matchSystem ? t('Match system') : prefs.choice === 'mac' ? t('Same as Mac') : themeById(prefs.choice).name
  const languageValue = language === 'system' ? t('System') : (LOCALES.find((l) => l.id === language)?.name ?? '')
  return (
    <>
    <Stack.Screen options={{ headerShown: false }} />
    <ScrollView style={{ backgroundColor: c.background }} contentInsetAdjustmentBehavior="automatic" scrollIndicatorInsets={{ top: headerPad }} contentContainerStyle={{ paddingTop: headerPad, paddingBottom: 32 }}>
        <Group>
          <Row label={t('Mac and connection')} value={macName ?? ''} onPress={() => router.push('/mac')} last />
        </Group>
        <Group>
          <Row
            label={t('Plan limits')}
            value={worst ? worstText(worst) : ''}
            right={worstAlert ? <AlertGlyph limited={worstAlert.limited} size={18} /> : undefined}
            onPress={() => router.push('/limits')}
            last
          />
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
    <TabHeader title={t('Settings')} />
    </>
  )
}
