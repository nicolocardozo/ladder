import { useNavigation, useRouter } from 'expo-router'
import { useOnce } from '@/lib/use-once'

/** Closes the native sheet (/sheet/… route): only once and only if it is still the foreground screen, never the session underneath. */
export function useSheetClose(): () => void {
  const router = useRouter()
  const navigation = useNavigation()
  return useOnce(() => {
    if (navigation.isFocused() && router.canGoBack()) router.back()
  })
}
