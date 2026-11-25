// Session state: shape + color, never color alone. Running = spinning ring, waiting for you = triangle (amber),
// error = square with a cross (rose), to read = dot, queued = three lines. The rest of the color is reserved for these meanings.
import { useEffect } from 'react'
import { View } from 'react-native'
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import Svg, { Circle, Path, Rect } from 'react-native-svg'
import type { SessionState } from '@/lib/session-state'
import { useTheme } from '@/theme/theme'

export function StateGlyph({ state, size = 16 }: { state: SessionState; size?: number }) {
  const { c } = useTheme()
  const reduce = useReducedMotion()
  const spin = useSharedValue(0)
  useEffect(() => {
    if (state === 'running' && !reduce) spin.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1)
    return () => cancelAnimation(spin)
  }, [state, reduce, spin])
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }] }))
  const box = { width: size, height: size, alignItems: 'center' as const, justifyContent: 'center' as const }
  switch (state) {
    case 'running': {
      const r = size / 2 - 1.75
      const circ = 2 * Math.PI * r
      return (
        <Animated.View style={[box, style]}>
          <Svg width={size} height={size}>
            <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.running} strokeOpacity={0.3} strokeWidth={2} fill="none" />
            <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.running} strokeWidth={2} fill="none" strokeLinecap="round" strokeDasharray={`${circ * 0.28} ${circ}`} />
          </Svg>
        </Animated.View>
      )
    }
    case 'waiting':
      return (
        <View style={box}>
          <Svg width={size} height={size} viewBox="0 0 16 16">
            <Path d="M8 1.8l6.6 11.6H1.4L8 1.8z" fill={c.waiting} stroke={c.waiting} strokeWidth={1.4} strokeLinejoin="round" />
            <Path d="M8 6.3v3.2" stroke={c.background} strokeWidth={1.6} strokeLinecap="round" />
            <Circle cx="8" cy="11.4" r="0.95" fill={c.background} />
          </Svg>
        </View>
      )
    case 'error':
      return (
        <View style={box}>
          <Svg width={size} height={size} viewBox="0 0 16 16">
            <Rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill={c.error} />
            <Path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke={c.background} strokeWidth={1.7} strokeLinecap="round" />
          </Svg>
        </View>
      )
    case 'unread':
      return (
        <View style={box}>
          <View style={{ width: size * 0.5, height: size * 0.5, borderRadius: size, backgroundColor: c.unread }} />
        </View>
      )
    case 'queued':
      return (
        <View style={box}>
          <Svg width={size} height={size} viewBox="0 0 16 16">
            <Path d="M3 4.5h10M3 8h10M3 11.5h6" stroke={c.textMuted} strokeWidth={1.6} strokeLinecap="round" />
          </Svg>
        </View>
      )
    default:
      return <View style={box} />
  }
}

/** Aggregate signal of a project or section: small shape + number. */
export function SignalGlyph({ kind, size = 12 }: { kind: 'running' | 'waiting' | 'unread' | 'error'; size?: number }) {
  return <StateGlyph state={kind} size={size} />
}
