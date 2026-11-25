import { Stack } from 'expo-router'
import { useLanguage } from '@/store/prefs'
import { useHeaderOptions } from '@/ui/native-header'

// Someone arriving through a link or a deep push (e.g. from the pill to the Mac screen) finds the tab root underneath, and so a back button.
export const unstable_settings = { anchor: 'index' }

export default function SessionsLayout() {
  const header = useHeaderOptions()
  // Screen titles are translated with the language: changing it redraws the layout.
  useLanguage()
  return <Stack screenOptions={header} />
}
