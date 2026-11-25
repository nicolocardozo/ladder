// Header of the tab root screens (Sessions, Requests, Settings): the title sits right below the status bar, without the
// empty row of the native navigation bar, with an action on the right on the same row. The list content scrolls underneath: the background
// is solid down to the title and fades below it, so nothing ever passes over the title text.
import { type ReactNode } from 'react'
import { Platform, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { useTheme } from '@/theme/theme'
import { Text } from './Text'

/** Height of the title row (below the status bar) and of the fade below it. */
export const TAB_HEADER_ROW = 52
const FADE = 12

/**
 * Space to leave at the top of the list content below the header. On iOS the list (`contentInsetAdjustmentBehavior="automatic"`)
 * already adds the status bar height; on Android it does not.
 */
export function useTabHeaderPad(): number {
  const insets = useSafeAreaInsets()
  // Plus the fade: at rest the first item sits below it, whole.
  return TAB_HEADER_ROW + FADE + (Platform.OS === 'ios' ? 0 : insets.top)
}

export function TabHeader({ title, right }: { title: string; right?: ReactNode }) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const solid = insets.top + TAB_HEADER_ROW
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 }}>
      <View pointerEvents="box-none" style={{ height: solid, paddingTop: insets.top, backgroundColor: c.background, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, gap: 12 }}>
        <Text variant="display" numberOfLines={1} accessibilityRole="header" style={{ flex: 1 }}>
          {title}
        </Text>
        {right}
      </View>
      <Svg pointerEvents="none" width="100%" height={FADE}>
        <Defs>
          <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={c.background} stopOpacity={1} />
            <Stop offset="1" stopColor={c.background} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={FADE} fill="url(#fade)" />
      </Svg>
    </View>
  )
}
