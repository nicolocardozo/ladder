// Barra dei tab nativa (expo-router NativeTabs): Sessions, Waiting, Settings. Su iOS 26 è il vetro di sistema e si riduce scorrendo;
// su Android è la navigation bar Material 3. Il tema cambia solo il colore del tab attivo, il resto è di sistema.
// Il "+" (nuova sessione) è un quarto tab col ruolo `search`, che iOS 26 mette in uno slot di vetro staccato: non naviga, apre lo sheet.
import { Redirect, useRouter, useSegments } from 'expo-router'
import { NativeTabs } from 'expo-router/native-tabs'
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { t } from '@shared/i18n'
import { openSheet } from '@/lib/sheets'
import { useApp } from '@/store/app'
import { useLanguage } from '@/store/prefs'
import { useTheme } from '@/theme/theme'

/** Richieste aperte in attesa di te, su tutte le sessioni (le stesse del banner della Home). */
function useWaitingCount(): number {
  return useApp((s) => Object.values(s.sessions).reduce((n, x) => (x.run === 'waiting' && !x.archived ? n + Math.max(1, x.openRequests ?? 0) : n), 0))
}

export default function TabsLayout() {
  const { c } = useTheme()
  const router = useRouter()
  const mode = useApp((s) => s.mode)
  const kind = useApp((s) => s.conn.kind)
  const waiting = useWaitingCount()
  // Le etichette dei tab si traducono: cambiando lingua il layout si ridisegna.
  useLanguage()
  // Dentro una sessione c'è il composer in basso: la barra dei tab si nasconde.
  // Si guarda la schermata in primo piano; mentre è aperto uno sheet (rotta fuori dai tab) resta com'era.
  const segments = useSegments()
  const [inSession, setInSession] = useState(false)
  useEffect(() => {
    if (segments[0] === '(tabs)') setInSession(segments.includes('session' as never))
  }, [segments])
  if (kind === 'revoked' || kind === 'key-changed') return <Redirect href="/disconnected" />
  if (mode === 'none') return <Redirect href="/welcome" />
  return (
    <NativeTabs tintColor={c.accent} minimizeBehavior="onScrollDown" hidden={inSession}>
      <NativeTabs.Trigger name="(sessions)">
        <NativeTabs.Trigger.Label>{t('Sessions')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left', selected: 'bubble.left.fill' }} md="forum" renderingMode="template" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(waiting)">
        <NativeTabs.Trigger.Label>{t('Waiting')}</NativeTabs.Trigger.Label>
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
        disableAutomaticSearchActivation
        // Disattivato: il sistema non lo seleziona, ma il tocco arriva comunque come tabPress (isPrevented) e apre lo sheet.
        disabled
        hidden={Platform.OS !== 'ios'}
        listeners={{ tabPress: () => openSheet(router, { kind: 'new-session' }) }}
      >
        <NativeTabs.Trigger.Label>{t('New session')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="plus" renderingMode="template" />
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
