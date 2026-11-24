// Collega l'app a un "Mac": quello vero (RemoteClient sul canale cifrato) o quello della demo (FakeHost locale).
// Il resto dell'app vede solo lo store e `request`: stesso percorso nei due casi.
//
// Ogni avvio (startRemote, startDemo, disconnect) incrementa `generation` e ferma tutto ciò che c'era prima: un avvio che
// aspettava la cache e arriva tardi si accorge che il mondo è cambiato e si ritira, senza lasciare client o demo vivi.
import { AppState as RNAppState } from 'react-native'
import { getLocale } from '@shared/i18n'
import type { ChatItem, RemoteAuthErrorCode, RemoteCommand, RemotePage, RemotePairingPayload, RemoteSnapshot, SubagentInfo } from '@shared/protocol'
import { fromBase64Url } from '@shared/remote/pairing'
import { FakeHost } from '@/demo/fake-host'
import { RemoteClient, type ConnState, type FirstMessage } from '@/remote/client'
import type { LinkFactory } from '@/remote/link'
import { relayLinkFactory } from '@/remote/relay-link'
import { wsLinkFactory } from '@/remote/ws-link'
import { useApp } from '@/store/app'
import { clearDeviceKey, clearPairing, devicePlatform, loadDeviceKey, savePairing, type Pairing } from '@/store/pairing'
import { usePrefs } from '@/store/prefs'
import { clearSecureCache, readSecureCache, writeSecureCache } from '@/store/secure-cache'

const MAX_WATCHED = 8
/** Quanto silenzio dal Mac, tornando in primo piano, prima di controllare che il collegamento sia ancora vivo. */
const STALE_AFTER_MS = 15_000

let client: RemoteClient | null = null
let demo: FakeHost | null = null
let unsubDemo: (() => void) | null = null
let unsubStore: (() => void) | null = null
let cacheTimer: ReturnType<typeof setTimeout> | null = null
let generation = 0
/** Sessioni seguite, la meno recente per prima: stesso limite dell'host (8). */
const watched: string[] = []

/** Dove si raggiunge il Mac: il relay se l'abbinamento lo ha, altrimenti il WebSocket locale (sviluppo). */
export function linkFor(route: { relay?: string; id?: string; ws?: string }): LinkFactory {
  if (route.relay && route.id) return relayLinkFactory(route.relay, route.id)
  if (route.ws) return wsLinkFactory(route.ws)
  throw new Error('No route to the Mac')
}

const store = useApp

