import { Redirect } from 'expo-router'
import { useWindowDimensions, View } from 'react-native'
import { t } from '@shared/i18n'
import { HomeContent } from '@/features/home/HomeContent'
import { useApp } from '@/store/app'
import { Text } from '@/ui/Text'
import { WIDE } from '@/ui/Sheet'

export default function Index() {
  const mode = useApp((s) => s.mode)
  const { width } = useWindowDimensions()
  if (mode === 'none') return <Redirect href="/welcome" />
  // Su schermi larghi la Home sta già a sinistra: qui resta un segnaposto.
  if (width >= WIDE)
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <Text variant="title" tone="muted">
          {t('Pick a session')}
        </Text>
      </View>
    )
  return <HomeContent />
}
