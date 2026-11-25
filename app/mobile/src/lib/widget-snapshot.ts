// Data of the "Agent activity" widget: how many sessions are working, how many are waiting for you and the titles of the waiting ones.
// The app writes them (in the shared group, where the extension reads them) on every state change; the widget has no network.
// Pure logic only, tested with node --test.
import type { Project, SessionSummary } from '../../../desktop/src/shared/protocol.ts'
import { sessionState } from './session-state.ts'

/** After so long without updates the widget no longer says something is working: it shows "Updated 12 min ago". */
export const WIDGET_STALE_AFTER_MS = 10 * 60_000
/** How many waiting titles are shown (the medium widget has room for three). */
export const WIDGET_TOP = 3

export interface WidgetTop {
  id: string
  title: string
  project: string
}

export interface WidgetSnapshot {
  /** When the app wrote it (ms). */
  updatedAt: number
  /** The Mac responds: without it, the numbers are the last thing known. */
  connected: boolean
  working: number
  waiting: number
  /** Waiting sessions, oldest first: titles live only on the phone, in this shared group. */
  top: WidgetTop[]
}

export interface SnapshotOptions {
  /** Also write titles and projects (off by default): outside the encrypted cache, and in backups. When off, no title is written. */
  showTitles?: boolean
  /** Time to write: that of the last time the Mac responded. Without it, `now`. */
  updatedAt?: number
}

export function buildSnapshot(sessions: SessionSummary[], projects: Project[], now: number, connected: boolean, opts: SnapshotOptions = {}): WidgetSnapshot {
  const name = new Map(projects.map((p) => [p.id, p.name]))
  let working = 0
  const waitingList: SessionSummary[] = []
  for (const s of sessions) {
    if (s.archived) continue
    const state = sessionState(s)
    if (state === 'running') working++
    else if (state === 'waiting') waitingList.push(s)
  }
  waitingList.sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0))
  return {
    updatedAt: opts.updatedAt ?? now,
    connected,
    working,
    waiting: waitingList.length,
    top: !opts.showTitles ? [] : waitingList.slice(0, WIDGET_TOP).map((s) => ({ id: s.id, title: s.title, project: name.get(s.projectId) ?? '' }))
  }
}

/** Same as before apart from the time: then it is not rewritten (each write reloads the widget, which has a budget). */
export const snapshotKey = (s: WidgetSnapshot): string => JSON.stringify([s.connected, s.working, s.waiting, s.top])

/** The widget declares its age instead of the numbers after `WIDGET_STALE_AFTER_MS`. */
export const isStale = (s: WidgetSnapshot, now: number): boolean => now - s.updatedAt >= WIDGET_STALE_AFTER_MS

/** Already-translated texts: the extension does not have the app's catalog. */
export interface WidgetText {
  working: string
  waiting: string
  quiet: string
  updated: string
  open: string
  offline: string
}

export interface WidgetProps extends WidgetSnapshot {
  stale: boolean
  /** "Updated 12 min ago", already written by the phone (in the chosen language); null while the data is fresh. */
  agoLabel: string | null
  /** `ladder://waiting` if something is waiting, otherwise the root. */
  link: string
  text: WidgetText
}

export function widgetProps(s: WidgetSnapshot, text: WidgetText, stale: boolean, agoLabel: string | null = null): WidgetProps {
  return { ...s, stale, agoLabel, link: s.waiting > 0 ? 'ladder://waiting' : 'ladder://', text }
}

export interface TimelineEntry {
  date: Date
  props: WidgetProps
}

/** How often the timeline changes the age label once the data is old, and for how long it is prepared. */
const AGE_STEP_MS = 5 * 60_000
const AGE_UNTIL_MS = 3 * 60 * 60_000

/**
 * Timeline entries: now and, every 5 minutes from `WIDGET_STALE_AFTER_MS` on (up to 3 hours), the same thing marked "stale"
 * with the age already written ("Updated 15 min ago"). The system advances through the entries on its own, even with the app closed: this is how the widget stops
 * claiming things nobody verifies anymore. `updatedAgo` builds the label in the phone's language.
 */
export function widgetTimeline(s: WidgetSnapshot, text: WidgetText, now: number, updatedAgo: (minutes: number) => string): TimelineEntry[] {
  const age = (at: number): string => updatedAgo(Math.max(1, Math.floor((at - s.updatedAt) / 60_000)))
  const entries: TimelineEntry[] = []
  if (isStale(s, now)) entries.push({ date: new Date(now), props: widgetProps(s, text, true, age(now)) })
  else entries.push({ date: new Date(now), props: widgetProps(s, text, false) })
  for (let at = s.updatedAt + WIDGET_STALE_AFTER_MS; at <= s.updatedAt + AGE_UNTIL_MS; at += AGE_STEP_MS) {
    if (at <= now) continue
    entries.push({ date: new Date(at), props: widgetProps(s, text, true, age(at)) })
  }
  return entries
}
