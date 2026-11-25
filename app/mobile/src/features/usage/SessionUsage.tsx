// Limiti d'uso dentro la sessione (LAD-90): avviso solo vicino al limite. Nell'header un triangolo accanto al permesso (da 80% o a
// limite esaurito, la stessa soglia del desktop); sopra il composer un bannerino da 95%. Toccandoli si apre "Plan limits" sull'account
// della sessione. Sotto soglia non c'è niente. Il bannerino chiuso resta chiuso finché la finestra non si azzera (solo in memoria).
import { useRouter } from 'expo-router'
import { useCallback, useMemo } from 'react'
import { Pressable, View } from 'react-native'
import { create } from 'zustand'
import { t } from '@shared/i18n'
import type { SessionSummary } from '@shared/protocol'
import { useNow } from '@/lib/use-now'
import { dismissKey, isDismissed, sessionAlert, USAGE_BANNER_AT, usageAlertText, type UsageAlert } from '@/lib/usage'
import { onWorldReset } from '@/lib/world-reset'
import { useApp } from '@/store/app'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Icon } from '@/ui/Icon'
import { Text } from '@/ui/Text'
import { AlertGlyph } from './UsageBits'

type Target = Pick<SessionSummary, 'agent' | 'profileId'>

/** L'avviso dell'account di una sessione alla soglia data, con il suo testo già tradotto. */
export function useSessionUsageAlert(session: Target | undefined, threshold?: number): { alert: UsageAlert; text: { what: string; reset: string | null } } | null {
  const agents = useApp((s) => s.agents)
  const now = useNow(60_000)
  const agent = session?.agent
  const profileId = session?.profileId
  return useMemo(() => {
    if (!agent) return null
    const alert = sessionAlert(agents, agent, profileId, now, threshold)
    return alert ? { alert, text: usageAlertText(alert, now) } : null
  }, [agents, agent, profileId, now, threshold])
}

/** Apre "Plan limits" con l'account della sessione per primo. */
export function useOpenLimits(session: Target | undefined): () => void {
  const router = useRouter()
  const agent = session?.agent
  const profileId = session?.profileId
  // Stabile: entra nelle dipendenze delle opzioni dell'header, che non devono ricalcolarsi a ogni pezzo di testo in arrivo.
  return useCallback(() => router.push({ pathname: '/limits', params: { ...(agent ? { agent } : {}), ...(profileId ? { profileId } : {}) } }), [router, agent, profileId])
}

// ── Bannerino ──

const useDismissed = create<{ closed: ReadonlyMap<string, number | null>; dismiss: (key: string, resetsAt: number | null) => void }>((set) => ({
  closed: new Map(),
  dismiss: (key, resetsAt) => set((s) => ({ closed: new Map(s.closed).set(key, resetsAt) }))
}))
// Per un altro Mac (o la demo) i bannerini chiusi non valgono più.
onWorldReset(() => useDismissed.setState({ closed: new Map() }))

export function UsageBanner({ session }: { session: Target }) {
  const { c } = useTheme()
  const open = useOpenLimits(session)
  const found = useSessionUsageAlert(session, USAGE_BANNER_AT)
  const closed = useDismissed((s) => s.closed)
  if (!found) return null
  const { alert, text } = found
  // Chiave: account e finestra. Il reset si ricorda a parte e si confronta con una tolleranza (l'host lo ricalcola a ogni lettura).
  const key = dismissKey(session.agent, session.profileId, alert.usage.key)
  if (isDismissed(closed, key, alert.usage.resetsAt)) return null
  const tone = alert.limited ? c.error : c.waiting
  const message = [text.what, text.reset].filter(Boolean).join(' ')
  return (
    <View style={{ marginHorizontal: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center', borderRadius: RADIUS.md, backgroundColor: alpha(tone, 0.12), borderWidth: 1, borderColor: alpha(tone, 0.5) }}>
      <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`${message} ${t('Plan limits')}`} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, paddingVertical: 8, minHeight: 40 }}>
        <AlertGlyph limited={alert.limited} size={16} />
        <Text variant="caption" numberOfLines={2} style={{ flex: 1 }}>
          {message}
        </Text>
      </Pressable>
      <Pressable onPress={() => useDismissed.getState().dismiss(key, alert.usage.resetsAt)} accessibilityRole="button" accessibilityLabel={t('Dismiss')} hitSlop={6} style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="x" size={16} color={c.textMuted} />
      </Pressable>
    </View>
  )
}
