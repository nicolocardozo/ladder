// Connects the app to a "Mac": the real one (RemoteClient on the encrypted channel) or the demo one (local FakeHost).
// The rest of the app only sees the store and `request`: same path in both cases.
//
// Every start (startRemote, startDemo, disconnect) increments `generation` and stops everything that came before: a start that
// was waiting for the cache and arrives late notices the world has changed and backs off, leaving no client or demo alive.
import { AppState as RNAppState } from 'react-native'
import { getLocale } from '@shared/i18n'
import type { ChatItem, RemoteAuthErrorCode, RemoteCommand, RemotePage, RemotePairingPayload, RemoteSnapshot, SubagentInfo } from '@shared/protocol'
import { fromBase64Url } from '@shared/remote/pairing'
import { FakeHost } from '@/demo/fake-host'
import { pushLinkReady, startPush, stopPush } from '@/host/push'
import { RemoteClient, type ConnState, type FirstMessage } from '@/remote/client'
import type { LinkFactory } from '@/remote/link'
import { relayLinkFactory } from '@/remote/relay-link'
import { wsLinkFactory } from '@/remote/ws-link'
import { useApp } from '@/store/app'
import { clearDeviceKey, clearPairing, devicePlatform, loadDeviceKey, savePairing, type Pairing } from '@/store/pairing'
import { usePrefs } from '@/store/prefs'
import { clearSecureCache, readSecureCache, writeSecureCache } from '@/store/secure-cache'

const MAX_WATCHED = 8
/** How much silence from the Mac, on returning to the foreground, before checking the connection is still alive. */
const STALE_AFTER_MS = 15_000

let client: RemoteClient | null = null
let demo: FakeHost | null = null
let unsubDemo: (() => void) | null = null
let unsubStore: (() => void) | null = null
let cacheTimer: ReturnType<typeof setTimeout> | null = null
let generation = 0
/** Followed sessions, least recent first: same limit as the host (8). */
const watched: string[] = []

/** Where the Mac is reached: the relay if the pairing has one, otherwise the local WebSocket (development). */
export function linkFor(route: { relay?: string; id?: string; ws?: string }): LinkFactory {
  if (route.relay && route.id) return relayLinkFactory(route.relay, route.id)
  if (route.ws) return wsLinkFactory(route.ws)
  throw new Error('No route to the Mac')
}

const store = useApp

/** Stops client, demo and timers, and invalidates any start in progress. */
function stopAll(): number {
  generation++
  // A pairing in progress does not survive a change of world (demo, disconnection, new start).
  pairingRun++
  pairingClient?.stop()
  pairingClient = null
  // Notifications follow the connection: without a client (or in the demo) nothing is listened to or sent.
  void stopPush(false)
  client?.stop()
  client = null
  unsubDemo?.()
  unsubDemo = null
  demo?.dispose()
  demo = null
  unsubStore?.()
  unsubStore = null
  if (cacheTimer) clearTimeout(cacheTimer)
  cacheTimer = null
  watched.length = 0
  return generation
}

// ── Encrypted local copy: the chat stays readable offline ──

async function writeCache(): Promise<void> {
  const s = store.getState()
  if (s.mode !== 'remote') return
  const recent = Object.values(s.sessions)
    .sort((a, b) => b.activityAt - a.activityAt)
    .slice(0, 15)
  const items: Record<string, ChatItem[]> = {}
  for (const x of recent) if (s.items[x.id]) items[x.id] = s.items[x.id].slice(-60)
  try {
    await writeSecureCache({ projects: s.projects, sessions: s.sessions, ui: s.ui, projectGroups: s.projectGroups, agents: s.agents, profiles: s.profiles, defaults: s.defaults, permissionsMax: s.permissionsMax, items, macName: s.macName, macTheme: s.macTheme })
  } catch {
    // keychain or storage unavailable: next time
  }
}

async function readCache(): Promise<void> {
  const data = await readSecureCache<Parameters<ReturnType<typeof useApp.getState>['restore']>[0]>()
  if (data) store.getState().restore(data)
}

function scheduleCache(): void {
  if (cacheTimer) return
  cacheTimer = setTimeout(() => {
    cacheTimer = null
    void writeCache()
  }, 2_000)
}

