// Sends a test push to an Expo token, in the same format as real pushes. Node 24 runs it directly.
//   node scripts/push-test.ts 'ExponentPushToken[xxxxxxxx]' [request|turn|error|agents] [--locale it] [--session <id>] [--item <id>] [--mac <id>]
// Calls exp.host for real. Prints the message (token hidden) and the outcome from the sender's log (token masked, never in full);
// Expo's raw receipt is not printed.
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

// Uses the sender directly: no database, no preferences.
const service = new PushService({
  access: { enabled: true, pushTargets: () => [], clearPushToken: () => console.log('(token not registered: the app would clear it)') },
  macId: () => msg.data.mac,
  foreground: () => new Set(),
  log: (line) => console.log(line)
})
console.log('sending:', JSON.stringify({ ...msg, to: '<token>' }))
await service.send([msg])
service.stop()
