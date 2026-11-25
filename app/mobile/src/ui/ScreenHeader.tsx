import { useRouter } from 'expo-router'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '@shared/i18n'
import { useTheme } from '@/theme/theme'
import { IconButton } from './Button'
import { Text } from './Text'

/** Screen header: back, title, actions. The native back gesture still works. */
export function ScreenHeader({ title, subtitle, right, children }: { title?: string; subtitle?: string; right?: ReactNode; children?: ReactNode }) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { c } = useTheme()
  return (
    <View style={{ paddingTop: insets.top, backgroundColor: c.background }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingLeft: 4, paddingRight: 8, gap: 2 }}>
        <IconButton icon="chevron-left" label={t('Back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        {children ?? (
          <View style={{ flex: 1 }}>
            <Text variant="title" numberOfLines={1} accessibilityRole="header">
              {title}
            </Text>
            {subtitle ? (
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        )}
        {right}
      </View>
    </View>
  )
}
