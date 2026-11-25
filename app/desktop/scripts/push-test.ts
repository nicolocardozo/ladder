// Manda un push di prova a un token Expo, con lo stesso formato dei push veri (LAD-53). Node 24 lo esegue direttamente.
//   node scripts/push-test.ts 'ExponentPushToken[xxxxxxxx]' [request|turn|error|agents] [--locale it] [--session <id>] [--item <id>] [--mac <id>]
// Chiama davvero exp.host. Stampa il messaggio (token nascosto) e l'esito dal log del sender (token mascherato, mai intero);
// il biglietto grezzo di Expo non si stampa.
import { message, PushService } from '../src/host/remote/push.ts'
import { registerCatalog, isLocale, type Locale } from '../src/shared/i18n.ts'
import it from '../src/shared/locales/it/host.ts'
import type { PushKind } from '../src/shared/protocol.ts'

registerCatalog('it', it)
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const [token, kindArg] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
if (!token) {
  console.error("usage: node scripts/push-test.ts 'ExponentPushToken[...]' [request|turn|error|agents] [--locale it] [--session <id>] [--item <id>] [--mac <id>]")
  process.exit(2)
}
const kind: PushKind = kindArg === 'turn' || kindArg === 'error' || kindArg === 'agents' ? kindArg : 'request'
const locale: Locale = isLocale(flag('locale')) ? (flag('locale') as Locale) : 'en'
const msg = message({ pushToken: token, locale }, { kind, sessionId: flag('session') ?? 'test-session', itemId: flag('item') ?? null }, flag('mac') ?? 'test-mac')

// Usa direttamente il sender: nessun database, nessuna preferenza.
const service = new PushService({
  access: { enabled: true, pushTargets: () => [], clearPushToken: () => console.log('(token not registered: the app would clear it)') },
  macId: () => msg.data.mac,
  foreground: () => new Set(),
  log: (line) => console.log(line)
})
console.log('sending:', JSON.stringify({ ...msg, to: '<token>' }))
await service.send([msg])
service.stop()
