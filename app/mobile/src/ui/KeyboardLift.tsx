// Lifts the screen content above the keyboard: the bottom (composer, Continue button) follows the keyboard, animated with it.
// Used in full screens (not in native sheets, which UIKit lifts by itself). `height` from react-native-keyboard-controller is negative.
import type { ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'

export function KeyboardLift({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const { height } = useReanimatedKeyboardAnimation()
  const lift = useAnimatedStyle(() => ({ paddingBottom: -height.value }))
  return <Animated.View style={[{ flex: 1 }, style, lift]}>{children}</Animated.View>
}
