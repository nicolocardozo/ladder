// Native tab bar (expo-router NativeTabs): Sessions, Waiting, Settings. On iOS 26 it is the system glass and it shrinks on scroll;
// on Android it is the Material 3 navigation bar. The theme only changes the active tab color, the rest is up to the system.
// A session's chat is not in the tabs: it is a root screen (app/session/[id].tsx) and covers the bar on its own.
// The "+" (new session) is a fourth tab with the `search` role, which iOS 26 puts in a detached glass slot: it doesn't navigate, it opens the sheet.
import { Redirect, useRouter } from 'expo-router'
import { NativeTabs } from 'expo-router/native-tabs'
import { Platform } from 'react-native'
import { t } from '@shared/i18n'
import { openSheet } from '@/lib/sheets'
import { useApp } from '@/store/app'
import { useLanguage } from '@/store/prefs'
import { useTheme } from '@/theme/theme'

/** Open requests waiting for you, across all sessions (the same ones as the Home banner). */
function useWaitingCount(): number {
  return useApp((s) => Object.values(s.sessions).reduce((n, x) => (x.run === 'waiting' && !x.archived ? n + Math.max(1, x.openRequests ?? 0) : n), 0))
}

export default function TabsLayout() {
  const { c } = useTheme()
  const router = useRouter()
  const mode = useApp((s) => s.mode)
  const kind = useApp((s) => s.conn.kind)
  const waiting = useWaitingCount()
  // Tab labels are translated: changing language redraws the layout.
  useLanguage()
  if (kind === 'revoked' || kind === 'key-changed') return <Redirect href="/disconnected" />
  if (mode === 'none') return <Redirect href="/welcome" />
  return (
    <NativeTabs tintColor={c.accent} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="(sessions)">
        <NativeTabs.Trigger.Label>{t('Sessions')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left', selected: 'bubble.left.fill' }} md="forum" renderingMode="template" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(waiting)">
        <NativeTabs.Trigger.Label>{t('Requests')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'hourglass', selected: 'hourglass' }} md="hourglass_empty" renderingMode="template" />
        <NativeTabs.Trigger.Badge hidden={waiting === 0}>{String(waiting)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(settings)">
        <NativeTabs.Trigger.Label>{t('Settings')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'gearshape', selected: 'gearshape.fill' }} md="settings" renderingMode="template" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="new"
        role="search"
        // No `disableAutomaticSearchActivation`: on iOS 27 UIKit detaches the search tab from the bar (glass circle on the right)
        // only if automatic activation is on; turned off, the "+" stays inside the bar with its label.
        // Disabled: the system doesn't select it (preventNativeSelection), but the tap still arrives as tabPress and opens the sheet.
        disabled
        hidden={Platform.OS !== 'ios'}
        listeners={{ tabPress: () => openSheet(router, { kind: 'new-session' }) }}
      >
        {/* No label: the "+" is just a glass circle. Accessibility reads it from the hidden badge/title. */}
        <NativeTabs.Trigger.Label hidden>{t('New session')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="plus" renderingMode="template" />
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