/** Ferma client, demo e timer, e invalida ogni avvio in corso. */
function stopAll(): number {
  generation++
  // Un abbinamento in corso non sopravvive a un cambio di mondo (demo, scollegamento, nuovo avvio).
  pairingRun++
  pairingClient?.stop()
  pairingClient = null
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

// ── Copia locale cifrata: la chat resta leggibile senza connessione ──

async function writeCache(): Promise<void> {
  const s = store.getState()
  if (s.mode !== 'remote') return
  const recent = Object.values(s.sessions)
    .sort((a, b) => b.activityAt - a.activityAt)
    .slice(0, 15)
  const items: Record<string, ChatItem[]> = {}
  for (const x of recent) if (s.items[x.id]) items[x.id] = s.items[x.id].slice(-60)
  try {
    await writeSecureCache({ projects: s.projects, sessions: s.sessions, ui: s.ui, projectGroups: s.projectGroups, agents: s.agents, items, macName: s.macName, macTheme: s.macTheme })
  } catch {
    // portachiavi o archivio non disponibili: la prossima volta
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

// ── Avvio ──

/**
 * Il client reale. Con `global: true` (l'unico che resta aperto) alimenta lo store: eventi, stato della connessione, snapshot.
 * Un client di abbinamento (`global: false`) non scrive mai nello store e non guida la navigazione: il suo esito arriva solo
 * a chi ha chiesto di abbinare, così un tentativo fallito non può cambiare ciò che vede l'app né toccare l'abbinamento buono.
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
        // Dopo (ri)connessione: di nuovo in ascolto sulle sessioni seguite e chat rilette ("Updating messages").
        await Promise.all(watched.map((id) => followNow(id).catch(() => {})))
      }
    },
    opts.first
  )
}

/** Abbinamento da riprovare quando l'app torna in primo piano (il portachiavi non era leggibile all'avvio). */
let retryPairing: Pairing | null = null

/**
 * Collega a un Mac già abbinato (`auth` con l'id del dispositivo). La modalità passa a 'remote' subito, prima di qualunque
 * attesa: l'interfaccia non deve credere che non ci sia nessun Mac (e rimandare alla schermata di benvenuto) mentre si legge la cache.
 */
export async function startRemote(pairing: Pairing): Promise<void> {
  const gen = stopAll()
  retryPairing = null
  store.getState().reset()
  store.setState({ mode: 'remote', conn: { kind: 'connecting', since: Date.now() }, macName: pairing.macName })
  await readCache()
  if (gen !== generation) return
  let deviceKey: Awaited<ReturnType<typeof loadDeviceKey>>
  try {
    deviceKey = await loadDeviceKey(false)
  } catch {
    // Portachiavi non leggibile adesso (telefono appena acceso, bloccato): l'abbinamento non si tocca, si riprova al ritorno in primo piano.
    if (gen === generation) {
      retryPairing = pairing
      store.setState({ conn: { kind: 'unreachable', since: Date.now(), reason: 'Secure storage is not available' } })
    }
    return
  }
  if (gen !== generation) return
  if (!deviceKey) {
    // Abbinamento senza chiave del dispositivo (portachiavi ripristinato a metà): non si può autenticare, si riparte.
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
      // Revocato dal Mac (o firma non più valida): l'abbinamento non vale più. Si dimentica tutto e si mostra la schermata che lo spiega.
      if (conn.kind === 'revoked' && gen === generation) void forgetBecauseRevoked(pairing.macName)
    }
  })
  client.start()
}

async function forgetBecauseRevoked(macName: string): Promise<void> {
  await disconnect()
  store.setState({ conn: { kind: 'revoked' }, macName })
}

/** Esito di un tentativo di abbinamento, per la schermata che lo ha avviato. */
export type PairOutcome =
  | { ok: true }
  | { ok: false; kind: 'denied'; code: RemoteAuthErrorCode; error: string }
  | { ok: false; kind: 'key-changed' | 'unreachable' | 'mac-offline'; reason?: string }
  /** Il telefono non ha potuto leggere o salvare le sue chiavi (portachiavi). */
  | { ok: false; kind: 'storage' }

/** Quanto si aspetta un Mac che non risponde, durante l'abbinamento, prima di arrendersi. */
const PAIR_GIVE_UP_MS = 20_000

/** Il client dell'abbinamento in corso (uno solo alla volta) e il suo numero, per scartare gli esiti di uno vecchio. */
let pairingClient: RemoteClient | null = null
let pairingRun = 0

/**
 * Primo abbinamento: handshake, `pair` firmato con la chiave del dispositivo. Non tocca la connessione esistente né lo store
 * finché non riesce: se il Mac accetta, si salva l'abbinamento (e si aspetta che sia salvato davvero) e poi parte la connessione
 * normale con `auth` (`startRemote`), come a ogni avvio. Il codice monouso e la password restano in memoria, mai nei log.
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
      // Il client dell'abbinamento ha fatto il suo (o ha fallito): si ferma sempre. Se è riuscito, il resto lo fa startRemote.
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
              // Salvato: da qui è un abbinamento come gli altri, con la sua connessione `auth` (e la sua gestione di revoca e chiave cambiata).
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
 * Esce dalla demo o dimentica il Mac: ferma tutto e cancella ciò che era del Mac, abbinamento e chiave del dispositivo
 * compresi (chiavi nel portachiavi), copia cifrata delle chat, bozze e sezioni aperte. Tema e lingua sono del telefono e restano.
 */
export async function disconnect(): Promise<void> {
  stopAll()
  store.getState().reset()
  store.setState({ mode: 'none', conn: { kind: 'connecting', since: Date.now() } })
  usePrefs.setState({ drafts: {}, collapsed: {} })
  await Promise.all([clearPairing().catch(() => {}), clearDeviceKey().catch(() => {}), clearSecureCache()])
}

export function retryNow(): void {
  client?.reconnectNow()
}

// ── Comandi ──

export async function request<T = unknown>(command: RemoteCommand): Promise<T> {
  if (demo) return (await demo.handle(command)) as T
  if (!client) throw new Error('offline')
  return client.request<T>(command)
}

/** Le azioni dell'utente sono permesse solo a collegamento pieno (anche nella demo). */
export const canAct = (conn: ConnState = store.getState().conn): boolean => conn.kind === 'connected'

/** Si può già parlare con il Mac (anche durante "Updating messages"): serve a seguire le sessioni. */
const isReady = (): boolean => !!demo || !!client?.isReady

// ── Sessioni seguite ──

async function followNow(sessionId: string): Promise<void> {
  await request({ type: 'session.watch', sessionId, on: true })
  const page = await request<RemotePage>({ type: 'session.page', sessionId })
  store.getState().mergeItems(sessionId, page.items, { replace: true, hasMore: page.hasMore })
  void request<SubagentInfo[]>({ type: 'subagent.list', sessionId })
    .then((list) => store.setState((s) => ({ subagents: { ...s.subagents, [sessionId]: list } })))
    .catch(() => {})
}

/**
 * Segue la sessione (chat in diretta) e carica l'ultima pagina; fino a 8 insieme, la meno recente smette.
 * Se il canale non è ancora pronto l'iscrizione resta in lista e la fa `onHello` appena il Mac risponde.
 */
export async function follow(sessionId: string): Promise<void> {
  const at = watched.indexOf(sessionId)
  if (at >= 0) watched.splice(at, 1)
  watched.push(sessionId)
  if (watched.length > MAX_WATCHED) watched.shift()
  if (!isReady()) {
    // Offline: la chat resta quella della copia locale.
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
 * App in primo piano: senza collegamento si riprova subito; con un collegamento che tace da un po' lo si controlla
 * (un socket morto in silenzio non deve restare "Connected").
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
