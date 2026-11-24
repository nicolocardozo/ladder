// Notifiche push sul telefono (LAD-53). Il Mac manda un push generico quando non lo stai usando; qui si fa la parte del telefono:
//  - permesso di sistema e canale Android "sessions";
//  - token Expo → `device.push.set` (null se il permesso manca o è stato tolto);
//  - preferenze → `device.notify.set` a ogni connessione e a ogni cambio;
//  - primo piano / sfondo → `device.state` a ogni cambio di AppState e ogni 20 secondi finché si è in primo piano;
//  - il tocco su una notifica si gestisce in push-taps.ts.
// Non importa il controller (niente cicli): il controller dà `send` con `startPush` e avvisa con `pushLinkReady`.
// Nella demo non si avvia mai: niente permesso, niente token, niente comandi.
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { AppState, Linking, Platform } from 'react-native'
import { t } from '@shared/i18n'
import { REMOTE_PUSH_CHANNEL, type RemoteCommand } from '@shared/protocol'
import { phoneTimeZone, toWirePrefs } from '@/lib/notify-prefs'
import { cachedTokenStillValid, isTransientTokenError, notSetUpAfterTransient } from '@/lib/push-token'
import { devicePlatform } from '@/store/pairing'
import { usePrefs } from '@/store/prefs'
import { usePush, type PushPermission } from '@/store/push'

type Send = (command: RemoteCommand) => Promise<unknown>

/** Battito dello stato in primo piano: il Mac lo considera vivo per 30 secondi. */
const HEARTBEAT_MS = 20_000
/** Quanto si aspetta il Mac, scollegandosi, prima di lasciar perdere (il token resta lì, ma non è un problema: il push non arriva a un token tolto). */
const UNREGISTER_WAIT_MS = 1_500

let link: { send: Send; macKey: string } | null = null
let ready = false
let subs: { remove(): void }[] = []
let heartbeat: ReturnType<typeof setInterval> | null = null
let notifyTimer: ReturnType<typeof setTimeout> | null = null
/** Serializza token e permesso: un solo giro alla volta, così due eventi vicini non si accavallano. */
let chain: Promise<unknown> = Promise.resolve()
const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
  const next = chain.then(job, job)
  chain = next.catch(() => {})
  return next
}

// ── Impostazione iniziale (una volta, all'avvio dell'app) ──

/**
 * Con l'app in primo piano gli eventi si vedono dal vivo e il Mac non manda il push: se ne arriva uno lo stesso (connessione muta),
 * niente banner e niente suono. Su iOS resta nel Centro notifiche (`shouldShowList`); su Android non si mostra affatto, perché lì
 * l'elenco coincide con l'heads-up del canale ad alta importanza.
 * Nessun badge: Ladder non lo imposta (i push non portano un conteggio e il telefono non lo ricalcola con l'app chiusa).
 */
export function configureNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: Platform.OS === 'ios', shouldPlaySound: false, shouldSetBadge: false })
  })
  void ensureChannel()
}

/** Canale Android dei push (importanza alta, nome tradotto). Si può richiamare: aggiorna il nome se cambia la lingua. */
export async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return
  try {
    await Notifications.setNotificationChannelAsync(REMOTE_PUSH_CHANNEL, {
      name: t('Sessions'),
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 150, 200],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE
    })
  } catch {
    // il canale non si è potuto creare: le notifiche usano quello predefinito
  }
}

// ── Permesso ──

function permissionOf(status: Notifications.NotificationPermissionsStatus): { permission: PushPermission; canAsk: boolean } {
  if (status.granted) return { permission: 'granted', canAsk: false }
  return { permission: status.status === 'undetermined' ? 'undetermined' : 'denied', canAsk: status.canAskAgain }
}

/** Stato delle notifiche come lo mostrano Impostazioni e la schermata Notifiche: acceso, spento (permesso mancante o negato) o non configurato (build senza credenziali). */
export function pushStatusLabel(permission: PushPermission, tokenFailed: boolean): string {
  if (permission !== 'granted') return t('Off')
  return tokenFailed ? t('Not set up') : t('On')
}

