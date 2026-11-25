// Live Activity and "Agent activity" widget on the phone: the native (iOS) piece. It listens to the store and, with the preferences,
// starts, updates and ends Live Activities (lib/live-activity.ts decides what) and writes the widget data (lib/widget-snapshot.ts).
//
// Why local: Expo cannot send ActivityKit pushes (they need APNs and a .p8 key, which the Mac does not have), and as a rule nothing about a
// session goes through Expo, Apple or Google in the clear. So the app starts and updates by itself, while it is alive. With the app suspended iOS does not
// give it time: the Live Activity stays at its last state and, after `STALE_AFTER_MS` without renewals, iOS marks it "out of date"
// (isStale) without needing the app. Same for the widget (multi-entry timeline). No new command towards the Mac.
//
// Privacy: the widget only writes the numbers (working / waiting); titles only if the user turns them on (`widgetTitles`), and then
// they stay out of the encrypted cache. The attributes of a Live Activity live in the system store (ActivityKit): the title
// of the session the user chose to follow goes there.
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

/** This build has the extension (expo-widgets compiled into the native target): Android, web and Expo Go do not. */
export const liveActivitySupported = (): boolean => Platform.OS === 'ios' && !!requireOptionalNativeModule('ExpoWidgets')

const activityText = (): ActivityText => ({ running: t('Working'), waiting: t('Open request'), done: t('Finished'), error: t('Error'), stale: t('Out of date') })
const widgetText = (): WidgetText => ({ working: t('working'), waiting: t('to review'), quiet: t('All quiet'), updated: t('Updated'), open: t('Open Ladder'), offline: t('Offline') })
/** "Updated 12 min ago" / "Aggiornato 12 min fa", written here: the widget timeline already carries each entry's label. */
const updatedAgo = (minutes: number): string => (minutes < 60 ? t('Updated {n} min ago', { n: minutes }) : t('Updated {n} h ago', { n: Math.floor(minutes / 60) }))

// ── Sessions touched by this phone ──

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
/** Finished but still on screen (they stay a few minutes): a new turn of the same session removes them. */
const lingering = new Map<string, Instance>()
let tracks: Tracks = {}
/** Phase each Live Activity was started with: used to remember the phase if the user dismisses it. */
const phases = new Map<string, ActivityPhase>()
/** Since when each session was seen alive (stopwatch if the chat is not in memory). */
const liveSince = new Map<string, number>()
/** Last known steps and start: the chat may vanish from memory for a moment, and the stopwatch must not jump nor the steps flicker. */
const lastTurn = new Map<string, { steps: string | null; startedAt: number }>()
/** Start failed (Live Activities off in iOS, too many): not retried on every store change, but on foreground or a preferences change. */
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

/** The user or iOS dismissed the Live Activity: the slot is freed and the session does not restart until the turn ends. */
function dismissed(sessionId: string): void {
  instances.delete(sessionId)
  tracks = markDismissed(tracks, sessionId, phases.get(sessionId) ?? 'running', Date.now())
}

async function runOp(op: Op): Promise<void> {
  const activity = await loadActivity()
  const staleDate = new Date(Date.now() + STALE_AFTER_MS)
  if (op.type === 'start') {
    // A Live Activity already there for this session (new turn after the end): remove it right away, a new one starts.
    const old = lingering.get(op.sessionId) ?? instances.get(op.sessionId)
    lingering.delete(op.sessionId)
    if (old) await old.end('immediate').catch(() => {})
    try {
      instances.set(op.sessionId, activity.start(op.props, op.props.link, staleDate) as unknown as Instance)
      phases.set(op.sessionId, op.props.phase)
    } catch {
      // Live Activities off in iOS settings, or too many: no harm; retried on foreground or a preferences change.
      instances.delete(op.sessionId)
      delete tracks[op.sessionId]
      failedStart.add(op.sessionId)
    }
  } else if (op.type === 'update') {
    phases.set(op.sessionId, op.props.phase)
    try {
      await instances.get(op.sessionId)?.update(op.props, staleDate)
    } catch {
      // LiveActivityNotFound: dismissed by the user or by iOS.
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

/** Foreground: whatever iOS or the user removed from the screen is considered finished (free slots, no immediate restart). */
async function syncInstances(): Promise<void> {
  const activity = await loadActivity()
  const alive = new Set(activity.getInstances().map((i: { getId(): string }) => i.getId()))
  for (const [id, instance] of [...instances]) if (!alive.has(instance.getId())) dismissed(id)
  for (const [id, instance] of [...lingering]) if (!alive.has(instance.getId())) lingering.delete(id)
}

/** No Mac (leaving the demo, "Forget", revoked pairing): every Live Activity, even the one that stays a few minutes, goes away right away. */
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
      // With the chat in memory it is learned; without, the last known value is reused.
      if (app.items[s.id]?.length) lastTurn.set(s.id, { steps: built.steps, startedAt: built.startedAt })
      else if (built.steps === null && lastTurn.get(s.id)?.steps) built.steps = lastTurn.get(s.id)!.steps
      items.push({ id: s.id, phase, wants: true, props: built })
    }
    // Only after composing the properties (the duration of a finished turn reads the start): when the session stops it is forgotten.
    if (phase === 'idle') {
      liveSince.delete(s.id)
      lastTurn.delete(s.id)
    }
  }
  // Starts only with real data (Mac connected, or demo pretending to be connected): never from a cached copy.
  const connected = app.conn.kind === 'connected'
  const out = reconcile(tracks, items, { now, connected, canStart: connected, blocked: failedStart })
  tracks = out.tracks
  for (const op of out.ops) enqueue(() => runOp(op))
}

