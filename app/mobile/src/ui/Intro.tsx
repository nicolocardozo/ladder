// Intro animata: subito dopo lo splash nativo (che è solo uno sfondo, senza immagine) le tre barre del simbolo salgono come gradini,
// nell'accento del tema, poi il velo si dissolve su Home o Welcome. Parte appena font e tema sono pronti, anche se l'avvio non ha
// finito: in quel caso l'onda lenta del simbolo gira finché `ready` non arriva (al massimo MAX_WAIT_MS, poi si apre comunque).
// Il passaggio dallo splash nativo è senza stacco: il velo parte dallo stesso colore dello splash (vedi NATIVE_BG, che deve
// restare uguale a `expo-splash-screen` in app.json) e in 160 ms scivola allo sfondo del tema scelto, se diverso.
import * as SplashScreen from 'expo-splash-screen'
import { useEffect, useRef, useState } from 'react'
import { Appearance, StyleSheet } from 'react-native'
import Animated, { Easing, interpolateColor, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useReduceMotion } from '@/lib/use-reduce-motion'
import { useTheme } from '@/theme/theme'
import { LOGO_ENTER_MS, Logo } from './Logo'

/** Sfondi dello splash nativo (app.json, plugin expo-splash-screen): tema Circuit per lo scuro, Daylight per il chiaro. */
const NATIVE_BG = { dark: '#181424', light: '#FFFFFF' }
const HOLD_MS = 60
const EXIT_MS = 240
const MAX_WAIT_MS = 3500

/** Vero quando l'intro si è chiusa: le schermate che nascono dopo (Welcome) possono far entrare il loro logo da sole. */
export const introState = { done: false }

export function Intro({ ready }: { ready: boolean }) {
  const { c } = useTheme()
  const reduce = useReduceMotion()
  const [shown, setShown] = useState(true)
  const [entered, setEntered] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  // Il colore dello splash nativo, deciso dall'aspetto del telefono all'avvio (prima che l'app lo cambi col tema).
  const [from] = useState(() => (Appearance.getColorScheme() === 'light' ? NATIVE_BG.light : NATIVE_BG.dark))
  const bg = useSharedValue(0)
  const fade = useSharedValue(1)
  const lift = useSharedValue(0)
  const started = useRef(false)

  const onLayout = () => {
    if (started.current) return
    started.current = true
    // Il primo fotogramma del velo è già a schermo: si toglie lo splash nativo (stesso colore, nessuno stacco).
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
  // Il simbolo si ingrandisce appena mentre il velo svanisce (con "Reduce Motion": solo dissolvenza).
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