/** Rilegge il permesso di sistema (anche dopo che l'utente è passato dalle impostazioni). */
export async function refreshPermission(): Promise<PushPermission> {
  try {
    const { permission, canAsk } = permissionOf(await Notifications.getPermissionsAsync())
    usePush.getState().set({ permission, canAsk })
    return permission
  } catch {
    return usePush.getState().permission
  }
}

/** Chiede il permesso (finestra di sistema) e, se concesso, registra il token e lo manda al Mac. Nella demo non fa nulla. */
export async function requestPermission(): Promise<PushPermission> {
  if (!link) return usePush.getState().permission
  await ensureChannel()
  try {
    const status = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } })
    const { permission, canAsk } = permissionOf(status)
    usePush.getState().set({ permission, canAsk })
  } catch {
    await refreshPermission()
  }
  // Il token si registra in sottofondo: chi chiama può proseguire appena il permesso è noto.
  void syncToken(true)
  return usePush.getState().permission
}

/** Apre le impostazioni di sistema di Ladder (permesso negato). */
export function openSystemSettings(): void {
  void Linking.openSettings().catch(() => {})
}

// ── Token ──

const projectId = (): string | undefined => {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId
}

const TOKEN_KEY = 'ladder.push-token.v1'
/** Ultimo token Expo buono, con il token di sistema a cui corrisponde: si richiede di nuovo solo se cambia il permesso o quello. */
let cached: { token: string; device: string | null } | null = null
let cacheLoaded = false
/** Ultimo token di sistema (APNs / FCM) visto: gli eventi con lo stesso valore non sono novità. */
let lastDeviceToken: string | null = null
/** Errori passeggeri di fila: "non configurato" solo dopo qualche tentativo, mai al primo intoppo di rete. */
let transientFailures = 0

async function loadCache(): Promise<void> {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const raw = await SecureStore.getItemAsync(TOKEN_KEY)
    const parsed = raw ? (JSON.parse(raw) as { token?: unknown; device?: unknown }) : null
    if (parsed && typeof parsed.token === 'string' && parsed.token.length > 0) cached = { token: parsed.token, device: typeof parsed.device === 'string' ? parsed.device : null }
  } catch {
    // portachiavi non leggibile: si rifà il giro
  }
}

const saveCache = (): void => {
  void (cached ? SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(cached), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }) : SecureStore.deleteItemAsync(TOKEN_KEY)).catch(() => {})
}

/**
 * Il token Expo di adesso:
 *  - stringa: da mandare al Mac;
 *  - null: nessun token (permesso mancante o tolto, build senza credenziali push): al Mac va null;
 *  - undefined: non si sa (errore passeggero): al Mac non si manda nulla e resta l'ultimo buono.
 * `device`: il token di sistema appena ricevuto dall'evento; serve a non richiederlo (e a non riemettere l'evento).
 */
async function currentToken(device?: string): Promise<string | null | undefined> {
  await loadCache()
  const permission = await refreshPermission()
  if (permission !== 'granted') {
    usePush.getState().set({ token: null, tokenFailed: false })
    return null
  }
  // Niente di nuovo (stesso permesso, stesso token di sistema): vale quello già buono.
  if (cached && cachedTokenStillValid(cached, device)) {
    usePush.getState().set({ token: cached.token, tokenFailed: false })
    return cached.token
  }
  try {
    const id = projectId()
    // Con il token di sistema già in mano si passa `devicePushToken`: Expo non lo richiede di nuovo (richiederlo riemette l'evento del token).
    const { data } = await Notifications.getExpoPushTokenAsync({ ...(id ? { projectId: id } : {}), ...(device ? { devicePushToken: { type: Platform.OS === 'ios' ? 'ios' : 'android', data: device } } : {}) })
    cached = { token: data, device: device ?? lastDeviceToken }
    saveCache()
    transientFailures = 0
    usePush.getState().set({ token: data, tokenFailed: false })
    return data
  } catch (error) {
    if (isTransientTokenError(error)) {
      // Rete o server: si tiene l'ultimo token buono (se c'è) e si riprova alla prossima occasione; "non configurato" solo se insiste.
      transientFailures++
      usePush.getState().set({ tokenFailed: notSetUpAfterTransient(!!cached, transientFailures) })
      return cached ? cached.token : undefined
    }
    cached = null
    saveCache()
    usePush.getState().set({ token: null, tokenFailed: true })
    return null
  }
}

