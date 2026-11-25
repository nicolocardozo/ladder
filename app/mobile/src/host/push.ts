// Push notifications on the phone. The Mac sends a generic push when you are not using it; this is the phone's side:
//  - system permission and Android channel "sessions";
//  - Expo token → `device.push.set` (null if the permission is missing or was revoked);
//  - preferences → `device.notify.set` on every connection and every change;
//  - foreground / background → `device.state` on every AppState change and every 20 seconds while in the foreground;
//  - a tap on a notification is handled in push-taps.ts.
// It does not import the controller (no cycles): the controller provides `send` with `startPush` and signals with `pushLinkReady`.
// It never starts in the demo: no permission, no token, no commands.
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

/** Foreground state heartbeat: the Mac considers it alive for 30 seconds. */
const HEARTBEAT_MS = 20_000
/** How long the Mac is waited for when disconnecting, before giving up (the token stays there, but that is fine: a push to a removed token does not arrive). */
const UNREGISTER_WAIT_MS = 1_500

let link: { send: Send; macKey: string } | null = null
let ready = false
let subs: { remove(): void }[] = []
let heartbeat: ReturnType<typeof setInterval> | null = null
let notifyTimer: ReturnType<typeof setTimeout> | null = null
/** Serializes token and permission: one round at a time, so two close events do not overlap. */
let chain: Promise<unknown> = Promise.resolve()
const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
  const next = chain.then(job, job)
  chain = next.catch(() => {})
  return next
}

// ── Initial setup (once, at app start) ──

/**
 * With the app in the foreground events are seen live and the Mac does not send the push: if one arrives anyway (silent connection),
 * no banner and no sound. On iOS it stays in the Notification Center (`shouldShowList`); on Android it is not shown at all, because there
 * the list coincides with the heads-up of the high-importance channel.
 * No badge: Ladder does not set one (pushes carry no count and the phone does not recompute it with the app closed).
 */
export function configureNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: Platform.OS === 'ios', shouldPlaySound: false, shouldSetBadge: false })
  })
  void ensureChannel()
}

/** Android push channel (high importance, translated name). Can be called again: it updates the name if the language changes. */
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
    // the channel could not be created: notifications use the default one
  }
}

// ── Permission ──

function permissionOf(status: Notifications.NotificationPermissionsStatus): { permission: PushPermission; canAsk: boolean } {
  if (status.granted) return { permission: 'granted', canAsk: false }
  return { permission: status.status === 'undetermined' ? 'undetermined' : 'denied', canAsk: status.canAskAgain }
}

/** Notification state as shown by Settings and the Notifications screen: on, off (permission missing or denied) or not configured (build without credentials). */
export function pushStatusLabel(permission: PushPermission, tokenFailed: boolean): string {
  if (permission !== 'granted') return t('Off')
  return tokenFailed ? t('Not set up') : t('On')
}

/** Re-reads the system permission (also after the user went through the settings). */
export async function refreshPermission(): Promise<PushPermission> {
  try {
    const { permission, canAsk } = permissionOf(await Notifications.getPermissionsAsync())
    usePush.getState().set({ permission, canAsk })
    return permission
  } catch {
    return usePush.getState().permission
  }
}

/** Asks for the permission (system dialog) and, if granted, registers the token and sends it to the Mac. In the demo it does nothing. */
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
  // The token is registered in the background: the caller can proceed as soon as the permission is known.
  void syncToken(true)
  return usePush.getState().permission
}

/** Opens Ladder's system settings (permission denied). */
export function openSystemSettings(): void {
  void Linking.openSettings().catch(() => {})
}

// ── Token ──

const projectId = (): string | undefined => {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId
}

const TOKEN_KEY = 'ladder.push-token.v1'
/** Last good Expo token, with the system token it corresponds to: requested again only if the permission or that token changes. */
let cached: { token: string; device: string | null } | null = null
let cacheLoaded = false
/** Last system token (APNs / FCM) seen: events with the same value are not news. */
let lastDeviceToken: string | null = null
/** Consecutive transient errors: "not configured" only after a few attempts, never on the first network hiccup. */
let transientFailures = 0

async function loadCache(): Promise<void> {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const raw = await SecureStore.getItemAsync(TOKEN_KEY)
    const parsed = raw ? (JSON.parse(raw) as { token?: unknown; device?: unknown }) : null
    if (parsed && typeof parsed.token === 'string' && parsed.token.length > 0) cached = { token: parsed.token, device: typeof parsed.device === 'string' ? parsed.device : null }
  } catch {
    // keychain not readable: the round is redone
  }
}

const saveCache = (): void => {
  void (cached ? SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(cached), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }) : SecureStore.deleteItemAsync(TOKEN_KEY)).catch(() => {})
}

/**
 * The current Expo token:
 *  - string: to send to the Mac;
 *  - null: no token (permission missing or revoked, build without push credentials): null goes to the Mac;
 *  - undefined: unknown (transient error): nothing is sent to the Mac and the last good one stays.
 * `device`: the system token just received from the event; used to avoid requesting it again (and re-emitting the event).
 */
