import { useFonts } from 'expo-font'
import { Stack, useNavigationContainerRef, useRootNavigationState, useRouter } from 'expo-router'
import type { NativeStackNavigationOptions } from 'expo-router/native-stack'
import * as NavigationBar from 'expo-navigation-bar'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import * as SystemUI from 'expo-system-ui'
import { useEffect } from 'react'
import { Appearance, Platform, View, useWindowDimensions } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useBoot, usePrefsHydrated } from '@/boot'
import { startDevDriver } from '@/dev-driver'
import { installForegroundHook } from '@/host/controller'
import { startLiveActivities } from '@/host/live-activity'
import { configureNotifications, ensureChannel } from '@/host/push'
import { useNotificationTaps } from '@/host/push-taps'
import { applyLocale } from '@/i18n'
import { setRootNavigation } from '@/lib/nav'
import { HomePane } from '@/features/home/HomePane'
import { SheetHost } from '@/features/sheets/SheetHost'
import { GLASS } from '@/lib/platform'
import { usePrefs } from '@/store/prefs'
import { useApp } from '@/store/app'
import { ThemeProvider, useTheme } from '@/theme/theme'
import { Intro } from '@/ui/Intro'
import { ToastHost } from '@/ui/ToastHost'
import { WIDE } from '@/ui/Sheet'
import { useHeaderOptions } from '@/ui/native-header'

// A link or a tap on a notification that opens a session directly finds the tabs underneath, and so a back button.
export const unstable_settings = { anchor: '(tabs)' }

void SplashScreen.preventAutoHideAsync()
// How notifications show while the app is open, and the Android channel: before any notification (including the one that opened the app).
configureNotifications()

const fonts = {
  'MonaSans-Regular': require('../assets/fonts/MonaSans-Regular.ttf'),
  'MonaSans-Medium': require('../assets/fonts/MonaSans-Medium.ttf'),
  'MonaSans-SemiBold': require('../assets/fonts/MonaSans-SemiBold.ttf'),
  'MonaspaceNeon-Regular': require('../assets/fonts/MonaspaceNeon-Regular.ttf'),
  'MonaspaceNeon-SemiBold': require('../assets/fonts/MonaspaceNeon-SemiBold.ttf')
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fonts)
  // The navigation root, to reset the stack (resetTo) when the app state changes (pairing, leaving the demo).
  const rootRef = useNavigationContainerRef()
  useEffect(() => {
    setRootNavigation(rootRef)
    return () => setRootNavigation(null)
  }, [rootRef])
  const booted = useBoot()
  useEffect(() => installForegroundHook(), [])
  useEffect(() => startDevDriver(), [])
  // Live Activity and widget (iOS): they follow the store as long as the app is alive.
  useEffect(() => startLiveActivities(), [])
  // With fonts and preferences (hence the theme) ready, the native splash is removed and the animated intro (`Intro`) starts, even if boot
  // hasn't finished: the Shell appears under the veil when `booted` is true.
  const hydrated = usePrefsHydrated()
  if (!(fontsLoaded || !!fontError) || !hydrated) return null
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ThemeProvider>
            {booted ? <Shell /> : null}
            <ToastHost />
            <Intro ready={booted} />
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

/** Status bar, system background and Android navigation bar follow the theme. */
function Chrome() {
  const { c, dark } = useTheme()
  const matchSystem = usePrefs((s) => s.theme.matchSystem)
  useEffect(() => {
    // Status bar, keyboard and system controls follow the theme; with "Match system" they follow the phone.
    Appearance.setColorScheme(matchSystem ? 'unspecified' : dark ? 'dark' : 'light')
  }, [dark, matchSystem])
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(c.background)
    // 'light' = light icons (for dark backgrounds).
    if (Platform.OS === 'android') NavigationBar.setStyle(dark ? 'light' : 'dark')
  }, [c.background, dark])
  return <StatusBar style={dark ? 'light' : 'dark'} />
}

/**
 * Native sheets (iOS): `formSheet` with a grabber. `fit` = as tall as the content, otherwise half and full height. On iOS 26 the background is
 * transparent and the system draws the glass; before that, the system adds no background and the theme surface is used. No
 * corner radius: the system decides.
 */
function sheet(surface: string, fit: boolean, detents?: number[]): NativeStackNavigationOptions {
  return {
    presentation: 'formSheet',
    headerShown: false,
    gestureEnabled: true,
    sheetGrabberVisible: true,
    sheetAllowedDetents: fit ? 'fitToContents' : (detents ?? [0.5, 1]),
    sheetInitialDetentIndex: 0,
    contentStyle: { backgroundColor: GLASS ? 'transparent' : surface }
  }
}

function Shell() {
  const { c } = useTheme()
  const header = useHeaderOptions()
  const { width } = useWindowDimensions()
  const mode = useApp((s) => s.mode)
  const language = usePrefs((s) => s.language)
  useEffect(() => {
    applyLocale(language)
    // The Android channel name is translated: it updates with the language.
    void ensureChannel()
  }, [language])
  useNotificationTaps()
  // From 600 pt up the Home stays docked on the left; below that, it is the first screen of the stack.
  const kind = useApp((s) => s.conn.kind)
  const router = useRouter()
  const navReady = !!useRootNavigationState()?.key
  // The Mac removed this phone, or its key changed: from any screen we go to explain it.
  useEffect(() => {
    if (navReady && (kind === 'revoked' || kind === 'key-changed')) router.replace('/disconnected')
  }, [kind, navReady, router])
  const docked = width >= WIDE && mode !== 'none' && kind !== 'key-changed'
  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: c.background }}>
      <Chrome />
      {docked ? <HomePane width={Math.min(380, Math.max(320, width * 0.36))} /> : null}
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.background }, animation: 'default' }}>
          {/* The chat lives at the root, above the tabs: the tab bar can't stay under the composer, and the back button returns to the starting tab. */}
          <Stack.Screen name="session/[id]" options={header} />
          {/* Plan limits opens from Settings and from the chat: root, so from the chat a second (tabs) isn't stacked and the back button returns there. */}
          <Stack.Screen name="limits" options={header} />
          <Stack.Screen name="sheet/request" options={({ route }) => sheet(c.surface, (route.params as { fit?: string } | undefined)?.fit === '1')} />
          <Stack.Screen name="sheet/permission" options={sheet(c.surface, true)} />
          <Stack.Screen name="sheet/mac" options={sheet(c.surface, true)} />
          <Stack.Screen name="sheet/switch" options={sheet(c.surface, false)} />
          <Stack.Screen name="sheet/turn" options={sheet(c.surface, false)} />
          {/* As tall as the content: with the keyboard up it stays above it (NativeSheet caps the height and scrolls if needed). */}
          <Stack.Screen name="sheet/new-session" options={sheet(c.surface, true)} />
        </Stack>
      </View>
      <SheetHost />
    </View>
  )
}
