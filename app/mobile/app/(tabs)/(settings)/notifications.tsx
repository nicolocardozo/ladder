// Impostazioni → Notifiche: stato del permesso, quali eventi notificare, fascia silenziosa. Le preferenze stanno sul telefono e
// arrivano al Mac con `device.notify.set` (push.ts le manda a ogni cambio).
import { useEffect } from 'react'
import { AppState, ScrollView } from 'react-native'
import { t } from '@shared/i18n'
import { liveActivitySupported } from '@/host/live-activity'
import { openSystemSettings, pushStatusLabel, refreshPermission, requestPermission } from '@/host/push'
import { phoneTimeZone } from '@/lib/notify-prefs'
import { useApp } from '@/store/app'
import { usePrefs } from '@/store/prefs'
import { usePush } from '@/store/push'
import { useTheme } from '@/theme/theme'
import { Group, Row, ToggleRow } from '@/ui/List'
import { TimeRow } from '@/ui/TimeRow'

export default function NotificationSettings() {
  const { c } = useTheme()
  const notify = usePrefs((s) => s.notify)
  const setNotify = usePrefs((s) => s.setNotify)
  const live = usePrefs((s) => s.live)
  const setLive = usePrefs((s) => s.setLive)
  const widget = usePrefs((s) => s.widget)
  const setWidget = usePrefs((s) => s.setWidget)
  const widgetTitles = usePrefs((s) => s.widgetTitles)
  const setWidgetTitles = usePrefs((s) => s.setWidgetTitles)
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
      : t('Ladder can tell you when a session needs you or has finished while you are away from your Mac.')
    : tokenFailed
      ? t('Notifications aren’t set up for this build.')
      : t('Notifications only say that something needs you. Your messages and code stay in the encrypted channel with your Mac.')
  const { events, quiet } = notify
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: 32 }}>
        <Group footer={statusFooter}>
          <Row label={t('Status')} value={status} last={granted || mode !== 'remote'} />
          {!granted && mode === 'remote' ? <Row label={permission === 'denied' && !canAsk ? t('Open phone settings') : t('Turn on notifications')} onPress={() => (permission === 'denied' && !canAsk ? openSystemSettings() : void requestPermission())} last /> : null}
        </Group>
        <Group title={t('Notify me when')} footer={t('Only when you are away from your Mac. While the app is open you see everything live.')}>
          <ToggleRow label={t('Requests')} detail={t('Approvals and questions')} value={events.request} onChange={(v) => setNotify({ events: { request: v } })} />
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
        {liveActivitySupported() ? (
          <Group title={t('Lock Screen')} footer={t('Follow a session on the Lock Screen and in the Dynamic Island while it works. The title of a session you follow is shown on the Lock Screen and kept in iOS’s own storage for Live Activities. Nothing goes through Apple or Expo servers. If Ladder is closed or in the background, the activity may lag and shows “Out of date” after a few minutes.')}>
            <ToggleRow label={t('Live Activities')} detail={t('Working, waiting, finished')} value={live.enabled} onChange={(v) => setLive({ enabled: v })} last={!live.enabled} />
            {live.enabled ? <ToggleRow label={t('Start automatically')} detail={t('For sessions you open or write to here')} value={live.auto} onChange={(v) => setLive({ auto: v })} last /> : null}
          </Group>
        ) : null}
        {liveActivitySupported() ? (
          <Group footer={widget ? `${t('The “Agent activity” widget shows how many sessions work and wait. It reads data saved on this phone and uses no network.')} ${t('Off by default: the widget shows only counts. If you turn this on, the titles of waiting sessions are stored on this phone outside the encrypted copy and may be included in device backups.')}` : t('The “Agent activity” widget shows how many sessions work and wait. It reads data saved on this phone and uses no network.')}>
            <ToggleRow label={t('Agent activity widget')} value={widget} onChange={setWidget} last={!widget} />
            {widget ? <ToggleRow label={t('Show session titles in the widget')} value={widgetTitles} onChange={setWidgetTitles} last /> : null}
          </Group>
        ) : null}
    </ScrollView>
  )
}
