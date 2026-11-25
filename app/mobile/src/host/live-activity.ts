// Live Activity e widget "Agent activity" sul telefono (LAD-93): il pezzo nativo (iOS). Ascolta il negozio e, con le preferenze,
// avvia, aggiorna e chiude le Live Activity (lib/live-activity.ts decide cosa) e scrive i dati del widget (lib/widget-snapshot.ts).
//
// Perché locale: Expo non sa mandare push ActivityKit (servono APNs e una chiave .p8, che il Mac non ha), e per principio nulla di una
// sessione passa da Expo, Apple o Google in chiaro. Quindi l'app avvia e aggiorna da sola, finché è viva. Con l'app sospesa iOS non le
// dà tempo: la Live Activity resta all'ultimo stato e, dopo `STALE_AFTER_MS` senza rinnovi, iOS la marca "non aggiornata"
// (isStale) senza bisogno dell'app. Stessa cosa per il widget (timeline a più voci). Nessun comando nuovo verso il Mac.
//
// Privacy: il widget scrive solo i numeri (al lavoro / in attesa); i titoli solo se l'utente lo accende (`widgetTitles`), e allora
// stanno fuori dalla cache cifrata. Gli attributi di una Live Activity stanno nell'archivio di sistema (ActivityKit): ci va il titolo
// della sessione che l'utente ha scelto di seguire.
import { requireOptionalNativeModule } from 'expo'
import { AppState, Platform } from 'react-native'
import { plural, t } from '@shared/i18n'
import { duration } from '@/lib/format'
import {
  END_AFTER_MS,
  STALE_AFTER_MS,
  describe,
  follows,
  livePhase,
  markDismissed,
  reconcile,
  type ActivityPhase,
  type ActivityProps,
  type ActivityText,
  type Item,
  type Op,
  type Tracks
} from '@/lib/live-activity'
import { onWorldReset } from '@/lib/world-reset'
import { buildSnapshot, snapshotKey, widgetTimeline, type WidgetText } from '@/lib/widget-snapshot'
import { useApp } from '@/store/app'
import { useLive } from '@/store/live'
import { usePrefs } from '@/store/prefs'

/** Questa build ha l'estensione (expo-widgets compilato nel target nativo): su Android, web e Expo Go no. */
export const liveActivitySupported = (): boolean => Platform.OS === 'ios' && !!requireOptionalNativeModule('ExpoWidgets')

const activityText = (): ActivityText => ({ running: t('Working'), waiting: t('Waiting for you'), done: t('Finished'), error: t('Error'), stale: t('Out of date') })
const widgetText = (): WidgetText => ({ working: t('working'), waiting: t('waiting'), quiet: t('All quiet'), updated: t('Updated'), open: t('Open Ladder'), offline: t('Offline') })
/** "Updated 12 min ago" / "Aggiornato 12 min fa", scritto qui: la timeline del widget porta già l'etichetta di ogni voce. */
const updatedAgo = (minutes: number): string => (minutes < 60 ? t('Updated {n} min ago', { n: minutes }) : t('Updated {n} h ago', { n: Math.floor(minutes / 60) }))

// ── Sessioni toccate da questo telefono ──

export function markOpened(sessionId: string): void {
  useLive.getState().mark(sessionId)
}
export const isOpened = (sessionId: string): boolean => !!useLive.getState().opened[sessionId]

// ── Live Activity ──

type Instance = {
  getId(): string
  update(props: ActivityProps, staleDate?: Date): Promise<void>
  end(policy?: 'default' | 'immediate' | { after: Date }, props?: ActivityProps, contentDate?: Date): Promise<void>
}
const instances = new Map<string, Instance>()
/** Finite ma ancora sullo schermo (restano qualche minuto): un turno nuovo della stessa sessione le toglie. */
const lingering = new Map<string, Instance>()
let tracks: Tracks = {}
/** Fase in cui è stata avviata ogni Live Activity: serve a ricordare la fase se l'utente la toglie. */
const phases = new Map<string, ActivityPhase>()
/** Da quando si è vista viva ogni sessione (cronometro se la chat non è in memoria). */
const liveSince = new Map<string, number>()
/** Ultimi passaggi e inizio noti: la chat può sparire dalla memoria un attimo, e il cronometro non deve saltare né i passaggi lampeggiare. */
const lastTurn = new Map<string, { steps: string | null; startedAt: number }>()
/** Avvio fallito (Live Activity spente in iOS, troppe): non si riprova a ogni cambio del negozio, ma al primo piano o a un cambio di preferenze. */
const failedStart = new Set<string>()
let chain: Promise<unknown> = Promise.resolve()
let timer: ReturnType<typeof setTimeout> | null = null
let started = false

const enqueue = (job: () => Promise<void>): void => {
  chain = chain.then(job).catch(() => {})
}

async function loadActivity() {
  return (await import('@/widgets/SessionActivity')).default
}

/** L'utente o iOS hanno tolto la Live Activity: il posto si libera e la sessione non riparte finché il turno non finisce. */
function dismissed(sessionId: string): void {
  instances.delete(sessionId)
  tracks = markDismissed(tracks, sessionId, phases.get(sessionId) ?? 'running', Date.now())
}

