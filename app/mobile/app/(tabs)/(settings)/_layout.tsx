import { Stack } from 'expo-router'
import { t } from '@shared/i18n'
import { useLanguage } from '@/store/prefs'
import { useHeaderOptions } from '@/ui/native-header'

// Chi arriva con un link o un push profondo (es. dal pill alla schermata Mac) trova sotto la radice del tab, e quindi un tasto indietro.
export const unstable_settings = { anchor: 'settings' }

export default function SettingsLayout() {
  const header = useHeaderOptions()
  // I titoli delle schermate si traducono con la lingua: cambiandola il layout si ridisegna.
  useLanguage()
  return (
    <Stack screenOptions={header}>
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="mac" options={{ title: t('Your Mac') }} />
      <Stack.Screen name="notifications" options={{ title: t('Notifications') }} />
      <Stack.Screen name="theme" options={{ title: t('Theme') }} />
      <Stack.Screen name="language" options={{ title: t('Language') }} />
    </Stack>
  )
}
