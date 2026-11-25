// Animated intro: right after the native splash (which is only a background, no image) the symbol's three bars rise like steps,
// in the theme accent, then the veil dissolves into Home or Welcome. It starts as soon as fonts and theme are ready, even if startup has not
// finished: in that case the symbol's slow wave runs until `ready` arrives (at most MAX_WAIT_MS, then it opens anyway).
// The handoff from the native splash is seamless: the veil starts from the same color as the splash (see NATIVE_BG, which must
// stay equal to `expo-splash-screen` in app.json) and in 160 ms slides to the chosen theme's background, if different.
import * as SplashScreen from 'expo-splash-screen'
import { useEffect, useRef, useState } from 'react'
import { Appearance, StyleSheet } from 'react-native'
import Animated, { Easing, interpolateColor, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useReduceMotion } from '@/lib/use-reduce-motion'
import { useTheme } from '@/theme/theme'
import { LOGO_ENTER_MS, Logo } from './Logo'

/** Native splash backgrounds (app.json, expo-splash-screen plugin): Circuit theme for dark, Daylight for light. */
const NATIVE_BG = { dark: '#181424', light: '#FFFFFF' }
const HOLD_MS = 60
const EXIT_MS = 240
const MAX_WAIT_MS = 3500

/** True when the intro has closed: screens created afterwards (Welcome) can animate their logo in on their own. */
export const introState = { done: false }

export function Intro({ ready }: { ready: boolean }) {
  const { c } = useTheme()
  const reduce = useReduceMotion()
  const [shown, setShown] = useState(true)
  const [entered, setEntered] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  // The native splash color, decided by the phone's appearance at launch (before the app changes it with the theme).
  const [from] = useState(() => (Appearance.getColorScheme() === 'light' ? NATIVE_BG.light : NATIVE_BG.dark))
  const bg = useSharedValue(0)
  const fade = useSharedValue(1)
  const lift = useSharedValue(0)
  const started = useRef(false)

  const onLayout = () => {
    if (started.current) return
    started.current = true
    // The veil's first frame is already on screen: remove the native splash (same color, no seam).
    SplashScreen.setOptions({ fade: false })
    void SplashScreen.hideAsync()
    if (from !== c.background) bg.value = withTiming(1, { duration: 160, easing: Easing.out(Easing.quad) })
  }

  useEffect(() => {
    const enter = setTimeout(() => setEntered(true), LOGO_ENTER_MS + HOLD_MS)
    const max = setTimeout(() => setTimedOut(true), MAX_WAIT_MS)
    return () => {
      clearTimeout(enter)
      clearTimeout(max)
    }
  }, [])

  const leaving = reduce !== null && entered && (ready || timedOut)
  useEffect(() => {
    if (!leaving) return
    lift.value = withTiming(1, { duration: EXIT_MS, easing: Easing.out(Easing.cubic) })
    fade.value = withTiming(0, { duration: EXIT_MS, easing: Easing.in(Easing.quad) }, (done) => {
      if (done) {
        introState.done = true
        runOnJS(setShown)(false)
      }
    })
  }, [leaving, fade, lift])

  const veil = useAnimatedStyle(() => ({ opacity: fade.value, backgroundColor: interpolateColor(bg.value, [0, 1], [from, c.background]) }))
  // The symbol grows slightly while the veil fades (with "Reduce Motion": fade only).
  const mark = useAnimatedStyle(() => ({ transform: [{ scale: reduce ? 1 : 1 + lift.value * 0.12 }] }))
  if (!shown) return null
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }, veil]}
      onLayout={onLayout}
      pointerEvents={leaving ? 'none' : 'auto'}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={mark}>
        <Logo size={120} enter idle />
      </Animated.View>
    </Animated.View>
  )
}