async function currentToken(device?: string): Promise<string | null | undefined> {
  await loadCache()
  const permission = await refreshPermission()
  if (permission !== 'granted') {
    usePush.getState().set({ token: null, tokenFailed: false })
    return null
  }
  // Nothing new (same permission, same system token): the one already good applies.
  if (cached && cachedTokenStillValid(cached, device)) {
    usePush.getState().set({ token: cached.token, tokenFailed: false })
    return cached.token
  }
  try {
    const id = projectId()
    // With the system token already in hand `devicePushToken` is passed: Expo does not request it again (requesting it re-emits the token event).
    const { data } = await Notifications.getExpoPushTokenAsync({ ...(id ? { projectId: id } : {}), ...(device ? { devicePushToken: { type: Platform.OS === 'ios' ? 'ios' : 'android', data: device } } : {}) })
    cached = { token: data, device: device ?? lastDeviceToken }
    saveCache()
    transientFailures = 0
    usePush.getState().set({ token: data, tokenFailed: false })
    return data
  } catch (error) {
    if (isTransientTokenError(error)) {
      // Network or server: the last good token is kept (if any) and retried at the next chance; "not configured" only if it persists.
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
 * Delivers the token (or null) to the Mac. `always`: even if unchanged (on every new connection); otherwise only if different
 * from the last one sent on this connection. With the permission revoked it sends null, so the Mac stops trying to notify.
 */
let lastSent: string | null | undefined
function syncToken(always: boolean, device?: string): Promise<void> {
  return enqueue(async () => {
    if (!link) return
    const token = await currentToken(device)
    // After the wait the connection may have changed or ended (stopPush): no late sends.
    if (token === undefined || !link || !ready) return
    if (!always && lastSent === token) return
    try {
      await link.send({ type: 'device.push.set', token, platform: devicePlatform() })
      lastSent = token
    } catch {
      // without a connection: pushLinkReady redoes it on the next connection
    }
  })
}

// ── Preferences and state ──

/** Time zone sent with the latest preferences: if the phone changes zone (travel) the quiet hours must be sent again. */
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

// ── Lifecycle ──

/**
 * Starts with the connection to the Mac (not in the demo). Listens to token, AppState and preference changes, but sends nothing until
 * the link is ready (`pushLinkReady`).
 */
export function startPush(send: Send, macKey: string): void {
  clearListeners()
  link = { send, macKey }
  ready = false
  lastSent = undefined
  lastTz = null
  transientFailures = 0
  subs.push(
    // The system token changed (reinstall, renewal): the Expo one must be requested again, with the received token.
    // Requesting the Expo token re-emits this same event: one with the same value as the last seen is not news.
    Notifications.addPushTokenListener((token) => {
      if (typeof token.data !== 'string' || token.data === lastDeviceToken) return
      lastDeviceToken = token.data
      void syncToken(false, token.data)
    }),
    AppState.addEventListener('change', (state) => {
      void sendState()
      if (state !== 'active') return
      // Back in the foreground the permission may have been changed from system settings (token or null accordingly)
      // and the phone may have changed time zone (quiet hours are evaluated in its zone).
      void syncToken(false)
      if (lastTz !== null && phoneTimeZone() !== lastTz) void sendNotify()
    }),
    {
      remove: usePrefs.subscribe((s, prev) => {
        if (s.notify === prev.notify) return
        // One switch after another: the last state is sent, not every step.
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

/** The link to the Mac is ready (after every hello, also after a reconnection): token, preferences and state. */
export function pushLinkReady(): void {
  if (!link) return
  ready = true
  lastSent = undefined
  // One after the other and queued: the three sends do not add to the sync requests in the client's bucket.
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
 * Stops: halts listeners and heartbeat. With `unregister` (the user disconnects the Mac) it first sends `device.push.set` with null, if the
 * link was there, and removes the system registration; with a pairing revoked by the Mac there is no link and stopping is enough.
 */
export async function stopPush(unregister: boolean): Promise<void> {
  const current = link
  const wasReady = ready
  // Right away, before any wait: a sync already queued sees a null `link` and no longer sends the real token after the null.
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
      // platform or build that does not support it: no harm, the Mac no longer has the token
    }
  }
}

/** Key of the paired Mac that listens to pushes (to recognize our Mac's notifications); null without a link (and in the demo). */
export const pushMacKey = (): string | null => link?.macKey ?? null

// ── Notifications already shown ──

/** Opening a session removes the notifications about it from the Notification Center. */
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
    // not available: they stay there
  }
}

// ── Development only ──

/**
 * Local notification with the same `data` as a real push: tests the tap (Android without FCM credentials, simulators) without going through Expo.
 * Arrives after `delayS` seconds (at least 1): time to put the app in the background or close it.
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
