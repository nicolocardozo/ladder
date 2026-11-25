// Native headers (native-stack) with the theme's colors. On iOS 26 the header is transparent: content scrolls under it and the system
// draws the glass and the edge effect; before iOS 26 and on Android it has the theme background.
import type { NativeStackNavigationOptions } from 'expo-router/native-stack'
import { GLASS } from '@/lib/platform'
import { useTheme } from '@/theme/theme'

export function useHeaderOptions(): NativeStackNavigationOptions {
  const { c, dark } = useTheme()
  return {
    headerShown: true,
    // The glass and system text (search bar included) follow the chosen theme, not just the phone.
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
