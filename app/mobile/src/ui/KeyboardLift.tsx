// Alza il contenuto della schermata sopra la tastiera: il fondo (composer, pulsante Continua) segue la tastiera, animato con lei.
// Nelle schermate vere e proprie (non negli sheet nativi, che UIKit alza da sé). `height` di react-native-keyboard-controller è negativo.
import type { ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'

export function KeyboardLift({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const { height } = useReanimatedKeyboardAnimation()
  const lift = useAnimatedStyle(() => ({ paddingBottom: -height.value }))
  return <Animated.View style={[{ flex: 1 }, style, lift]}>{children}</Animated.View>
}