// ── Start ──

/**
 * The real client. With `global: true` (the only one that stays open) it feeds the store: events, connection state, snapshot.
 * A pairing client (`global: false`) never writes to the store and does not drive navigation: its outcome only goes
 * to whoever asked to pair, so a failed attempt cannot change what the app shows or touch the good pairing.
 */
function makeClient(opts: {
  global: boolean
  pairing: Pick<Pairing, 'macKey' | 'relay' | 'id' | 'ws'>
  deviceKey: { secretKey: Uint8Array; publicKey: Uint8Array }
  first: FirstMessage
  deviceLabel: string
  onAuthenticated?: (deviceId: string, name: string, macName: string) => void
  onState?: (conn: ConnState) => void
}): RemoteClient {
  return new RemoteClient(
    {
      createLink: linkFor(opts.pairing),
      macPublicKey: fromBase64Url(opts.pairing.macKey),
      deviceKey: opts.deviceKey,
      deviceLabel: opts.deviceLabel,
      locale: getLocale(),
      onEvent: (event) => {
        if (opts.global) store.getState().applyEvent(event)
      },
      onState: (conn) => {
        if (opts.global) store.getState().setConn(conn)
        opts.onState?.(conn)
      },
      onAuthenticated: (result, hello) => {
        if (opts.global) store.getState().setAllowFull(result.allowFull)
        opts.onAuthenticated?.(result.deviceId, result.name, hello.mac)
      },
      onHello: async (snapshot: RemoteSnapshot, hello) => {
        if (!opts.global) return
        const s = store.getState()
        s.applySnapshot(snapshot)
        s.setMac(hello.mac)
        // After (re)connection: listen again to followed sessions and re-read chats ("Updating messages").
        await Promise.all(watched.map((id) => followNow(id).catch(() => {})))
        // Token, preferences and (foreground) state of notifications, on every connection: after the re-reads, which fill the client's
        // request bucket, and without waiting for them (they do not slow down "connected").
        pushLinkReady()
      }
    },
    opts.first
  )
}

/** Pairing to retry when the app returns to the foreground (the keychain was not readable at launch). */
let retryPairing: Pairing | null = null

/**
 * Connects to an already paired Mac (`auth` with the device id). The mode switches to 'remote' immediately, before any
 * wait: the UI must not believe there is no Mac (and send back to the welcome screen) while the cache is being read.
 */
export async function startRemote(pairing: Pairing): Promise<void> {
  const gen = stopAll()
  retryPairing = null
  store.getState().reset()
  store.setState({ mode: 'remote', conn: { kind: 'connecting', since: Date.now() }, macName: pairing.macName })
  // Before any wait: on a notification tap (app just opened) the paired Mac is already known.
  startPush((command) => (client ? client.request(command) : Promise.reject(new Error('offline'))), pairing.macKey)
  await readCache()
  if (gen !== generation) return
  let deviceKey: Awaited<ReturnType<typeof loadDeviceKey>>
  try {
    deviceKey = await loadDeviceKey(false)
  } catch {
    // Keychain not readable right now (phone just powered on, locked): the pairing is left alone, retried on return to the foreground.
    if (gen === generation) {
      retryPairing = pairing
      store.setState({ conn: { kind: 'unreachable', since: Date.now(), reason: 'Secure storage is not available' } })
    }
    return
  }
  if (gen !== generation) return
  if (!deviceKey) {
    // Pairing without a device key (keychain half-restored): cannot authenticate, start over.
    await disconnect()
    return
  }
  unsubStore = store.subscribe((s, prev) => {
    if (s.items !== prev.items || s.sessions !== prev.sessions || s.projects !== prev.projects) scheduleCache()
  })
  client = makeClient({
    global: true,
    pairing,
    deviceKey,
    first: { mode: 'auth', deviceId: pairing.deviceId },
    deviceLabel: pairing.deviceName,
    onAuthenticated: (_id, _name, macName) => {
      if (macName !== pairing.macName) void savePairing({ ...pairing, macName }).catch(() => {})
    },
    onState: (conn) => {
      // Revoked by the Mac (or signature no longer valid): the pairing no longer applies. Everything is forgotten and the screen explaining it is shown.
      if (conn.kind === 'revoked' && gen === generation) void forgetBecauseRevoked(pairing.macName)
    }
  })
  client.start()
}

