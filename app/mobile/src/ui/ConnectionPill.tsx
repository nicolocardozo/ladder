// Il pill della connessione: nome del Mac e stato, sempre visibile in cima alla Home. Pronto a diventare un selettore di Mac
// (v1: un Mac solo, il tocco apre la schermata Mac e connessione).
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import Svg, { Circle } from 'react-native-svg'
import { t } from '@shared/i18n'
import { reasonKind } from '@/lib/connection'
import { duration } from '@/lib/format'
import { useApp } from '@/store/app'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Icon } from './Icon'
import { StateGlyph } from './StateGlyph'
import { Text } from './Text'

/** Il motivo tecnico diventa una frase breve e tradotta; se non lo si riconosce non si mostra. */
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

/** Testo breve dello stato, per il pill e per la schermata Mac. */
export function useConnectionText(): { title: string; detail: string | null; tone: 'ok' | 'busy' | 'bad' } {
  const conn = useApp((s) => s.conn)
  const mode = useApp((s) => s.mode)
  const mac = useApp((s) => s.macName) ?? t('Your Mac')
  // Rinfresca il "da quanto" ogni 15 s.
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
      // Il relay sa perché il Mac non c'è (spento, in pausa, Ladder chiuso) e da quando.
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
  // Solo "unreachable" aggiunge da quanto; gli altri titoli sono già lunghi, il resto sta nella schermata del Mac.
  const label = conn.kind === 'unreachable' && detail ? `${title} · ${detail.split(' · ')[0]}` : title
  return (
    <Pressable
      onPress={() => router.push('/mac')}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail ?? ''}`}
      accessibilityHint={t('Opens Mac and connection details')}
      style={({ pressed }) => ({ minHeight: 44, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, borderRadius: RADIUS.xl + 8, backgroundColor: pressed ? c.selection : c.surface })}
    >
      {mark}
      <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
        {conn.kind === 'connected' || mode === 'demo' ? title : label}
      </Text>
      {mode === 'demo' ? (
        <View style={{ paddingHorizontal: 7, height: 20, borderRadius: 6, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
          <Text variant="caption" style={{ color: c.onAccent, fontFamily: 'MonaSans-SemiBold', fontSize: 11, lineHeight: 14 }} maxFontSizeMultiplier={1.2}>
            {t('Demo')}
          </Text>
        </View>
      ) : null}
      <Icon name="chevron-down" size={14} color={c.textMuted} />
    </Pressable>
  )
}
