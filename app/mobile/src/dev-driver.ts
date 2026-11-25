// Solo sviluppo: esegue i comandi di scripts/dev-driver.mjs (demo, tema, lingua, schermata, sheet, azioni, notifiche).
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
  /** Solo questa piattaforma esegue il comando (i due telefoni leggono lo stesso driver). */
  target?: 'ios' | 'android'
  demo?: boolean
  reset?: boolean
  theme?: string
  system?: { light: string; dark: string } | false
  lang?: 'en' | 'it'
  route?: string
  /** Come `route`, ma impila la schermata (router.push): prova il tasto indietro nativo. */
  push?: string
  /** Apre il flusso di abbinamento con un link `ladder://pair#…` (come un deep link). */
  link?: string
  /** Con `link`: password già inserita e collegamento automatico al passo del nome. */
  password?: string
  auto?: boolean
  sheet?: DevSheet
  /** Con `sheet: request`: apre il campo di testo (motivo del rifiuto o "Altro…") con la tastiera. */
  reasonField?: boolean
  /** Fa scorrere lo sheet nativo aperto a questa distanza dall'alto (pt). */
  scrollSheet?: number
  /** Porta il focus nella ricerca della Home (tastiera su). */
  focusSearch?: boolean
  /** Lascia nello store solo questo progetto (prova della Home con un progetto solo). */
  onlyProject?: string
  /** Apre lo sheet del Mac (come il tocco sul pill della Home). */
  mac?: boolean
  /** Apre lo sheet "Nuova sessione" (come il tocco sul "+"). */
  newSession?: boolean
  /** Con `newSession`: testo già scritto nel messaggio (la bozza del modulo). */
  draft?: string
  /** Con `newSession`: porta il focus nel messaggio (tastiera su). */
  focus?: boolean
  /** Con `newSession`: opzioni aperte, una scelta aperta (project|agent|account|model|effort|permission), progetto/agente, invio subito. */
  form?: { expand?: boolean; step?: string; send?: boolean; project?: string; agent?: string }
  /** Limiti d'uso della demo: normal | near (82%) | banner (96%) | limited | empty. */
  usage?: Parameters<typeof devUsage>[0]
  /** Notifica locale con i `data` di un push vero (prova del tocco): kind, sessione, richiesta e ritardo in secondi. `mac` forza un Mac diverso. */
  /** Chiede il permesso delle notifiche come "Turn on notifications" (la finestra di sistema si conferma a mano o con adb / AppleScript). */
  askPush?: boolean
  /** Cambia le preferenze delle notifiche (come i toggle di Impostazioni). */
  notifyPrefs?: Parameters<ReturnType<typeof usePrefs.getState>['setNotify']>[0]
  notify?: { kind: 'request' | 'turn' | 'error' | 'agents'; sessionId: string; itemId?: string | null; delayS?: number; mac?: string }
  /** Segue una sessione sulla schermata di blocco come il pulsante dell'header (LAD-93). */
  liveActivity?: { sessionId: string; on?: boolean }
  /** Composer aperto: testo da scrivere e immagini (file locali) da allegare; `dictation` forza lo stato della dettatura. */
  composer?: { text?: string; images?: string[]; send?: boolean; focus?: boolean; dictate?: boolean }
  welcome?: 'chips' | 'caption'
  dictation?: 'listening' | 'downloading' | 'denied' | 'not-installed' | 'unsupported' | 'off'
  /** Torna indietro di una schermata (il tasto indietro). */
  back?: boolean
  /** Apre una sessione come il tocco su una notifica (anche con uno sheet aperto sopra una chat). */
  tap?: { sessionId: string; requestId?: string }
  /** Scorre la chat aperta a questa distanza dal fondo (px). */
  scroll?: number
  /** Azione come l'utente: approve | deny | send | steer | stop | perm | answer. */
  act?: { type: string; sessionId: string; text?: string; level?: string }
}

export function startDevDriver(): () => void {
  if (!__DEV__) return () => {}
  // La porta si può cambiare (EXPO_PUBLIC_DEV_DRIVER_PORT) quando più sessioni di lavoro usano il driver insieme.
  const port = process.env.EXPO_PUBLIC_DEV_DRIVER_PORT ?? '8099'
  const base = Platform.OS === 'android' ? `http://10.0.2.2:${port}` : `http://127.0.0.1:${port}`
  // Alla prima lettura si prende nota dell'ultimo comando senza eseguirlo: un ricaricamento dell'app non lo ripete.
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
      // il driver non c'è: niente
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
    // Equivale ad aprire il link: lo legge e va alla conferma (la vera apertura da deep link si prova con simctl/adb).
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
    // Un eventuale sheet nativo aperto si chiude prima, altrimenti la rotta nuova finirebbe dentro lo sheet.
    if (router.canDismiss()) router.dismissAll()
    router.replace(cmd.route as never)
  }
  if (cmd.usage) devUsage(cmd.usage)
  if (cmd.newSession) usePrefs.getState().setDraft('new-session', cmd.draft ?? '')
  useDev.setState({ focusNewSession: !!cmd.focus, newSession: cmd.newSession ? (cmd.form ?? null) : null })
  if (cmd.mac) setTimeout(() => openSheet(router, { kind: 'mac' }), 1800)
  if (cmd.newSession) setTimeout(() => openSheet(router, { kind: 'new-session' }), 1800)
  // Lo sheet si apre a schermata già montata (la vecchia non deve consumarlo).
  if (cmd.sheet) setTimeout(() => useDev.getState().setSheet(cmd.sheet ?? null), 1800)
}
