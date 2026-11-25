import { useNavigation, useRouter } from 'expo-router'
import { useOnce } from '@/lib/use-once'

/** Chiude lo sheet nativo (rotta /sheet/…): una volta sola e solo se è ancora la schermata in primo piano, mai la sessione sotto. */
export function useSheetClose(): () => void {
  const router = useRouter()
  const navigation = useNavigation()
  return useOnce(() => {
    if (navigation.isFocused() && router.canGoBack()) router.back()
  })
}
