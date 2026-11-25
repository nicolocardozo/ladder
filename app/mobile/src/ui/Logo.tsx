// The Ladder mark: the symbol's three bars, in the theme accent color (DESIGN.md: in the UI the logo takes the accent),
// alone or with the word below (theme text color). Each bar is its own Svg, stacked on the others with the same
// box, so they can be animated one at a time with native transforms (no animated props of react-native-svg).
import { useEffect } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated'
import Svg, { Path } from 'react-native-svg'
import { useReduceMotion } from '@/lib/use-reduce-motion'
import { useTheme } from '@/theme/theme'
import { GLYPH_BARS, GLYPH_H, GLYPH_W, STACKED_GLYPH_X, STACKED_H, STACKED_W, STACKED_WORD_Y, WORDMARK_PATH, WORDMARK_SCALE } from './logo-paths'

/** Delay between one bar and the next, duration of each and of the word: the entrance lasts STEP*2 + BAR = 500 ms. */
const STEP_MS = 110
const BAR_MS = 280
const WORD_DELAY_MS = 330
const WORD_MS = 220
export const LOGO_ENTER_MS = STEP_MS * 2 + BAR_MS
export const LOGO_ENTER_WITH_WORD_MS = WORD_DELAY_MS + WORD_MS
const IDLE_MS = 1800

export interface LogoProps {
  /** Width in points of the symbol (or of the whole composition with the word). */
  size?: number
  /** `mark` = symbol only, `stacked` = symbol with the word below. */
  variant?: 'mark' | 'stacked'
  /** Defaults to the theme accent. */
  color?: string
  /** Word color: defaults to the theme text. */
  wordColor?: string
  /** The bars enter one after another, from the bottom, like steps being climbed. */
  enter?: boolean
  /** After the entrance (or immediately), a slow wave of brightness rises along the bars. */
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

  // Progress of each bar (0 = out, 1 = in place), from the lowest (index 2) to the highest (index 0).
  const p0 = useSharedValue(enter ? 0 : 1)
  const p1 = useSharedValue(enter ? 0 : 1)
  const p2 = useSharedValue(enter ? 0 : 1)
  const word = useSharedValue(enter ? 0 : 1)
  const wave = useSharedValue(0)
  const bars = [p0, p1, p2]

  useEffect(() => {
    // Until we know whether motion is reduced we don't start: a few ms, and the symbol stays invisible.
    if (reduce === null) return
    if (!enter) return
    const easing = Easing.out(Easing.cubic)
    bars.forEach((p, i) => {
      // With reduced motion the bars appear together, with a simple fade.
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
      // Brightness wave: rises from the lowest bar to the highest; the "lit" bar is full, the others drop to 0.55.
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