async function runOp(op: Op): Promise<void> {
  const activity = await loadActivity()
  const staleDate = new Date(Date.now() + STALE_AFTER_MS)
  if (op.type === 'start') {
    // Una Live Activity già lì per questa sessione (turno nuovo dopo la fine): via subito, ne parte una nuova.
    const old = lingering.get(op.sessionId) ?? instances.get(op.sessionId)
    lingering.delete(op.sessionId)
    if (old) await old.end('immediate').catch(() => {})
    try {
      instances.set(op.sessionId, activity.start(op.props, op.props.link, staleDate) as unknown as Instance)
      phases.set(op.sessionId, op.props.phase)
    } catch {
      // Live Activity spente nelle impostazioni di iOS, o troppe: nessun danno; si riprova al primo piano o a un cambio di preferenze.
      instances.delete(op.sessionId)
      delete tracks[op.sessionId]
      failedStart.add(op.sessionId)
    }
  } else if (op.type === 'update') {
    phases.set(op.sessionId, op.props.phase)
    try {
      await instances.get(op.sessionId)?.update(op.props, staleDate)
    } catch {
      // LiveActivityNotFound: tolta dall'utente o da iOS.
      dismissed(op.sessionId)
    }
  } else {
    const instance = instances.get(op.sessionId)
    instances.delete(op.sessionId)
    phases.delete(op.sessionId)
    if (!instance) return
    if (op.immediate || !op.props) await instance.end('immediate').catch(() => {})
    else {
      const { after } = await import('expo-widgets')
      lingering.set(op.sessionId, instance)
      await instance.end(after(new Date(Date.now() + END_AFTER_MS)), op.props).catch(() => {})
    }
  }
}

/** Primo piano: ciò che iOS o l'utente hanno tolto dallo schermo si dà per finito (posti liberi, niente riavvio immediato). */
async function syncInstances(): Promise<void> {
  const activity = await loadActivity()
  const alive = new Set(activity.getInstances().map((i: { getId(): string }) => i.getId()))
  for (const [id, instance] of [...instances]) if (!alive.has(instance.getId())) dismissed(id)
  for (const [id, instance] of [...lingering]) if (!alive.has(instance.getId())) lingering.delete(id)
}

/** Niente Mac (uscita dalla demo, "Forget", abbinamento revocato): ogni Live Activity, anche quella che resta qualche minuto, via subito. */
function endEverything(): void {
  const all = [...instances.values(), ...lingering.values()]
  instances.clear()
  lingering.clear()
  tracks = {}
  phases.clear()
  liveSince.clear()
  lastTurn.clear()
  failedStart.clear()
  if (all.length) enqueue(async () => void (await Promise.all(all.map((i) => i.end('immediate').catch(() => {})))))
}

function runActivities(): void {
  const app = useApp.getState()
  const prefs = usePrefs.getState()
  const now = Date.now()
  if (app.mode === 'none') {
    if (instances.size || lingering.size || Object.keys(tracks).length) endEverything()
    return
  }
  const opened = useLive.getState().opened
  const items: Item[] = []
  const text = activityText()
  for (const s of Object.values(app.sessions)) {
    if (s.archived) continue
    const phase = livePhase(s)
    if (phase !== 'idle' && !liveSince.has(s.id)) liveSince.set(s.id, now)
    if (follows(prefs.live, s.id, !!opened[s.id])) {
      const built = describe({
        session: s,
        project: app.projects.find((p) => p.id === s.projectId),
        items: app.items[s.id],
        phase: phase === 'idle' ? 'done' : phase,
        now,
        text,
        stepsLabel: (n) => plural(n, '{n} step', '{n} steps'),
        durationLabel: duration,
        seenSince: lastTurn.get(s.id)?.startedAt ?? liveSince.get(s.id) ?? now
      })
      // Con la chat in memoria si impara; senza, si riusa l'ultimo valore noto.
      if (app.items[s.id]?.length) lastTurn.set(s.id, { steps: built.steps, startedAt: built.startedAt })
      else if (built.steps === null && lastTurn.get(s.id)?.steps) built.steps = lastTurn.get(s.id)!.steps
      items.push({ id: s.id, phase, wants: true, props: built })
    }
    // Solo dopo aver composto le proprietà (la durata di un turno finito legge l'inizio): a sessione ferma si dimentica.
    if (phase === 'idle') {
      liveSince.delete(s.id)
      lastTurn.delete(s.id)
    }
  }
  // Si avvia solo con dati veri (Mac collegato, o demo che si finge connessa): mai da una copia in cache.
  const connected = app.conn.kind === 'connected'
  const out = reconcile(tracks, items, { now, connected, canStart: connected, blocked: failedStart })
  tracks = out.tracks
  for (const op of out.ops) enqueue(() => runOp(op))
}

// ── Widget ──

