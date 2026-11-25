// The connection pill: Mac name and state, always visible at the top of Home. Ready to become a Mac selector
// (v1: a single Mac, a tap opens the Mac and connection screen).
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import Svg, { Circle } from 'react-native-svg'
import { t } from '@shared/i18n'
import { reasonKind } from '@/lib/connection'
import { duration } from '@/lib/format'
import { openSheet } from '@/lib/sheets'
import { useApp } from '@/store/app'
import { useTheme } from '@/theme/theme'
import { StateGlyph } from './StateGlyph'
import { Text } from './Text'

/** The technical reason becomes a short translated sentence; if it is not recognized it is not shown. */
function reasonText(reason: string | undefined): string | null {
  switch (reasonKind(reason)) {
    case 'timeout':
      return t('No answer')
    case 'refused':
      return t('Connection failed')
    case 'lost':
      return t('Connection lost')
    case 'secure':
      return t('Could not set up a secure connection')
    default:
      return null
  }
}

/** Short state text, for the pill and for the Mac screen. */
export function useConnectionText(): { title: string; detail: string | null; tone: 'ok' | 'busy' | 'bad' } {
  const conn = useApp((s) => s.conn)
  const mode = useApp((s) => s.mode)
  const mac = useApp((s) => s.macName) ?? t('Your Mac')
  // Refreshes the "for how long" every 15 s.
  const [, tick] = useState(0)
  useEffect(() => {
    if (conn.kind !== 'unreachable' && conn.kind !== 'reconnecting' && conn.kind !== 'mac-offline') return
    const id = setInterval(() => tick((n) => n + 1), 15_000)
    return () => clearInterval(id)
  }, [conn.kind])
  if (mode === 'demo') return { title: mac, detail: t('Demo data, nothing leaves this phone'), tone: 'ok' }
  switch (conn.kind) {
    case 'connected':
      return { title: mac, detail: t('Connected'), tone: 'ok' }
    case 'syncing':
      return { title: t('Updating messages'), detail: mac, tone: 'busy' }
    case 'reconnecting':
      return { title: t('Reconnecting'), detail: mac, tone: 'busy' }
    case 'connecting':
      return { title: t('Connecting'), detail: mac, tone: 'busy' }
    case 'unreachable': {
      const since = duration(Date.now() - conn.since)
      const why = reasonText(conn.reason)
      return { title: t('Mac unreachable'), detail: why ? t('For {time} · {reason}', { time: since, reason: why }) : t('For {time}', { time: since }), tone: 'bad' }
    }
    case 'mac-offline': {
      // The relay knows why the Mac is not there (off, paused, Ladder closed) and since when.
      const title =
        conn.reason === 'asleep' ? t('Your Mac is asleep') : conn.reason === 'quit' ? t('Ladder is closed on your Mac') : conn.reason === 'offline' ? t('Your Mac is offline') : t('Mac unreachable')
      return { title, detail: conn.since ? (Date.now() - conn.since < 15_000 ? t('Last seen just now') : t('Last seen {time} ago', { time: duration(Date.now() - conn.since) })) : null, tone: 'bad' }
    }
    case 'disabled':
      return { title: t('Phone access is off'), detail: t('Turn on “Access from your phone” in Ladder on your Mac.'), tone: 'bad' }
    case 'revoked':
      return { title: t('Disconnected'), detail: t('This phone was disconnected from your Mac.'), tone: 'bad' }
    case 'key-changed':
      return { title: t('Mac key changed'), detail: t('Pair this phone with your Mac again.'), tone: 'bad' }
    case 'denied':
      return { title: t('Mac unreachable'), detail: null, tone: 'bad' }
  }
}

function Ring({ color }: { color: string }) {
  const reduce = useReducedMotion()
  const spin = useSharedValue(0)
  useEffect(() => {
    if (!reduce) spin.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1)
    return () => cancelAnimation(spin)
  }, [reduce, spin])
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }] }))
  return (
    <Animated.View style={[{ width: 14, height: 14 }, style]}>
      <Svg width={14} height={14}>
        <Circle cx={7} cy={7} r={5} stroke={color} strokeOpacity={0.3} strokeWidth={2} fill="none" />
        <Circle cx={7} cy={7} r={5} stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" strokeDasharray="9 40" />
      </Svg>
    </Animated.View>
  )
}

export function ConnectionPill() {
  const { c } = useTheme()
  const router = useRouter()
  const { title, detail, tone } = useConnectionText()
  const mode = useApp((s) => s.mode)
  const conn = useApp((s) => s.conn)
  const mark =
    tone === 'ok' ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.success }} /> : tone === 'busy' ? <Ring color={c.textMuted} /> : <StateGlyph state="error" size={14} />
  // Small, on the title row: only the Mac name (or the problem); the rest is in the sheet that opens on tap.
  const label = conn.kind === 'unreachable' && detail ? `${title} · ${detail.split(' · ')[0]}` : title
  return (
    <Pressable
      onPress={() => openSheet(router, { kind: 'mac' })}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail ?? ''}`}
      accessibilityHint={t('Opens Mac and connection details')}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      style={({ pressed }) => ({ height: 28, maxWidth: 140, flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 9, borderRadius: 14, backgroundColor: pressed ? c.selection : c.surface })}
    >
      {mark}
      <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
        {conn.kind === 'connected' || mode === 'demo' ? title : label}
      </Text>
    </Pressable>
  )
}
