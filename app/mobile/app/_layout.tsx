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

// Un link o un tocco su una notifica che apre direttamente una sessione trova i tab sotto, e quindi un tasto indietro.
export const unstable_settings = { anchor: '(tabs)' }

void SplashScreen.preventAutoHideAsync()
// Come si mostrano le notifiche con l'app aperta e canale Android: prima di qualunque notifica (anche quella che ha aperto l'app).
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
  // La radice della navigazione, per azzerare la pila (resetTo) quando cambia lo stato dell'app (abbinamento, uscita dalla demo).
  const rootRef = useNavigationContainerRef()
  useEffect(() => {
    setRootNavigation(rootRef)
    return () => setRootNavigation(null)
  }, [rootRef])
  const booted = useBoot()
  useEffect(() => installForegroundHook(), [])
  useEffect(() => startDevDriver(), [])
  // Con font e preferenze (quindi il tema) pronti si toglie lo splash nativo e parte l'intro animata (`Intro`), anche se l'avvio
  // non è finito: la Shell compare sotto il velo quando `booted` è vero.
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

/**
 * Sheet nativi (iOS): `formSheet` con maniglia. `fit` = alto quanto il contenuto, altrimenti metà e piena altezza. Su iOS 26 lo sfondo è
 * trasparente e il vetro lo disegna il sistema; prima, il sistema non mette sfondo e si usa la superficie del tema. Niente
 * raggio degli angoli: lo decide il sistema.
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
    // Il nome del canale Android è tradotto: si aggiorna con la lingua.
    void ensureChannel()
  }, [language])
  useNotificationTaps()
  // Da 600 pt in su la Home resta fissa a sinistra; sotto, è la prima schermata della pila.
  const kind = useApp((s) => s.conn.kind)
  const router = useRouter()
  const navReady = !!useRootNavigationState()?.key
  // Il Mac ha tolto questo telefono, o la sua chiave è cambiata: da qualunque schermata si va a spiegarlo.
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
          {/* La chat sta nella radice, sopra i tab: la barra dei tab non può restare sotto il composer, e il tasto indietro torna al tab di partenza. */}
          <Stack.Screen name="session/[id]" options={header} />
          {/* Plan limits si apre dalle Impostazioni e dalla chat: radice, così dalla chat non si impila un secondo (tabs) e il tasto indietro torna lì. */}
          <Stack.Screen name="limits" options={header} />
          <Stack.Screen name="sheet/request" options={({ route }) => sheet(c.surface, (route.params as { fit?: string } | undefined)?.fit === '1')} />
          <Stack.Screen name="sheet/permission" options={sheet(c.surface, true)} />
          <Stack.Screen name="sheet/switch" options={sheet(c.surface, false)} />
          <Stack.Screen name="sheet/turn" options={sheet(c.surface, false)} />
          {/* Altezza piena: con la tastiera su il campo del messaggio resta in vista (un foglio a metà finirebbe sotto la tastiera). */}
          <Stack.Screen name="sheet/new-session" options={sheet(c.surface, false, [0.92])} />
        </Stack>
      </View>
      <SheetHost />
    </View>
  )
}
