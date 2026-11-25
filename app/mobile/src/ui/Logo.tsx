// Il marchio di Ladder: le tre barre del simbolo, nel colore d'accento del tema (DESIGN.md: nella UI il logo prende l'accento),
// da solo o con la parola sotto (colore del testo del tema). Ogni barra è un Svg a sé, sovrapposto agli altri con lo stesso
// riquadro, così si possono animare una alla volta con trasformazioni native (niente prop animate di react-native-svg).
import { useEffect } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated'
import Svg, { Path } from 'react-native-svg'
import { useReduceMotion } from '@/lib/use-reduce-motion'
import { useTheme } from '@/theme/theme'
import { GLYPH_BARS, GLYPH_H, GLYPH_W, STACKED_GLYPH_X, STACKED_H, STACKED_W, STACKED_WORD_Y, WORDMARK_PATH, WORDMARK_SCALE } from './logo-paths'

/** Ritardo tra una barra e la successiva, durata di ciascuna e della parola: l'ingresso dura STEP*2 + BAR = 500 ms. */
const STEP_MS = 110
const BAR_MS = 280
const WORD_DELAY_MS = 330
const WORD_MS = 220
export const LOGO_ENTER_MS = STEP_MS * 2 + BAR_MS
export const LOGO_ENTER_WITH_WORD_MS = WORD_DELAY_MS + WORD_MS
const IDLE_MS = 1800

export interface LogoProps {
  /** Larghezza in punti del simbolo (o dell'intera composizione con la parola). */
  size?: number
  /** `mark` = solo il simbolo, `stacked` = simbolo con la parola sotto. */
  variant?: 'mark' | 'stacked'
  /** Di default l'accento del tema. */
  color?: string
  /** Colore della parola: di default il testo del tema. */
  wordColor?: string
  /** Le barre entrano una dopo l'altra, dal basso, come gradini che si salgono. */
  enter?: boolean
  /** Dopo l'ingresso (o subito), un'onda lenta di luminosità sale lungo le barre. */
  idle?: boolean
  style?: StyleProp<ViewStyle>
}

export function Logo({ size = 96, variant = 'mark', color, wordColor, enter = false, idle = false, style }: LogoProps) {
  const { c } = useTheme()
  const fill = color ?? c.accent
  const reduce = useReduceMotion()
  const stacked = variant === 'stacked'
  const boxW = stacked ? STACKED_W : GLYPH_W
  const boxH = stacked ? STACKED_H : GLYPH_H
  const width = size
  const height = (size * boxH) / boxW
  const glyphX = stacked ? STACKED_GLYPH_X : 0

  // Avanzamento di ogni barra (0 = fuori, 1 = al suo posto), dalla più bassa (indice 2) alla più alta (indice 0).
  const p0 = useSharedValue(enter ? 0 : 1)
  const p1 = useSharedValue(enter ? 0 : 1)
  const p2 = useSharedValue(enter ? 0 : 1)
  const word = useSharedValue(enter ? 0 : 1)
  const wave = useSharedValue(0)
  const bars = [p0, p1, p2]

  useEffect(() => {
    // Finché non si sa se il movimento è ridotto non si parte: pochi ms, e il simbolo resta invisibile.
    if (reduce === null) return
    if (!enter) return
    const easing = Easing.out(Easing.cubic)
    bars.forEach((p, i) => {
      // Con movimento ridotto le barre compaiono insieme, con una semplice dissolvenza.
      const delay = reduce ? 0 : (2 - i) * STEP_MS
      p.value = withDelay(delay, withTiming(1, { duration: reduce ? 200 : BAR_MS, easing }))
    })
    word.value = withDelay(reduce ? 0 : WORD_DELAY_MS, withTiming(1, { duration: reduce ? 200 : WORD_MS, easing }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enter, reduce])

  useEffect(() => {
    if (!idle || reduce !== false) return
    wave.value = 0
    wave.value = withDelay(enter ? LOGO_ENTER_MS : 0, withRepeat(withTiming(1, { duration: IDLE_MS, easing: Easing.linear }), -1, false))
    return () => {
      wave.value = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idle, reduce, enter])

  const rise = reduce ? 0 : height * 0.16
  const barStyles = [0, 1, 2].map((i) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useAnimatedStyle(() => {
      const p = bars[i].value
      // Onda di luminosità: sale dalla barra più bassa alla più alta; la barra "accesa" è piena, le altre scendono a 0.55.
      const phase = ((2 - i) / 3) % 1
      const w = idle && reduce === false ? 0.775 + 0.225 * Math.cos(2 * Math.PI * (wave.value - phase)) : 1
      return { opacity: p * w, transform: [{ translateY: (1 - p) * rise }] }
    })
  )
  const wordStyle = useAnimatedStyle(() => ({ opacity: word.value }))
  const hidden = enter && reduce === null


  return (
    <View
      style={[{ width, height, opacity: hidden ? 0 : 1 }, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Ladder"
      accessibilityIgnoresInvertColors
    >
      {GLYPH_BARS.map((d, i) => (
        <Animated.View key={i} style={[{ position: 'absolute', left: 0, top: 0 }, barStyles[i]]}>
          <Svg width={width} height={height} viewBox={`0 0 ${boxW} ${boxH}`}>
            <Path d={d} fill={fill} transform={`translate(${glyphX} 0)`} />
          </Svg>
        </Animated.View>
      ))}
      {stacked ? (
        <Animated.View style={[{ position: 'absolute', left: 0, top: 0 }, wordStyle]}>
          <Svg width={width} height={height} viewBox={`0 0 ${boxW} ${boxH}`}>
            <Path d={WORDMARK_PATH} fill={wordColor ?? c.text} fillRule="evenodd" transform={`translate(0 ${STACKED_WORD_Y}) scale(${WORDMARK_SCALE})`} />
          </Svg>
        </Animated.View>
      ) : null}
    </View>
  )
}
