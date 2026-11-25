// macOS notifications and Dock badge. Events come from the host; here we decide whether to show them,
// because only main knows which window is in front and what you are looking at.
import { appendFileSync } from 'node:fs'
import { app, BrowserWindow, Notification } from 'electron'
import { plural, t } from '@shared/i18n'
import type { AppPrefs, AttentionEvent, PushEvent, WindowView } from '@shared/protocol'
import { isWatching, pushFor, TURN_MIN_MS } from './push-logic'

/** Ready replies from the same project are gathered into one notification for two minutes. */
const GROUP_MS = 120_000

interface Shown {
  kind: 'request' | 'turn' | 'error' | 'agents'
  sessionId: string
  projectId: string
  itemId: string | null
  /** Only for 'agents': a 'done' does not replace a 'failed' that is still visible. */
  outcome?: 'done' | 'failed'
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
  /** References to delivered notifications: without them, the garbage collector loses the click. */
  private shown: Shown[] = []
  private groups = new Map<string, Group>()
  private badge = 0
  /** Tests only: pretends the window is (or is not) in the foreground. */
  forcedFocus: boolean | null = null

  constructor(
    private readonly prefs: () => AppPrefs,
    private readonly open: (sessionId: string, itemId: string | null) => void,
    /** Mac state used to decide phone pushes, and delivery to the host. */
    private readonly phones: { state: () => { idleSeconds: number; locked: boolean }; send: (event: PushEvent) => void } | null = null,
    /** LADDER_NOTIFY_TRACE: notifications are written to a file instead of appearing. For automated tests. */
    private readonly trace: string | null = process.env.LADDER_NOTIFY_TRACE ?? null
  ) {}

  setView(webContentsId: number, view: WindowView): void {
    this.views.set(webContentsId, view)
    // When you open a session, its already delivered notifications leave Notification Center.
    if (view.sessionId) this.clear((s) => s.sessionId === view.sessionId)
  }

  forget(webContentsId: number): void {
    this.views.delete(webContentsId)
  }

  /** View of the foreground window; null if Ladder is not the active app. */
  private focused(): WindowView | null {
    if (this.forcedFocus === false) return null
    const window = this.forcedFocus ? BrowserWindow.getAllWindows()[0] : BrowserWindow.getFocusedWindow()
    return window ? (this.views.get(window.webContents.id) ?? null) : null
  }

  /** Same events as the Mac notifications, but phones are decided with their own rules (see push-logic.ts). */
  private pushToPhones(event: AttentionEvent): void {
    if (!this.phones) return
    const { idleSeconds, locked } = this.phones.state()
    const push = pushFor(event, { view: this.focused(), idleSeconds, locked, dndUntil: this.prefs().dndUntil, now: Date.now() })
    if (!push) return
    if (this.trace) this.write({ action: 'push', ...push })
    this.phones.send(push)
  }

  handle(event: AttentionEvent): void {
    this.pushToPhones(event)
    switch (event.kind) {
      case 'request': {
        const view = this.focused()
        // No notification only if the session waiting for you is in front of you (even in a side-by-side column).
        // Another session of the same project notifies anyway: the warning in the tab bar alone went unnoticed.
        if (view && (view.visibleSessionIds?.includes(event.sessionId) ?? view.sessionId === event.sessionId)) return
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
        const title = plural(count, '{project}: reply ready', '{project}: {n} replies ready', { project: event.projectName })
        const body = count === 1 ? event.title : t('Latest: {title}', { title: event.title })
        const shown = this.show({ kind: 'turn', sessionId: event.sessionId, projectId: event.projectId, itemId: event.itemId }, title, body, false)
        if (shown) this.groups.set(event.projectId, { count, at: count === 1 ? now : group!.at, shown })
        return
      }
      case 'agents': {
        // You are looking at the session (in any column): the reply and the agent list are already in front of you.
        const view = this.focused()
        if (isWatching(view, event.sessionId)) return
        // One per session: the new notice replaces the previous one. Sound only if an agent failed.
        if (event.outcome === 'done' && this.shown.some((s) => s.kind === 'agents' && s.outcome === 'failed' && s.sessionId === event.sessionId)) return
        this.clear((s) => s.kind === 'agents' && s.sessionId === event.sessionId)
        this.show({ kind: 'agents', sessionId: event.sessionId, projectId: event.projectId, itemId: event.itemId, outcome: event.outcome }, event.title, event.body, event.outcome === 'failed' && this.prefs().sound)
        return
      }
      case 'error':
        // One per session: a new error replaces the previous one.
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

  /** Sound chosen in Settings (a macOS system sound); 'default' keeps the notification's default one. */
  private soundOption(sound: boolean): { sound?: string } {
    const name = this.prefs().soundName
    return sound && name !== 'default' ? { sound: name } : {}
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
      this.write({ action: 'show', ...target, title, body, sound, ...(sound ? { soundName: this.prefs().soundName } : {}) })
    } else if (Notification.isSupported()) {
      const notification = new Notification({ title, body, silent: !sound, ...this.soundOption(sound) })
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

  /**
   * "Send a test notification" (Settings → Notifications): a real banner even with "Do Not Disturb",
   * because you asked for it. On first use macOS asks for permission; clicking brings Ladder back to the front.
   */
  test(onClick: () => void): boolean {
    if (this.trace) {
      this.write({ action: 'test' })
      return true
    }
    if (!Notification.isSupported()) return false
    const notification = new Notification({ title: 'Ladder', body: t('Test notification: click to come back here.'), silent: !this.prefs().sound, ...this.soundOption(this.prefs().sound) })
    const shown: Shown = { kind: 'request', sessionId: '', projectId: '', itemId: null, notification, at: Date.now() }
    notification.on('click', () => {
      this.forgetShown(shown)
      onClick()
    })
    notification.on('close', () => this.forgetShown(shown))
    this.shown.push(shown)
    notification.show()
    return true
  }

  /** For tests: simulates a click on the last notification shown. */
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
      // Tests only.
    }
  }
}
