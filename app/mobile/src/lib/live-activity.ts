// Live Activity delle sessioni sul telefono (LAD-93). Solo logica pura (niente React Native né i18n), così si prova con node --test:
// da una sessione a ciò che l'attività mostra, e il ciclo di vita (parte, si aggiorna, finisce) dato lo stato del negozio.
//
// Privacy: titolo, progetto e testo dell'attività nascono e restano sul telefono. Le Live Activity non ricevono nulla da Expo,
// Apple o Google: Expo non sa mandare push ActivityKit (serve APNs con chiave .p8, che il Mac non ha), quindi l'app le avvia e
// le aggiorna da sola finché è viva. Vedi app/mobile/RELEASE.md, sezione "Lock Screen".
import type { AgentId, ChatItem, Project, SessionSummary } from '../../../desktop/src/shared/protocol.ts'
import { sessionState } from './session-state.ts'

/** Fasi mostrate: lavora, aspetta te, finita, errore. */
export type ActivityPhase = 'running' | 'waiting' | 'done' | 'error'

/** Quanto dura una Live Activity senza aggiornamenti prima che iOS la dia per "non aggiornata" (isStale). */
export const STALE_AFTER_MS = 5 * 60_000
/** Con l'app viva e il Mac collegato si rinnova la scadenza così spesso: la Live Activity non invecchia finché la verità è nota. */
export const REFRESH_MS = 60_000
/** Dopo la fine o l'errore la Live Activity resta sulla schermata di blocco ancora un po', poi iOS la toglie. */
export const END_AFTER_MS = 5 * 60_000
/** Quante Live Activity di Ladder insieme: iOS ne ammette poche per app, e troppe sono rumore. */
export const MAX_LIVE = 3

/** Testi già tradotti: l'estensione non ha il catalogo dell'app, quindi arrivano nelle proprietà. */
export interface ActivityText {
  running: string
  waiting: string
  done: string
  error: string
  stale: string
}

/** Proprietà della Live Activity (JSON): tutto ciò che il layout nativo può mostrare. */
export interface ActivityProps {
  sessionId: string
  title: string
  project: string
  /** Quale marchio disegnare: claude, codex o l'iniziale per gli altri. */
  mark: 'claude' | 'codex' | 'other'
  initial: string
  phase: ActivityPhase
  /** Riga di dettaglio: il passaggio attuale ("Esegue pnpm test"), l'attesa ("Approvazione"), l'errore. Vuota se non c'è. */
  detail: string
  /** Passaggi del turno ("12 steps"); null se la chat non è in memoria. */
  steps: string | null
  /** Inizio del turno (ms): il cronometro conta da qui mentre lavora. */
  startedAt: number
  /** Durata già formattata quando il turno è finito; null mentre lavora. */
  took: string | null
  /** `ladder://session/<id>`: il tocco apre la sessione. */
  link: string
  text: ActivityText
}

export const markOf = (agent: AgentId): ActivityProps['mark'] => (agent === 'claude-code' ? 'claude' : agent === 'codex' ? 'codex' : 'other')

export const sessionLink = (sessionId: string): string => `ladder://session/${encodeURIComponent(sessionId)}`

/** Il turno in corso nella chat in memoria: quanti passaggi (strumenti) e da quando. Null se non c'è la chat. */
export function currentTurn(items: ChatItem[] | undefined): { steps: number; startedAt: number } | null {
  if (!items || items.length === 0) return null
  let last = items[0]
  for (const i of items) if (i.seq > last.seq) last = i
  let steps = 0
  let startedAt = Infinity
  for (const i of items) {
    if (i.turnId !== last.turnId) continue
    if (i.kind === 'tool') steps++
    if (i.at < startedAt) startedAt = i.at
  }
  return { steps, startedAt: Number.isFinite(startedAt) ? startedAt : last.at }
}

/** Fase "viva" di una sessione (lavora, aspetta, errore) oppure 'idle' se non ha nulla da mostrare. */
export function livePhase(session: SessionSummary): 'running' | 'waiting' | 'error' | 'idle' {
  const state = sessionState(session)
  return state === 'running' || state === 'waiting' || state === 'error' ? state : 'idle'
}