/**
 * Porta il token (o null) al Mac. `always`: anche se non è cambiato (a ogni nuova connessione); altrimenti solo se diverso
 * dall'ultimo mandato su questa connessione. Con il permesso tolto manda null, così il Mac smette di provare a notificare.
 */
let lastSent: string | null | undefined
function syncToken(always: boolean, device?: string): Promise<void> {
  return enqueue(async () => {
    if (!link) return
    const token = await currentToken(device)
    // Dopo l'attesa il collegamento può essere cambiato o finito (stopPush): niente invii fuori tempo.
    if (token === undefined || !link || !ready) return
    if (!always && lastSent === token) return
    try {
      await link.send({ type: 'device.push.set', token, platform: devicePlatform() })
      lastSent = token
    } catch {
      // senza collegamento: lo rifà pushLinkReady alla prossima connessione
    }
  })
}

// ── Preferenze e stato ──

/** Fuso mandato con le ultime preferenze: se il telefono cambia fuso (viaggio) la fascia silenziosa va rimandata. */
let lastTz: string | null = null
function sendNotify(): Promise<unknown> {
  if (!link || !ready) return Promise.resolve()
  const tz = phoneTimeZone()
  return link
    .send({ type: 'device.notify.set', prefs: toWirePrefs(usePrefs.getState().notify, tz) })
    .then(() => {
      lastTz = tz
    })
    .catch(() => {})
}

function sendState(): Promise<unknown> {
  if (!link || !ready) return Promise.resolve()
  return link.send({ type: 'device.state', foreground: AppState.currentState === 'active' }).catch(() => {})
}

// ── Ciclo di vita ──

/**
 * Parte con la connessione al Mac (non nella demo). Ascolta cambi di token, di AppState e delle preferenze, ma non manda nulla finché
 * il collegamento non è pronto (`pushLinkReady`).
 */
export function startPush(send: Send, macKey: string): void {
  clearListeners()
  link = { send, macKey }
  ready = false
  lastSent = undefined
  lastTz = null
  transientFailures = 0
  subs.push(
    // Il token del sistema è cambiato (reinstallazione, rinnovo): quello Expo va richiesto di nuovo, con il token ricevuto.
    // Richiedere il token Expo fa riemettere questo stesso evento: quello con lo stesso valore dell'ultimo visto non è una novità.
    Notifications.addPushTokenListener((token) => {
      if (typeof token.data !== 'string' || token.data === lastDeviceToken) return
      lastDeviceToken = token.data
      void syncToken(false, token.data)
    }),
    AppState.addEventListener('change', (state) => {
      void sendState()
      if (state !== 'active') return
      // Tornando in primo piano il permesso può essere cambiato dalle impostazioni di sistema (token o null di conseguenza)
      // e il telefono può aver cambiato fuso orario (la fascia silenziosa si valuta nel suo fuso).
      void syncToken(false)
      if (lastTz !== null && phoneTimeZone() !== lastTz) void sendNotify()
    }),
    {
      remove: usePrefs.subscribe((s, prev) => {
        if (s.notify === prev.notify) return
        // Un interruttore dopo l'altro: si manda l'ultimo stato, non ogni passo.
        if (notifyTimer) clearTimeout(notifyTimer)
        notifyTimer = setTimeout(() => {
          notifyTimer = null
          void sendNotify()
        }, 400)
      })
    }
  )
  heartbeat = setInterval(() => {
    if (AppState.currentState === 'active') void sendState()
  }, HEARTBEAT_MS)
  void refreshPermission()
}

