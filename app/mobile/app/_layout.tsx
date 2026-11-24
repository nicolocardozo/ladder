import { useFonts } from 'expo-font'
import { Stack } from 'expo-router'
import * as NavigationBar from 'expo-navigation-bar'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import * as SystemUI from 'expo-system-ui'
import { useEffect } from 'react'
import { Appearance, Platform, View, useWindowDimensions } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useBoot } from '@/boot'
import { startDevDriver } from '@/dev-driver'
import { installForegroundHook } from '@/host/controller'
import { applyLocale } from '@/i18n'
import { HomePane } from '@/features/home/HomePane'
import { usePrefs } from '@/store/prefs'
import { useApp } from '@/store/app'
import { ThemeProvider, useTheme } from '@/theme/theme'
import { ToastHost } from '@/ui/ToastHost'
import { WIDE } from '@/ui/Sheet'

void SplashScreen.preventAutoHideAsync()

const fonts = {
  'MonaSans-Regular': require('../assets/fonts/MonaSans-Regular.ttf'),
  'MonaSans-Medium': require('../assets/fonts/MonaSans-Medium.ttf'),
  'MonaSans-SemiBold': require('../assets/fonts/MonaSans-SemiBold.ttf'),
  'MonaspaceNeon-Regular': require('../assets/fonts/MonaspaceNeon-Regular.ttf'),
  'MonaspaceNeon-SemiBold': require('../assets/fonts/MonaspaceNeon-SemiBold.ttf')
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fonts)
  const booted = useBoot()
  useEffect(() => installForegroundHook(), [])
  useEffect(() => startDevDriver(), [])
  const ready = (fontsLoaded || !!fontError) && booted
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync()
  }, [ready])
  if (!ready) return null
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ThemeProvider>
            <Shell />
            <ToastHost />
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

/** Barra di stato, sfondo di sistema e barra di navigazione di Android seguono il tema. */
function Chrome() {
  const { c, dark } = useTheme()
  const matchSystem = usePrefs((s) => s.theme.matchSystem)
  useEffect(() => {
    // Barra di stato, tastiera e controlli di sistema seguono il tema; con "Match system" seguono il telefono.
    Appearance.setColorScheme(matchSystem ? 'unspecified' : dark ? 'dark' : 'light')
  }, [dark, matchSystem])
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(c.background)
    // 'light' = icone chiare (per sfondi scuri).
    if (Platform.OS === 'android') NavigationBar.setStyle(dark ? 'light' : 'dark')
  }, [c.background, dark])
  return <StatusBar style={dark ? 'light' : 'dark'} />
}

function Shell() {
  const { c } = useTheme()
  const { width } = useWindowDimensions()
  const mode = useApp((s) => s.mode)
  const language = usePrefs((s) => s.language)
  useEffect(() => {
    applyLocale(language)
  }, [language])
  // Da 600 pt in su la Home resta fissa a sinistra; sotto, è la prima schermata della pila.
  const docked = width >= WIDE && mode !== 'none'
  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: c.background }}>
      <Chrome />
      {docked ? <HomePane width={Math.min(380, Math.max(320, width * 0.36))} /> : null}
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.background }, animation: 'default' }}>
          <Stack.Screen name="settings" options={{ presentation: 'card' }} />
        </Stack>
      </View>
    </View>
  )
}
