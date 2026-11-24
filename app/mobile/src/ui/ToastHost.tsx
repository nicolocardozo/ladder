import { View } from 'react-native'
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Text } from './Text'
import { useToast } from './toast'

/** Avviso breve in basso: errori dell'host ("This project allows at most edit.") e conferme. */
export function ToastHost() {
  const { message, tone } = useToast()
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  if (!message) return null
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 88, alignItems: 'center' }}>
      <Animated.View entering={FadeInDown.duration(160)} exiting={FadeOutDown.duration(140)} style={{ backgroundColor: c.surface, borderColor: tone === 'error' ? c.error : c.border, borderWidth: 1, borderRadius: RADIUS.lg, paddingHorizontal: 14, paddingVertical: 10, maxWidth: 480 }}>
        <Text variant="body" tone={tone === 'error' ? 'error' : 'default'} accessibilityLiveRegion="polite">
          {message}
        </Text>
      </Animated.View>
    </View>
  )
}
