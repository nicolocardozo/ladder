// Solo sviluppo: esegue i comandi di scripts/dev-driver.mjs (demo, tema, lingua, schermata, sheet).
import { router } from 'expo-router'
import { Platform } from 'react-native'
import { applyLocale } from '@/i18n'
import { startDemo, startRemote, disconnect } from '@/host/controller'
import { actions } from '@/host/actions'
import { useApp } from '@/store/app'
import type { RequestItem } from '@/lib/turns'
import { useDev, type DevSheet } from '@/store/dev'
import { usePrefs } from '@/store/prefs'
import type { ThemeId } from '@/theme/theme'

interface Cmd {
  id: number
  demo?: boolean
  reset?: boolean
  theme?: string
  system?: { light: string; dark: string } | false
  lang?: 'en' | 'it'
  route?: string
  /** Abbina un host (harness): { wsUrl, macKey, device } e si collega. */
  pair?: { wsUrl: string; macKey: string; device?: string }
  sheet?: DevSheet
  /** Scorre la chat aperta a questa distanza dal fondo (px). */
  scroll?: number
  /** Azione come l'utente: approve | deny | send | steer | stop | perm | answer. */
  act?: { type: string; sessionId: string; text?: string; level?: string }
}

export function startDevDriver(): () => void {
  if (!__DEV__) return () => {}
  const base = Platform.OS === 'android' ? 'http://10.0.2.2:8099' : 'http://127.0.0.1:8099'
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

function run(cmd: Cmd) {
  if (cmd.act) act(cmd.act)
  if (cmd.scroll !== undefined) useDev.getState().scrollChat?.(cmd.scroll)
  const prefs = usePrefs.getState()
  if (cmd.reset) void disconnect()
  if (cmd.demo) startDemo()
  if (cmd.pair) void startRemote({ wsUrl: cmd.pair.wsUrl, macKey: cmd.pair.macKey, device: cmd.pair.device ?? 'Simulator' })
  if (cmd.theme) prefs.setTheme({ choice: cmd.theme === 'mac' ? 'mac' : (cmd.theme as ThemeId), matchSystem: false })
  if (cmd.system) prefs.setTheme({ matchSystem: true, lightTheme: cmd.system.light as ThemeId, darkTheme: cmd.system.dark as ThemeId })
  if (cmd.lang) {
    prefs.setLanguage(cmd.lang)
    applyLocale(cmd.lang)
  }
  useDev.getState().setSheet(null)
  if (cmd.route) router.replace(cmd.route as never)
  // Lo sheet si apre a schermata già montata (la vecchia non deve consumarlo).
  if (cmd.sheet) setTimeout(() => useDev.getState().setSheet(cmd.sheet ?? null), 1800)
}