/** Estratto per `describe`: la parte del turno che serve ai testi. */
export interface DescribeInput {
  session: SessionSummary
  project: Project | undefined
  items: ChatItem[] | undefined
  /** Fase da mostrare (quella viva, o 'done' alla fine del turno). */
  phase: ActivityPhase
  now: number
  text: ActivityText
  /** Etichette generate dal telefono con i18n: passi e durata. */
  stepsLabel: (n: number) => string
  durationLabel: (ms: number) => string
  /** Quando è iniziato il turno secondo chi segue la sessione (prima volta che la si è vista viva). */
  seenSince: number
}

export function describe(i: DescribeInput): ActivityProps {
  const s = i.session
  const turn = currentTurn(i.items)
  const startedAt = turn?.startedAt ?? i.seenSince
  const ended = i.phase === 'done' || i.phase === 'error'
  const detail = i.phase === 'waiting' ? (s.waitingLabel ?? '') : i.phase === 'running' ? (s.activity ?? '') : ''
  return {
    sessionId: s.id,
    title: s.title,
    project: i.project?.name ?? '',
    mark: markOf(s.agent),
    initial: (s.agent.replace(/^acp:/, '').trim().charAt(0) || 'A').toUpperCase(),
    phase: i.phase,
    detail,
    steps: turn && turn.steps > 0 ? i.stepsLabel(turn.steps) : null,
    startedAt,
    took: ended ? i.durationLabel(Math.max(0, i.now - startedAt)) : null,
    link: sessionLink(s.id),
    text: i.text
  }
}

/** Cosa cambia a vista d'occhio: se resta uguale non si riaggiorna la Live Activity (ogni update costa batteria e budget). */
export const activityKey = (p: ActivityProps): string => [p.phase, p.title, p.project, p.detail, p.steps ?? '', p.took ?? '', p.text.running].join('\u0001')

// ── Chi si segue ──

export type FollowOverride = 'on' | 'off'

export interface FollowPrefs {
  /** Interruttore generale (Impostazioni → Notifiche). */
  enabled: boolean
  /** Parte da sola per le sessioni aperte o avviate da questo telefono. */
  auto: boolean
  /** Scelta per sessione, dall'header della chat. */
  overrides: Record<string, FollowOverride>
}

export const DEFAULT_FOLLOW: FollowPrefs = { enabled: true, auto: true, overrides: {} }

/** Questa sessione deve avere una Live Activity? `opened`: la si è aperta o ci si è scritto da questo telefono. */
export function follows(prefs: FollowPrefs, sessionId: string, opened: boolean): boolean {
  if (!prefs.enabled) return false
  const o = prefs.overrides[sessionId]
  if (o === 'off') return false
  if (o === 'on') return true
  return prefs.auto && opened
}

/** Rilegge ciò che era salvato: valori non validi tornano al predefinito, le scelte per sessione sono al massimo 60 (le ultime). */
export function normalizeFollow(raw: unknown): FollowPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const ov = r.overrides && typeof r.overrides === 'object' ? (r.overrides as Record<string, unknown>) : {}
  const overrides: Record<string, FollowOverride> = {}
  for (const [id, v] of Object.entries(ov).slice(-60)) if (v === 'on' || v === 'off') overrides[id] = v
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_FOLLOW.enabled,
    auto: typeof r.auto === 'boolean' ? r.auto : DEFAULT_FOLLOW.auto,
    overrides
  }
}

// ── Ciclo di vita ──

/** Una sessione vista dal ciclo di vita: la fase viva e le proprietà già pronte per quella fase. */
export interface Item {
  id: string
  phase: 'running' | 'waiting' | 'error' | 'idle'
  /** Va seguita (interruttori e preferenze) e il telefono la può mostrare. */
  wants: boolean
  /** Proprietà per la fase attuale; per 'idle' sono quelle di "finita". */
  props: ActivityProps
}

export interface Track {
  /** La Live Activity è sullo schermo e riceve aggiornamenti. */
  live: boolean
  key: string
  /** Ultimo invio (avvio, update o rinnovo), per il rinnovo periodico. */
  sentAt: number
  /** Fine, per dimenticare la traccia dopo un po'. */
  endedAt: number | null
  /** L'utente (o iOS) l'ha tolta dallo schermo mentre la sessione era in questa fase: non riparte finché il turno non finisce. */
  dismissed?: ActivityPhase
}

