// Header nativi (native-stack) con i colori del tema. Su iOS 26 l'header è trasparente: il contenuto ci scorre sotto e il sistema
// disegna il vetro e l'effetto di bordo; prima di iOS 26 e su Android ha lo sfondo del tema.
import type { NativeStackNavigationOptions } from 'expo-router/native-stack'
import { GLASS } from '@/lib/platform'
import { useTheme } from '@/theme/theme'

export function useHeaderOptions(): NativeStackNavigationOptions {
  const { c, dark } = useTheme()
  return {
    headerShown: true,
    // Il vetro e il testo di sistema (barra di ricerca compresa) seguono il tema scelto, non solo il telefono.
    headerUserInterfaceStyle: dark ? 'dark' : 'light',
    headerTintColor: c.text,
    headerTitleStyle: { fontFamily: 'MonaSans-SemiBold', color: c.text },
    headerLargeTitleStyle: { fontFamily: 'MonaSans-SemiBold', color: c.text },
    headerShadowVisible: false,
    headerBackButtonDisplayMode: 'minimal',
    ...(GLASS ? {} : { headerStyle: { backgroundColor: c.background } }),
    contentStyle: { backgroundColor: c.background },
    animation: 'default'
  }
}
