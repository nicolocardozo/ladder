// Common structure of the pairing steps: icon, title, text, actions at the bottom.
import type { ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Icon, type IconName } from '@/ui/Icon'
import { KeyboardLift } from '@/ui/KeyboardLift'
import { ScreenHeader } from '@/ui/ScreenHeader'
import { Text } from '@/ui/Text'

export function PairStep({ icon, title, body, children, actions, back = true, step }: { icon: IconName; title: string; body: string; children?: ReactNode; actions: ReactNode; back?: boolean; step?: string }) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <KeyboardLift style={{ backgroundColor: c.background }}>
      {back ? <ScreenHeader title={step} /> : <View style={{ height: insets.top }} />}
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24, paddingTop: 24 }} keyboardShouldPersistTaps="handled">
        <View style={{ width: 56, height: 56, borderRadius: RADIUS.xl, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} size={26} color={c.accent} />
        </View>
        <Text variant="display" style={{ marginTop: 20 }} accessibilityRole="header">
          {title}
        </Text>
        <Text variant="bodyL" tone="muted" style={{ marginTop: 10 }}>
          {body}
        </Text>
        {children}
      </ScrollView>
      <View style={{ padding: 16, paddingBottom: Math.max(insets.bottom, 16), gap: 8 }}>{actions}</View>
    </KeyboardLift>
  )
}
