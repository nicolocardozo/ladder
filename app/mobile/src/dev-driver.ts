// Development only: runs the commands of scripts/dev-driver.mjs (demo, theme, language, screen, sheet, actions, notifications).
import { router } from 'expo-router'
import { Platform } from 'react-native'
import { applyLocale } from '@/i18n'
import { readPairingLink } from '@/lib/pair-link'
import { usePairFlow } from '@/store/pair-flow'
import { startDemo, disconnect, devUsage } from '@/host/controller'
import { actions } from '@/host/actions'
import { devStartActivity } from '@/host/live-activity'
import { devLocalNotification, requestPermission } from '@/host/push'
import { devNotificationTap } from '@/host/push-taps'
import { openSheet, useSheets } from '@/lib/sheets'
import { useApp } from '@/store/app'
import type { RequestItem } from '@/lib/turns'
import { useMeter } from '@/features/composer/useDictation'
import { useDev, type DevSheet } from '@/store/dev'
import { usePrefs } from '@/store/prefs'
import type { ThemeId } from '@/theme/theme'

interface Cmd {
  id: number
  /** Only this platform runs the command (both phones read the same driver). */
  target?: 'ios' | 'android'
  demo?: boolean
  reset?: boolean
  theme?: string
  system?: { light: string; dark: string } | false
  lang?: 'en' | 'it'
  route?: string
  /** Like `route`, but stacks the screen (router.push): tests the native back button. */
  push?: string
  /** Opens the pairing flow with a `ladder://pair#…` link (like a deep link). */
  link?: string
  /** With `link`: password already entered and automatic connection to the name step. */
  password?: string
  auto?: boolean
  sheet?: DevSheet
  /** With `sheet: request`: opens the text field (rejection reason or "Other…") with the keyboard. */
  reasonField?: boolean
  /** Scrolls the open native sheet to this distance from the top (pt). */
  scrollSheet?: number
  /** Moves focus to the Home search (keyboard up). */
  focusSearch?: boolean
  /** Leaves only this project in the store (test of the Home with a single project). */
  onlyProject?: string
  /** Opens the Mac sheet (like tapping the Home pill). */
  mac?: boolean
  /** Opens the "New session" sheet (like tapping the "+"). */
  newSession?: boolean
  /** With `newSession`: text already written in the message (the form draft). */
  draft?: string
  /** With `newSession`: moves focus to the message (keyboard up). */
  focus?: boolean
  /** With `newSession`: options open, a choice open (project|agent|account|model|effort|permission), project/agent, send right away. */
  form?: { expand?: boolean; step?: string; send?: boolean; project?: string; agent?: string }
  /** Demo usage limits: normal | near (82%) | banner (96%) | limited | empty. */
  usage?: Parameters<typeof devUsage>[0]
  /** Local notification with the `data` of a real push (tap test): kind, session, request and delay in seconds. `mac` forces a different Mac. */
  /** Asks for notification permission like "Turn on notifications" (the system dialog is confirmed by hand or with adb / AppleScript). */
  askPush?: boolean
  /** Changes the notification preferences (like the Settings toggles). */
  notifyPrefs?: Parameters<ReturnType<typeof usePrefs.getState>['setNotify']>[0]
  notify?: { kind: 'request' | 'turn' | 'error' | 'agents'; sessionId: string; itemId?: string | null; delayS?: number; mac?: string }
  /** Follows a session on the lock screen like the header button. */
  liveActivity?: { sessionId: string; on?: boolean }
  /** Composer open: text to type and images (local files) to attach; `dictate` forces the dictation state. */
  composer?: { text?: string; images?: string[]; send?: boolean; focus?: boolean; dictate?: boolean }
  welcome?: 'chips' | 'caption'
  dictation?: 'listening' | 'downloading' | 'denied' | 'not-installed' | 'unsupported' | 'off'
  /** Goes back one screen (the back button). */
  back?: boolean
  /** Opens a session like tapping a notification (even with a sheet open above a chat). */
  tap?: { sessionId: string; requestId?: string }
  /** Scrolls the open chat to this distance from the bottom (px). */
  scroll?: number
  /** Action as the user: approve | deny | send | steer | stop | perm | answer. */
  act?: { type: string; sessionId: string; text?: string; level?: string }
}

export function startDevDriver(): () => void {
  if (!__DEV__) return () => {}
  // The port can be changed (EXPO_PUBLIC_DEV_DRIVER_PORT) when several work sessions use the driver together.
  const port = process.env.EXPO_PUBLIC_DEV_DRIVER_PORT ?? '8099'
  const base = Platform.OS === 'android' ? `http://10.0.2.2:${port}` : `http://127.0.0.1:${port}`
  // On the first read the latest command is noted without running it: an app reload doesn't repeat it.
  let last: number | null = null
  let stopped = false
  const tick = async () => {
    try {
      const cmd = (await (await fetch(`${base}/cmd`)).json()) as Cmd
      if (last === null) last = cmd.id
      else if (cmd.id > last) {
        last = cmd.id
        run(cmd)
      }
    } catch {
      // the driver isn't there: nothing
    }
    if (!stopped) setTimeout(tick, 1000)
  }
  void tick()
  return () => {
    stopped = true
  }
}