async function forgetBecauseRevoked(macName: string): Promise<void> {
  await disconnect()
  store.setState({ conn: { kind: 'revoked' }, macName })
}

/** Outcome of a pairing attempt, for the screen that started it. */
export type PairOutcome =
  | { ok: true }
  | { ok: false; kind: 'denied'; code: RemoteAuthErrorCode; error: string }
  | { ok: false; kind: 'key-changed' | 'unreachable' | 'mac-offline'; reason?: string }
  /** The phone could not read or save its keys (keychain). */
  | { ok: false; kind: 'storage' }

/** How long a Mac that does not answer is waited for, during pairing, before giving up. */
const PAIR_GIVE_UP_MS = 20_000

/** The client of the pairing in progress (only one at a time) and its number, to discard the outcomes of an old one. */
let pairingClient: RemoteClient | null = null
let pairingRun = 0

/**
 * First pairing: handshake, `pair` signed with the device key. It touches neither the existing connection nor the store
 * until it succeeds: if the Mac accepts, the pairing is saved (and we wait until it is really saved) and then the normal
 * connection with `auth` starts (`startRemote`), as on every launch. The one-time code and the password stay in memory, never in logs.
 */
export async function startPairing(payload: RemotePairingPayload, opts: { password?: string; deviceName: string }): Promise<PairOutcome> {
  const run = ++pairingRun
  pairingClient?.stop()
  pairingClient = null
  let deviceKey: Awaited<ReturnType<typeof loadDeviceKey>>
  try {
    deviceKey = await loadDeviceKey(true)
  } catch {
    return { ok: false, kind: 'storage' }
  }
  if (run !== pairingRun) return { ok: false, kind: 'unreachable' }
  if (!deviceKey) return { ok: false, kind: 'storage' }
  return new Promise<PairOutcome>((resolve) => {
    let settled = false
    let current: RemoteClient | null = null
    let lastConn: ConnState | null = null
    const finish = (outcome: PairOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(giveUp)
      // The pairing client has done its job (or failed): it always stops. If it succeeded, startRemote does the rest.
      current?.stop()
      if (pairingClient === current) pairingClient = null
      resolve(outcome)
    }
    const giveUp = setTimeout(() => finish({ ok: false, kind: lastConn?.kind === 'mac-offline' ? 'mac-offline' : 'unreachable', reason: lastConn && 'reason' in lastConn ? lastConn.reason : undefined }), PAIR_GIVE_UP_MS)
    try {
      current = makeClient({
        global: false,
        pairing: { macKey: payload.key, relay: payload.relay, id: payload.id, ws: payload.ws },
        deviceKey,
        first: { mode: 'pair', token: payload.token, ...(opts.password ? { password: opts.password } : {}), device: { name: opts.deviceName, platform: devicePlatform() } },
        deviceLabel: opts.deviceName,
        onAuthenticated: (deviceId, name, macName) => {
          if (run !== pairingRun || settled) return
          const pairing: Pairing = { macName: macName || payload.mac, macKey: payload.key, relay: payload.relay, id: payload.id, ws: payload.ws, deviceId, deviceName: name }
          savePairing(pairing).then(
            () => {
              if (run !== pairingRun || settled) return
              // Saved: from here it is a pairing like any other, with its own `auth` connection (and its handling of revocation and changed key).
              void startRemote(pairing)
              finish({ ok: true })
            },
            () => finish({ ok: false, kind: 'storage' })
          )
        },
        onState: (conn) => {
          if (run !== pairingRun) return
          lastConn = conn
          if (conn.kind === 'denied') finish({ ok: false, kind: 'denied', code: conn.code, error: conn.error })
          else if (conn.kind === 'key-changed') finish({ ok: false, kind: 'key-changed' })
        }
      })
    } catch {
      return finish({ ok: false, kind: 'unreachable' })
    }
    pairingClient = current
    current.start()
  })
}

