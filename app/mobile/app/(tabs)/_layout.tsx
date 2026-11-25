// Barra dei tab nativa (expo-router NativeTabs): Sessions, Waiting, Settings. Su iOS 26 è il vetro di sistema e si riduce scorrendo;
// su Android è la navigation bar Material 3. Il tema cambia solo il colore del tab attivo, il resto è di sistema.
// La chat di una sessione non sta nei tab: è una schermata della radice (app/session/[id].tsx) e copre la barra da sé.
// Il "+" (nuova sessione) è un quarto tab col ruolo `search`, che iOS 26 mette in uno slot di vetro staccato: non naviga, apre lo sheet.
import { Redirect, useRouter } from 'expo-router'
import { NativeTabs } from 'expo-router/native-tabs'
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
        // Niente `disableAutomaticSearchActivation`: su iOS 27 UIKit stacca il tab di ricerca dalla barra (cerchio di vetro a destra)
        // solo se l'attivazione automatica è accesa; spenta, il "+" resta dentro la barra con la sua etichetta.
        // Disattivato: il sistema non lo seleziona (preventNativeSelection), ma il tocco arriva comunque come tabPress e apre lo sheet.
        disabled
        hidden={Platform.OS !== 'ios'}
        listeners={{ tabPress: () => openSheet(router, { kind: 'new-session' }) }}
      >
        {/* Senza etichetta: il "+" è solo un cerchio di vetro. L'accessibilità la legge dal badge/titolo nascosto. */}
        <NativeTabs.Trigger.Label hidden>{t('New session')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="plus" renderingMode="template" />
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