/** Il collegamento al Mac è pronto (dopo ogni hello, anche dopo una riconnessione): token, preferenze e stato. */
export function pushLinkReady(): void {
  if (!link) return
  ready = true
  lastSent = undefined
  // Uno dopo l'altro e in coda: i tre invii non si sommano alle richieste di sincronizzazione nel secchio del client.
  void enqueue(async () => {
    await sendNotify()
    await sendState()
  }).then(() => syncToken(true))
}

function clearListeners(): void {
  for (const s of subs) s.remove()
  subs = []
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  if (notifyTimer) clearTimeout(notifyTimer)
  notifyTimer = null
}

/**
 * Smette: ferma ascolti e battito. Con `unregister` (l'utente scollega il Mac) prima manda `device.push.set` con null, se il
 * collegamento c'era, e toglie la registrazione di sistema; con un abbinamento revocato dal Mac il collegamento non c'è e basta fermarsi.
 */
export async function stopPush(unregister: boolean): Promise<void> {
  const current = link
  const wasReady = ready
  // Subito, prima di qualunque attesa: una sincronizzazione già in coda vede `link` nullo e non manda più il token vero dopo il null.
  link = null
  ready = false
  lastSent = undefined
  lastTz = null
  clearListeners()
  usePush.getState().set({ token: null, tokenFailed: false, openRequest: null })
  if (unregister) {
    cached = null
    cacheLoaded = true
    saveCache()
  }
  if (unregister && current && wasReady) {
    await Promise.race([current.send({ type: 'device.push.set', token: null, platform: devicePlatform() }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, UNREGISTER_WAIT_MS))])
  }
  if (unregister && current) {
    try {
      await Notifications.unregisterForNotificationsAsync()
    } catch {
      // piattaforma o build che non lo supporta: nessun danno, il Mac non ha più il token
    }
  }
}

/** Chiave del Mac abbinato che ascolta i push (per riconoscere le notifiche del nostro Mac); null senza collegamento (e nella demo). */
export const pushMacKey = (): string | null => link?.macKey ?? null

// ── Notifiche già mostrate ──

/** Aprendo una sessione si tolgono dal Centro notifiche quelle che la riguardano. */
export async function clearSessionNotifications(sessionId: string): Promise<void> {
  try {
    const shown = await Notifications.getPresentedNotificationsAsync()
    await Promise.all(
      shown
        .filter((n) => {
          const data = n.request.content.data as { sessionId?: unknown } | undefined
          return data?.sessionId === sessionId
        })
        .map((n) => Notifications.dismissNotificationAsync(n.request.identifier))
    )
  } catch {
    // non disponibile: restano lì
  }
}

// ── Solo sviluppo ──

/**
 * Notifica locale con gli stessi `data` di un push vero: prova il tocco (Android senza credenziali FCM, simulatori) senza passare da Expo.
 * Arriva dopo `delayS` secondi (almeno 1): il tempo di mettere l'app in sfondo o di chiuderla.
 */
export async function devLocalNotification(opts: { kind: 'request' | 'turn' | 'error' | 'agents'; sessionId: string; itemId?: string | null; delayS?: number; mac?: string }): Promise<void> {
  if (!__DEV__) return
  const { pushMacId } = await import('@shared/remote/pairing')
  const macKey = pushMacKey()
  await ensureChannel()
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Ladder',
      body: t('A session needs you.'),
      data: { v: 1, kind: opts.kind, sessionId: opts.sessionId, itemId: opts.itemId ?? null, mac: opts.mac ?? (macKey ? pushMacId(macKey) : 'none') }
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: Math.max(1, opts.delayS ?? 1), channelId: REMOTE_PUSH_CHANNEL }
  })
}