export function startDemo(): void {
  stopAll()
  const s = store.getState()
  s.reset()
  demo = new FakeHost({ autoplay: true })
  store.setState({ mode: 'demo', conn: { kind: 'connected', since: Date.now() }, macName: demo.fixture.macName, macTheme: null })
  s.applySnapshot(demo.snapshot())
  unsubDemo = demo.onEvent((event) => store.getState().applyEvent(event))
}

/**
 * Leaves the demo or forgets the Mac: stops everything and deletes whatever belonged to the Mac, pairing and device key
 * included (keys in the keychain), encrypted copy of chats, drafts and open sections. Theme and language belong to the phone and stay.
 */
export async function disconnect(): Promise<void> {
  // Before stopping the client: if the connection is still there, the Mac receives the null token and stops notifying this phone.
  await stopPush(true)
  stopAll()
  store.getState().reset()
  store.setState({ mode: 'none', conn: { kind: 'connecting', since: Date.now() } })
  usePrefs.setState({ drafts: {}, collapsed: {}, lastProject: null })
  await Promise.all([clearPairing().catch(() => {}), clearDeviceKey().catch(() => {}), clearSecureCache()])
}

/** Development only: sets the demo's usage limits to a scenario (screenshots and tests). */
export function devUsage(scenario: Parameters<FakeHost['setUsage']>[0]): void {
  demo?.setUsage(scenario)
}

export function retryNow(): void {
  client?.reconnectNow()
}

// ── Commands ──

export async function request<T = unknown>(command: RemoteCommand): Promise<T> {
  if (demo) return (await demo.handle(command)) as T
  if (!client) throw new Error('offline')
  return client.request<T>(command)
}

/** User actions are only allowed with a full connection (also in the demo). */
export const canAct = (conn: ConnState = store.getState().conn): boolean => conn.kind === 'connected'

/** The Mac can already be talked to (also during "Updating messages"): needed to follow sessions. */
const isReady = (): boolean => !!demo || !!client?.isReady

// ── Followed sessions ──

async function followNow(sessionId: string): Promise<void> {
  await request({ type: 'session.watch', sessionId, on: true })
  const page = await request<RemotePage>({ type: 'session.page', sessionId })
  store.getState().mergeItems(sessionId, page.items, { replace: true, hasMore: page.hasMore })
  void request<SubagentInfo[]>({ type: 'subagent.list', sessionId })
    .then((list) => store.setState((s) => ({ subagents: { ...s.subagents, [sessionId]: list } })))
    .catch(() => {})
}

/**
 * Follows the session (live chat) and loads the last page; up to 8 together, the least recent stops.
 * If the channel is not ready yet the subscription stays in the list and `onHello` performs it as soon as the Mac answers.
 */
export async function follow(sessionId: string): Promise<void> {
  const at = watched.indexOf(sessionId)
  if (at >= 0) watched.splice(at, 1)
  watched.push(sessionId)
  if (watched.length > MAX_WATCHED) watched.shift()
  if (!isReady()) {
    // Offline: the chat stays the one from the local copy.
    store.setState((st) => ({ loaded: { ...st.loaded, [sessionId]: true } }))
    return
  }
  await followNow(sessionId)
}

export async function loadOlder(sessionId: string): Promise<void> {
  const s = store.getState()
  const list = s.items[sessionId]
  if (!list?.length || !s.hasMore[sessionId]) return
  const page = await request<RemotePage>({ type: 'session.page', sessionId, before: list[0].seq })
  store.getState().mergeItems(sessionId, page.items, { hasMore: page.hasMore })
}

/**
 * App in the foreground: without a connection it retries immediately; with a connection that has been silent for a while it is checked
 * (a silently dead socket must not stay "Connected").
 */
export function installForegroundHook(): () => void {
  const sub = RNAppState.addEventListener('change', (state) => {
    if (state === 'active' && !client && retryPairing && !demo) return void startRemote(retryPairing)
    if (state !== 'active' || !client) return
    if (!client.isReady) client.reconnectNow()
    else if (Date.now() - client.lastRx > STALE_AFTER_MS) void client.probe().then((snap) => snap && store.getState().applySnapshot(snap))
  })
  return () => sub.remove()
}
