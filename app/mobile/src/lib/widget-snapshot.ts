// Dati del widget "Agent activity" (LAD-93): quante sessioni lavorano, quante aspettano te e i titoli di quelle che aspettano.
// Li scrive l'app (nel gruppo condiviso, dove li legge l'estensione) a ogni cambio dello stato; il widget non ha rete.
// Solo logica pura, provata con node --test.
import type { Project, SessionSummary } from '../../../desktop/src/shared/protocol.ts'
import { sessionState } from './session-state.ts'

/** Dopo tanto senza aggiornamenti il widget non dice più che qualcosa lavora: mostra "Updated 12 min ago". */
export const WIDGET_STALE_AFTER_MS = 10 * 60_000
/** Quanti titoli in attesa si mostrano (il widget medio ne ha posto per tre). */
export const WIDGET_TOP = 3

export interface WidgetTop {
  id: string
  title: string
  project: string
}

export interface WidgetSnapshot {
  /** Quando l'app l'ha scritto (ms). */
  updatedAt: number
  /** Il Mac risponde: senza, i numeri sono l'ultima cosa nota. */
  connected: boolean
  working: number
  waiting: number
  /** Sessioni in attesa, dalla più vecchia: i titoli stanno solo sul telefono, in questo gruppo condiviso. */
  top: WidgetTop[]
}

export interface SnapshotOptions {
  /** Scrivere anche titoli e progetti (spento di serie): fuori dalla cache cifrata, e nei backup. Spento, non si scrive alcun titolo. */
  showTitles?: boolean
  /** Ora da scrivere: quella dell'ultima volta che il Mac rispondeva. Senza, `now`. */
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

/** Uguale a prima a parte l'ora: allora non si riscrive (ogni scrittura ricarica il widget, che ha un budget). */
export const snapshotKey = (s: WidgetSnapshot): string => JSON.stringify([s.connected, s.working, s.waiting, s.top])

/** Il widget dichiara la sua età invece dei numeri dopo `WIDGET_STALE_AFTER_MS`. */
export const isStale = (s: WidgetSnapshot, now: number): boolean => now - s.updatedAt >= WIDGET_STALE_AFTER_MS

/** Testi già tradotti: l'estensione non ha il catalogo dell'app. */
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
  /** "Updated 12 min ago", già scritto dal telefono (nella lingua scelta); null finché i dati sono freschi. */
  agoLabel: string | null
  /** `ladder://waiting` se qualcosa aspetta, altrimenti la radice. */
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

/** Ogni quanto la timeline cambia l'etichetta dell'età dopo che i dati sono vecchi, e per quanto tempo la si prepara. */
const AGE_STEP_MS = 5 * 60_000
const AGE_UNTIL_MS = 3 * 60 * 60_000

/**
 * Voci della timeline: ora e, ogni 5 minuti da `WIDGET_STALE_AFTER_MS` in poi (fino a 3 ore), la stessa cosa marcata "non aggiornata"
 * con l'età già scritta ("Updated 15 min ago"). Il sistema scorre le voci da solo, anche con l'app chiusa: è così che il widget smette
 * di affermare cose che nessuno verifica più. `updatedAgo` compone l'etichetta nella lingua del telefono.
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