/** Segna una Live Activity sparita dallo schermo senza che l'abbiamo chiusa noi: libera il posto e non la riavvia subito. */
export function markDismissed(tracks: Tracks, sessionId: string, phase: ActivityPhase, now: number): Tracks {
  const t = tracks[sessionId]
  if (!t || !t.live) return tracks
  return { ...tracks, [sessionId]: { live: false, key: t.key, sentAt: now, endedAt: now, dismissed: phase } }
}

export type Tracks = Record<string, Track>

export type Op =
  | { type: 'start'; sessionId: string; props: ActivityProps }
  | { type: 'update'; sessionId: string; props: ActivityProps }
  /** `immediate`: via subito (non si segue più); altrimenti resta `END_AFTER_MS` con lo stato finale. */
  | { type: 'end'; sessionId: string; props: ActivityProps | null; immediate: boolean }

export interface ReconcileOptions {
  now: number
  /** Il Mac risponde: solo allora si rinnova la scadenza (altrimenti l'attività invecchia, ed è giusto). */
  connected: boolean
  maxLive?: number
  refreshMs?: number
  /** Si può avviare (Mac collegato o demo): con dati dalla copia in cache non si avvia nulla, ma ciò che c'è resta. */
  canStart?: boolean
  /** Sessioni il cui ultimo avvio è fallito: niente nuovo tentativo finché chi chiama non le toglie (primo piano, preferenze). */
  blocked?: ReadonlySet<string>
}

/**
 * Dato lo stato di adesso, cosa fare con le Live Activity: avviare quando una sessione seguita lavora o aspetta, aggiornare quando cambia
 * ciò che si vede (e rinnovare la scadenza ogni minuto), chiudere con lo stato finale quando il turno finisce o va in errore,
 * chiudere subito quando non la si segue più o la sessione sparisce. Non cambia gli argomenti: restituisce le tracce nuove.
 */
export function reconcile(tracks: Tracks, items: Item[], opts: ReconcileOptions): { tracks: Tracks; ops: Op[] } {
  const { now, connected, maxLive = MAX_LIVE, refreshMs = REFRESH_MS, canStart = true, blocked } = opts
  const next: Tracks = {}
  const ops: Op[] = []
  const seen = new Set<string>()
  let live = Object.values(tracks).filter((t) => t.live).length
  // Prima chi smette di essere seguito o sparisce: libera posti per chi parte.
  for (const item of items) seen.add(item.id)
  for (const [id, t] of Object.entries(tracks)) {
    if (!seen.has(id)) {
      if (t.live) {
        ops.push({ type: 'end', sessionId: id, props: null, immediate: true })
        live--
      } else if (t.endedAt !== null && now - t.endedAt < 60 * 60_000) next[id] = t
    }
  }
  for (const item of items) {
    const t = tracks[item.id]
    if (!item.wants) {
      if (t?.live) {
        ops.push({ type: 'end', sessionId: item.id, props: null, immediate: true })
        live--
      }
      continue
    }
    if (item.phase === 'running' || item.phase === 'waiting') {
      if (t?.dismissed) {
        next[item.id] = t
        continue
      }
      if (!t || !t.live) {
        if (!canStart || blocked?.has(item.id) || live >= maxLive) {
          if (t) next[item.id] = t
          continue
        }
        ops.push({ type: 'start', sessionId: item.id, props: item.props })
        next[item.id] = { live: true, key: activityKey(item.props), sentAt: now, endedAt: null }
        live++
        continue
      }
      const key = activityKey(item.props)
      if (key !== t.key || (connected && now - t.sentAt >= refreshMs)) {
        ops.push({ type: 'update', sessionId: item.id, props: item.props })
        next[item.id] = { ...t, key, sentAt: now }
      } else next[item.id] = t
      continue
    }
    // Turno finito: la scelta di toglierla vale solo per quel turno.
    if (t?.dismissed) continue
    // Errore o fermo: se c'era una Live Activity si chiude con lo stato finale; se non c'era, nessuno la vuole (turno vecchio).
    if (t?.live) {
      const props: ActivityProps = item.phase === 'error' ? { ...item.props, phase: 'error' } : { ...item.props, phase: 'done' }
      ops.push({ type: 'end', sessionId: item.id, props, immediate: false })
      next[item.id] = { live: false, key: activityKey(props), sentAt: now, endedAt: now }
      live--
    } else if (t) {
      if (t.endedAt !== null && now - t.endedAt < 60 * 60_000) next[item.id] = t
    }
  }
  return { tracks: next, ops }
}