function act(a: NonNullable<Cmd['act']>) {
  const s = useApp.getState()
  const req = (s.items[a.sessionId] ?? []).find((i): i is RequestItem => i.kind === 'request' && i.state === 'open') ?? s.sessions[a.sessionId]?.request ?? null
  switch (a.type) {
    case 'approve':
      if (req) void actions.approve(a.sessionId, req)
      break
    case 'deny':
      if (req) void actions.deny(a.sessionId, req, a.text)
      break
    case 'answer':
      if (req?.questions) void actions.answer(a.sessionId, req, Object.fromEntries(req.questions.map((q) => [q.question, q.options[0].label])))
      break
    case 'send':
      void actions.send(a.sessionId, a.text ?? 'ping', 'queue')
      break
    case 'steer':
      void actions.send(a.sessionId, a.text ?? 'ping', 'steer')
      break
    case 'stop':
      void actions.interrupt(a.sessionId)
      break
    case 'perm':
      void actions.setPermission(a.sessionId, (a.level ?? 'plan') as never)
      break
  }
}

let devMeter: ReturnType<typeof setInterval> | null = null

function run(cmd: Cmd) {
  if (cmd.target && cmd.target !== Platform.OS) return
  if (cmd.composer) useDev.getState().composer?.(cmd.composer)
  if (cmd.welcome) useDev.setState({ welcome: cmd.welcome })
  if (cmd.dictation) {
    useDev.setState({ dictation: cmd.dictation === 'off' ? null : cmd.dictation })
    if (devMeter) clearInterval(devMeter)
    devMeter = null
    if (cmd.dictation === 'listening') devMeter = setInterval(() => useMeter.setState({ level: 0.15 + Math.abs(Math.sin(Date.now() / 160)) * 0.7 * Math.random() }), 80)
  }
  if (cmd.back) router.back()
  if (cmd.tap) devNotificationTap(cmd.tap)
  if (cmd.act) act(cmd.act)
  if (cmd.liveActivity) devStartActivity(cmd.liveActivity.sessionId, cmd.liveActivity.on !== false)
  if (cmd.notifyPrefs) usePrefs.getState().setNotify(cmd.notifyPrefs)
  if (cmd.askPush) void requestPermission()
  if (cmd.notify) void devLocalNotification(cmd.notify)
  if (cmd.scrollSheet !== undefined) useDev.getState().scrollSheet?.(cmd.scrollSheet)
  if (cmd.scroll !== undefined) useDev.getState().scrollChat?.(cmd.scroll)
  const prefs = usePrefs.getState()
  if (cmd.reset) void disconnect()
  if (cmd.demo) startDemo()
  if (cmd.onlyProject) {
    const keep = cmd.onlyProject
    setTimeout(() => useApp.setState((st) => ({ projects: st.projects.filter((p) => p.id === keep), sessions: Object.fromEntries(Object.entries(st.sessions).filter(([, x]) => x.projectId === keep)) })), 1500)
  }
  if (cmd.link) {
    // Equivalent to opening the link: reads it and goes to the confirmation (real deep link opening is tested with simctl/adb).
    const r = readPairingLink(cmd.link, Date.now(), { allowDirect: true })
    if (r.ok) {
      usePairFlow.getState().set({ payload: r.payload, password: cmd.password ?? '', confirmed: !!cmd.auto, deviceName: '', failure: null, autoConnect: !!cmd.auto })
      router.replace('/pair/confirm')
    }
  }
  if (cmd.theme) prefs.setTheme({ choice: cmd.theme === 'mac' ? 'mac' : (cmd.theme as ThemeId), matchSystem: false })
  if (cmd.system) prefs.setTheme({ matchSystem: true, lightTheme: cmd.system.light as ThemeId, darkTheme: cmd.system.dark as ThemeId })
  if (cmd.lang) {
    prefs.setLanguage(cmd.lang)
    applyLocale(cmd.lang)
  }
  useDev.setState({ reasonField: !!cmd.reasonField, focusSearch: !!cmd.focusSearch })
  useDev.getState().setSheet(null)
  if (cmd.push) router.push(cmd.push as never)
  if (cmd.route || cmd.push) useSheets.getState().close()
  if (cmd.route) {
    // A native sheet that may be open is closed first, otherwise the new route would end up inside the sheet.
    if (router.canDismiss()) router.dismissAll()
    router.replace(cmd.route as never)
  }
  if (cmd.usage) devUsage(cmd.usage)
  if (cmd.newSession) usePrefs.getState().setDraft('new-session', cmd.draft ?? '')
  useDev.setState({ focusNewSession: !!cmd.focus, newSession: cmd.newSession ? (cmd.form ?? null) : null })
  if (cmd.mac) setTimeout(() => openSheet(router, { kind: 'mac' }), 1800)
  if (cmd.newSession) setTimeout(() => openSheet(router, { kind: 'new-session' }), 1800)
  // The sheet opens once the screen is already mounted (the old one must not consume it).
  if (cmd.sheet) setTimeout(() => useDev.getState().setSheet(cmd.sheet ?? null), 1800)
}
