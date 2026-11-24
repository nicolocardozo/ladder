// Collega l'app a un "Mac": quello vero (RemoteClient sul canale cifrato) o quello della demo (FakeHost locale).
// Il resto dell'app vede solo lo store e `request`: stesso percorso nei due casi.
//
// Ogni avvio (startRemote, startDemo, disconnect) incrementa `generation` e ferma tutto ciò che c'era prima: un avvio che
// aspettava la cache e arriva tardi si accorge che il mondo è cambiato e si ritira, senza lasciare client o demo vivi.
import { AppState as RNAppState } from 'react-native'
import { getLocale } from '@shared/i18n'
import type { ChatItem, RemoteCommand, RemotePage, RemoteSnapshot, SubagentInfo } from '@shared/protocol'
import { FakeHost } from '@/demo/fake-host'
import { RemoteClient, type ConnState } from '@/remote/client'
import type { LinkFactory } from '@/remote/link'
import { wsLinkFactory } from '@/remote/ws-link'
import { useApp } from '@/store/app'
import { fromBase64Url } from '@/lib/pairing-url'
import { clearPairing, savePairing, type Pairing } from '@/store/pairing'
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

/** Collegamento di rete usato: sostituibile (relay con LAD-50) da chi avvia il client. */
export type LinkSource = (pairing: Pairing) => LinkFactory
let linkSource: LinkSource = (p) => wsLinkFactory(p.wsUrl)
export const setLinkSource = (source: LinkSource) => (linkSource = source)

const store = useApp

/** Ferma client, demo e timer, e invalida ogni avvio in corso. */
function stopAll(): number {
  generation++
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
 * Collega a un Mac vero. La modalità passa a 'remote' subito, prima di qualunque attesa: l'interfaccia non deve credere
 * che non ci sia nessun Mac (e rimandare alla schermata di benvenuto) mentre si legge la cache.
 */
export async function startRemote(pairing: Pairing): Promise<void> {
  const gen = stopAll()
  store.getState().reset()
  store.setState({ mode: 'remote', conn: { kind: 'connecting', since: Date.now() }, macName: pairing.macName ?? null })
  await readCache()
  if (gen !== generation) return
  unsubStore = store.subscribe((s, prev) => {
    if (s.items !== prev.items || s.sessions !== prev.sessions || s.projects !== prev.projects) scheduleCache()
  })
  client = new RemoteClient({
    createLink: linkSource(pairing),
    macPublicKey: fromBase64Url(pairing.macKey),
    device: pairing.device,
    locale: getLocale(),
    onEvent: (event) => store.getState().applyEvent(event),
    onState: (conn) => store.getState().setConn(conn),
    onHello: async (snapshot: RemoteSnapshot, hello) => {
      const s = store.getState()
      s.applySnapshot(snapshot)
      s.setMac(hello.mac)
      if (hello.mac !== pairing.macName) void savePairing({ ...pairing, macName: hello.mac })
      // Dopo (ri)connessione: di nuovo in ascolto sulle sessioni seguite e chat rilette ("Updating messages").
      await Promise.all(watched.map((id) => followNow(id).catch(() => {})))
    }
  })
  client.start()
}

export function startDemo(): void {
  stopAll()
  const s = store.getState()
  s.reset()
  demo = new FakeHost({ autoplay: true })
  s.setPermissionMax(demo.fixture.permissionMax)
  store.setState({ mode: 'demo', conn: { kind: 'connected', since: Date.now() }, macName: demo.fixture.macName, macTheme: null })
  s.applySnapshot(demo.snapshot())
  unsubDemo = demo.onEvent((event) => store.getState().applyEvent(event))
}

/**
 * Esce dalla demo o dimentica il Mac: ferma tutto e cancella ciò che era del Mac, abbinamento compreso (chiave e indirizzo
 * nel portachiavi), copia cifrata delle chat, bozze e sezioni aperte. Tema e lingua sono del telefono e restano.
 */
export async function disconnect(): Promise<void> {
  stopAll()
  store.getState().reset()
  store.setState({ mode: 'none', conn: { kind: 'connecting', since: Date.now() } })
  usePrefs.setState({ drafts: {}, collapsed: {} })
  await Promise.all([clearPairing().catch(() => {}), clearSecureCache()])
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
    if (state !== 'active' || !client) return
    if (!client.isReady) client.reconnectNow()
    else if (Date.now() - client.lastRx > STALE_AFTER_MS) void client.probe().then((snap) => snap && store.getState().applySnapshot(snap))
  })
  return () => sub.remove()
}
