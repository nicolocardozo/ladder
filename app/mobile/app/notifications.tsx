// Impostazioni → Notifiche: stato del permesso, quali eventi notificare, fascia silenziosa. Le preferenze stanno sul telefono e
// arrivano al Mac con `device.notify.set` (push.ts le manda a ogni cambio).
import { useEffect } from 'react'
import { AppState, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '@shared/i18n'
import { openSystemSettings, pushStatusLabel, refreshPermission, requestPermission } from '@/host/push'
import { phoneTimeZone } from '@/lib/notify-prefs'
import { useApp } from '@/store/app'
import { usePrefs } from '@/store/prefs'
import { usePush } from '@/store/push'
import { useTheme } from '@/theme/theme'
import { Group, Row, ToggleRow } from '@/ui/List'
import { ScreenHeader } from '@/ui/ScreenHeader'
import { TimeRow } from '@/ui/TimeRow'

export default function NotificationSettings() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const notify = usePrefs((s) => s.notify)
  const setNotify = usePrefs((s) => s.setNotify)
  const { permission, canAsk, tokenFailed } = usePush()
  const mode = useApp((s) => s.mode)
  // Tornando dalle impostazioni di sistema il permesso può essere cambiato.
  useEffect(() => {
    void refreshPermission()
    const sub = AppState.addEventListener('change', (state) => state === 'active' && void refreshPermission())
    return () => sub.remove()
  }, [])
  const granted = permission === 'granted'
  const status = pushStatusLabel(permission, tokenFailed)
  const statusFooter = !granted
    ? permission === 'denied' && !canAsk
      ? t('Notifications are turned off for Ladder. Turn them on in your phone settings.')
      : t('Ladder can tell you when a session is waiting for you or has finished while you are away from your Mac.')
    : tokenFailed
      ? t('Notifications aren’t set up for this build.')
      : t('Notifications only say that something needs you. Your messages and code stay in the encrypted channel with your Mac.')
  const { events, quiet } = notify
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title={t('Notifications')} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        <Group footer={statusFooter}>
          <Row label={t('Status')} value={status} last={granted || mode !== 'remote'} />
          {!granted && mode === 'remote' ? <Row label={permission === 'denied' && !canAsk ? t('Open phone settings') : t('Turn on notifications')} onPress={() => (permission === 'denied' && !canAsk ? openSystemSettings() : void requestPermission())} last /> : null}
        </Group>
        <Group title={t('Notify me when')} footer={t('Only when you are away from your Mac. While the app is open you see everything live.')}>
          <ToggleRow label={t('Waiting for you')} detail={t('Approvals and questions')} value={events.request} onChange={(v) => setNotify({ events: { request: v } })} />
          <ToggleRow label={t('Finished')} detail={t('A session completed its work')} value={events.turn} onChange={(v) => setNotify({ events: { turn: v } })} />
          <ToggleRow label={t('Errors')} value={events.error} onChange={(v) => setNotify({ events: { error: v } })} />
          <ToggleRow label={t('Background agents')} detail={t('All the agents of a session finished')} value={events.agents} onChange={(v) => setNotify({ events: { agents: v } })} last />
        </Group>
        <Group footer={quiet.enabled ? t('Uses this phone’s time zone ({tz}).', { tz: phoneTimeZone() }) : t('No notifications during the hours you choose.')}>
          <ToggleRow label={t('Quiet hours')} value={quiet.enabled} onChange={(v) => setNotify({ quiet: { enabled: v } })} last={!quiet.enabled} />
          {quiet.enabled ? (
            <>
              <TimeRow label={t('From')} value={quiet.from} onChange={(from) => setNotify({ quiet: { from } })} />
              <TimeRow label={t('To')} value={quiet.to} onChange={(to) => setNotify({ quiet: { to } })} />
              <ToggleRow label={t('Allow requests during quiet hours')} value={notify.quietAllowsRequests} onChange={(v) => setNotify({ quietAllowsRequests: v })} last />
            </>
          ) : null}
        </Group>
      </ScrollView>
    </View>
  )
}
