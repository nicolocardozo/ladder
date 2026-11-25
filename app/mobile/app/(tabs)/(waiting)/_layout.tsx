import { Stack } from 'expo-router'
import { useLanguage } from '@/store/prefs'
import { useHeaderOptions } from '@/ui/native-header'

// Chi arriva con un link o un push profondo (es. dal pill alla schermata Mac) trova sotto la radice del tab, e quindi un tasto indietro.
export const unstable_settings = { anchor: 'waiting' }

export default function WaitingLayout() {
  const header = useHeaderOptions()
  // I titoli delle schermate si traducono con la lingua: cambiandola il layout si ridisegna.
  useLanguage()
  return <Stack screenOptions={header} />
}