let lastSnapshot: { key: string; at: number } | null = null
/** Ultima volta che il Mac rispondeva (dati veri): "Updated N min ago" parte da qui, non dall'ultima scrittura. */
let lastConnectedAt: number | null = null
/** Anche senza novità, con il Mac collegato si riscrive ogni tanto: "aggiornato" resta vero finché l'app è viva. */
const WIDGET_REWRITE_MS = 4 * 60_000

async function writeWidget(timeline: unknown): Promise<void> {
  const widget = (await import('@/widgets/AgentActivityWidget')).default
  widget.updateTimeline(timeline as never)
}

function runWidget(force = false): void {
  const app = useApp.getState()
  const prefs = usePrefs.getState()
  const now = Date.now()
  if (app.mode === 'none' || !prefs.widget) {
    // Senza Mac (o con il widget spento) niente dati né titoli nel gruppo condiviso: il widget dice di aprire l'app.
    if (lastSnapshot?.key === 'cleared' && !force) return
    lastSnapshot = { key: 'cleared', at: now }
    lastConnectedAt = null
    enqueue(() => writeWidget([{ date: new Date(now), props: { text: widgetText() } }]))
    return
  }
  const connected = app.conn.kind === 'connected'
  if (connected) lastConnectedAt = now
  // Offline e mai collegati in questa esecuzione: si lascia ciò che c'era, senza fingere un'ora.
  if (!connected && lastConnectedAt === null) return
  const snap = buildSnapshot(Object.values(app.sessions), app.projects, now, connected, { showTitles: prefs.widgetTitles, updatedAt: lastConnectedAt ?? now })
  const key = snapshotKey(snap) + (prefs.widgetTitles ? 't' : '')
  const unchanged = lastSnapshot?.key === key
  // Offline non si riscrive per "ringiovanire": l'ora resta quella dell'ultima cosa vera.
  if (unchanged && !force && (!connected || now - lastSnapshot!.at < WIDGET_REWRITE_MS)) return
  lastSnapshot = { key, at: now }
  enqueue(() => writeWidget(widgetTimeline(snap, widgetText(), now, updatedAgo)))
}

// ── Ciclo ──

function run(): void {
  timer = null
  if (!liveActivitySupported()) return
  runActivities()
  runWidget()
}

/** Un solo passaggio dopo una raffica di eventi (il testo dell'agente arriva a pezzi): ogni update costa batteria e budget. */
function schedule(): void {
  if (timer || !started) return
  timer = setTimeout(run, 400)
}

/** "Forget" o nuovo Mac: le scelte per sessione e le sessioni "aperte" erano di quel Mac. */
onWorldReset(() => {
  useLive.getState().clear()
  const prefs = usePrefs.getState()
  if (Object.keys(prefs.live.overrides).length) usePrefs.setState({ live: { ...prefs.live, overrides: {} } })
})

/**
 * Parte con l'app (layout radice) e ascolta negozio, preferenze, lingua e AppState. Su Android o senza estensione non fa nulla.
 * Restituisce la funzione che smette.
 */
export function startLiveActivities(): () => void {
  if (!liveActivitySupported()) return () => {}
  started = true
  // Residui di un'esecuzione precedente (app chiusa con una Live Activity ancora sullo schermo): non sono più seguite da nessuno.
  enqueue(async () => {
    const activity = await loadActivity()
    for (const old of activity.getInstances()) await old.end('immediate').catch(() => {})
  })
  const subs = [
    useApp.subscribe((s, prev) => {
      if (s.sessions !== prev.sessions || s.projects !== prev.projects || s.items !== prev.items || s.conn !== prev.conn || s.mode !== prev.mode) schedule()
    }),
    useLive.subscribe(() => schedule()),
    usePrefs.subscribe((s, prev) => {
      if (s.live !== prev.live || s.widget !== prev.widget || s.widgetTitles !== prev.widgetTitles) {
        failedStart.clear()
        schedule()
      }
      // Cambio lingua: i testi del widget e delle Live Activity vivono nell'estensione, si riscrivono.
      if (s.language !== prev.language) {
        lastSnapshot = null
        schedule()
      }
    }),
    AppState.addEventListener('change', (state) => {
      if (state !== 'active') return
      lastSnapshot = null
      failedStart.clear()
      enqueue(syncInstances)
      enqueue(async () => run())
    })
  ]
  // Con l'app viva e il Mac collegato si rinnovano scadenza e widget ogni minuto (reconcile e runWidget decidono se serve).
  const tick = setInterval(() => AppState.currentState === 'active' && schedule(), 30_000)
  schedule()
  return () => {
    started = false
    subs.forEach((s) => ('remove' in s ? s.remove() : s()))
    clearInterval(tick)
    if (timer) clearTimeout(timer)
    timer = null
  }
}

/** Solo sviluppo: avvia subito una Live Activity per una sessione (demo), senza aspettare un turno. */
export function devStartActivity(sessionId: string, on = true): void {
  if (!__DEV__ || !liveActivitySupported()) return
  usePrefs.getState().setSessionFollow(sessionId, on ? 'on' : 'off')
  markOpened(sessionId)
  schedule()
}
