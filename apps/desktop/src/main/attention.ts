// Notifiche di macOS e badge del Dock. Gli eventi arrivano dall'host; qui si decide se mostrarli,
// perché solo il main sa quale finestra è in primo piano e cosa sta guardando (sezione 2.3 del piano).
import { appendFileSync } from 'node:fs'
import { app, BrowserWindow, Notification } from 'electron'
import type { AppPrefs, AttentionEvent, WindowView } from '@shared/protocol'

/** Turni più brevi non notificano: li vedi quando torni. */
const TURN_MIN_MS = 60_000
/** Le risposte pronte dello stesso progetto si raccolgono in una notifica per due minuti. */
const GROUP_MS = 120_000

interface Shown {
  kind: 'request' | 'turn' | 'error'
  sessionId: string
  projectId: string
  itemId: string | null
  notification: Notification | null
  at: number
}

interface Group {
  count: number
  at: number
  shown: Shown
}

export class Attention {
  private views = new Map<number, WindowView>()
  /** Riferimenti alle notifiche consegnate: senza, il garbage collector perde il clic. */
  private shown: Shown[] = []
  private groups = new Map<string, Group>()
  private badge = 0
  /** Solo per le prove: finge che la finestra sia (o non sia) in primo piano. */
  forcedFocus: boolean | null = null

  constructor(
    private readonly prefs: () => AppPrefs,
    private readonly open: (sessionId: string, itemId: string | null) => void,
    /** LADDER_NOTIFY_TRACE: le notifiche si scrivono in un file invece di comparire. Per le prove automatiche. */
    private readonly trace: string | null = process.env.LADDER_NOTIFY_TRACE ?? null
  ) {}

  setView(webContentsId: number, view: WindowView): void {
    this.views.set(webContentsId, view)
    // Quando apri una sessione, le sue notifiche già consegnate lasciano il Centro notifiche.
    if (view.sessionId) this.clear((s) => s.sessionId === view.sessionId)
  }

  forget(webContentsId: number): void {
    this.views.delete(webContentsId)
  }

  /** Vista della finestra in primo piano; null se Ladder non è l'app attiva. */
  private focused(): WindowView | null {
    if (this.forcedFocus === false) return null
    const window = this.forcedFocus ? BrowserWindow.getAllWindows()[0] : BrowserWindow.getFocusedWindow()
    return window ? (this.views.get(window.webContents.id) ?? null) : null
  }

  handle(event: AttentionEvent): void {
    switch (event.kind) {
      case 'request': {
        const view = this.focused()
        // La stai guardando: nessuna notifica. Stesso progetto, altra tab: c'è l'avviso nella barra delle tab.
        if (view?.sessionId === event.sessionId || view?.projectId === event.projectId) return
        this.show({ kind: 'request', sessionId: event.sessionId, projectId: event.projectId, itemId: event.itemId }, event.title, event.body, this.prefs().sound)
        return
      }
      case 'resolved':
        this.clear((s) => s.kind === 'request' && s.sessionId === event.sessionId && (event.itemId === null || s.itemId === event.itemId))
        return
      case 'turn': {
        if (event.durationMs < TURN_MIN_MS) return
        const view = this.focused()
        if (view && view.projectId === event.projectId) return
        const now = Date.now()
        const group = this.groups.get(event.projectId)
        const count = group && now - group.at < GROUP_MS ? group.count + 1 : 1
        if (group) this.clear((s) => s === group.shown)
        const title = count === 1 ? `${event.projectName}: risposta pronta` : `${event.projectName}: ${count} risposte pronte`
        const body = count === 1 ? event.title : `Ultima: ${event.title}`
        const shown = this.show({ kind: 'turn', sessionId: event.sessionId, projectId: event.projectId, itemId: event.itemId }, title, body, false)
        if (shown) this.groups.set(event.projectId, { count, at: count === 1 ? now : group!.at, shown })
        return
      }
      case 'error':
        // Una per sessione: un nuovo errore sostituisce il precedente.
        this.clear((s) => s.kind === 'error' && s.sessionId === event.sessionId)
        this.show({ kind: 'error', sessionId: event.sessionId, projectId: event.projectId, itemId: event.itemId }, event.title, event.body, false)
        return
    }
  }

  setBadge(count: number): void {
    this.badge = count
    if (this.trace) this.write({ action: 'badge', count })
    app.dock?.setBadge(count > 0 ? String(count) : '')
  }

  get badgeCount(): number {
    return this.badge
  }

  private muted(): string | null {
    const prefs = this.prefs()
    if (!prefs.notifications) return 'disattivate'
    if (prefs.dndUntil && prefs.dndUntil > Date.now()) return 'non disturbare'
    return null
  }

  private show(target: Omit<Shown, 'notification' | 'at'>, title: string, body: string, sound: boolean): Shown | null {
    const muted = this.muted()
    if (muted) {
      if (this.trace) this.write({ action: 'suppressed', reason: muted, ...target, title, body })
      return null
    }
    const shown: Shown = { ...target, notification: null, at: Date.now() }
    if (this.trace) {
      this.write({ action: 'show', ...target, title, body, sound })
    } else if (Notification.isSupported()) {
      const notification = new Notification({ title, body, silent: !sound })
      notification.on('click', () => {
        this.forgetShown(shown)
        this.open(target.sessionId, target.itemId)
      })
      notification.on('close', () => this.forgetShown(shown))
      notification.show()
      shown.notification = notification
    }
    this.shown.push(shown)
    if (this.shown.length > 100) this.shown.splice(0, this.shown.length - 100)
    return shown
  }

  /** Per le prove: simula il clic sull'ultima notifica mostrata. */
  clickLatest(): boolean {
    const latest = this.shown[this.shown.length - 1]
    if (!latest) return false
    this.forgetShown(latest)
    this.open(latest.sessionId, latest.itemId)
    return true
  }

  private forgetShown(shown: Shown): void {
    this.shown = this.shown.filter((s) => s !== shown)
  }

  private clear(match: (shown: Shown) => boolean): void {
    const gone = this.shown.filter(match)
    if (gone.length === 0) return
    for (const shown of gone) {
      shown.notification?.close()
      if (this.trace) this.write({ action: 'close', kind: shown.kind, sessionId: shown.sessionId, itemId: shown.itemId })
    }
    this.shown = this.shown.filter((s) => !match(s))
  }

  private write(entry: Record<string, unknown>): void {
    try {
      appendFileSync(this.trace!, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
    } catch {
      // Solo per le prove.
    }
  }
}