// ── Widget ──

let lastSnapshot: { key: string; at: number } | null = null
/** Last time the Mac answered (real data): "Updated N min ago" starts from here, not from the last write. */
let lastConnectedAt: number | null = null
/** Even without news, with the Mac connected it is rewritten every so often: "updated" stays true while the app is alive. */
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
    // Without a Mac (or with the widget off) no data or titles in the shared group: the widget says to open the app.
    if (lastSnapshot?.key === 'cleared' && !force) return
    lastSnapshot = { key: 'cleared', at: now }
    lastConnectedAt = null
    enqueue(() => writeWidget([{ date: new Date(now), props: { text: widgetText() } }]))
    return
  }
  const connected = app.conn.kind === 'connected'
  if (connected) lastConnectedAt = now
  // Offline and never connected in this run: what was there is left, without faking a time.
  if (!connected && lastConnectedAt === null) return
  const snap = buildSnapshot(Object.values(app.sessions), app.projects, now, connected, { showTitles: prefs.widgetTitles, updatedAt: lastConnectedAt ?? now })
  const key = snapshotKey(snap) + (prefs.widgetTitles ? 't' : '')
  const unchanged = lastSnapshot?.key === key
  // Offline it is not rewritten to "rejuvenate": the time stays that of the last true thing.
  if (unchanged && !force && (!connected || now - lastSnapshot!.at < WIDGET_REWRITE_MS)) return
  lastSnapshot = { key, at: now }
  enqueue(() => writeWidget(widgetTimeline(snap, widgetText(), now, updatedAgo)))
}

// ── Cycle ──

function run(): void {
  timer = null
  if (!liveActivitySupported()) return
  runActivities()
  runWidget()
}

/** A single pass after a burst of events (the agent's text arrives in chunks): every update costs battery and budget. */
function schedule(): void {
  if (timer || !started) return
  timer = setTimeout(run, 400)
}

/** "Forget" or new Mac: per-session choices and "open" sessions belonged to that Mac. */
onWorldReset(() => {
  useLive.getState().clear()
  const prefs = usePrefs.getState()
  if (Object.keys(prefs.live.overrides).length) usePrefs.setState({ live: { ...prefs.live, overrides: {} } })
})

/**
 * Starts with the app (root layout) and listens to store, preferences, language and AppState. On Android or without the extension it does nothing.
 * Returns the function that stops it.
 */
export function startLiveActivities(): () => void {
  if (!liveActivitySupported()) return () => {}
  started = true
  // Leftovers from a previous run (app closed with a Live Activity still on screen): nobody follows them any more.
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
      // Language change: widget and Live Activity texts live in the extension, they are rewritten.
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
  // With the app alive and the Mac connected, expiry and widget are renewed every minute (reconcile and runWidget decide whether it is needed).
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

/** Development only: starts a Live Activity for a session right away (demo), without waiting for a turn. */
export function devStartActivity(sessionId: string, on = true): void {
  if (!__DEV__ || !liveActivitySupported()) return
  usePrefs.getState().setSessionFollow(sessionId, on ? 'on' : 'off')
  markOpened(sessionId)
  schedule()
}
