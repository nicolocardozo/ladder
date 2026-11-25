// Lettura dei limiti d'uso (LAD-90): `agents.usage` per account. L'host fa al massimo una lettura vera al minuto per dispositivo e
// account (prima risponde dalla cache), quindi qui basta non farne partire due insieme per lo stesso account e non insistere
// su un dato fresco. Il valore arriva anche come `agent.status`; lo si applica comunque allo store.
import type { RemoteAgentStatus } from '@shared/protocol'
import { isStale, type UsageAccount } from '@/lib/usage'
import { onWorldReset } from '@/lib/world-reset'
import { useApp } from '@/store/app'
import { request } from './controller'

/** Esito di una lettura: `ok` con finestre, `empty` se l'host risponde ma non c'è niente da mostrare, `error` se la richiesta fallisce. */
export type UsageRead = 'ok' | 'empty' | 'error'

const reading = new Map<string, Promise<UsageRead>>()
const lastRead = new Map<string, number>()
// Un altro Mac (o la demo) non eredita ora e letture in corso del precedente.
onWorldReset(() => {
  reading.clear()
  lastRead.clear()
})

/** Rilegge un account (una sola richiesta alla volta per account: chi chiede mentre un'altra è in corso ne riceve la stessa). */
export function readUsage(account: Pick<UsageAccount, 'key' | 'agent' | 'profileId'>): Promise<UsageRead> {
  const running = reading.get(account.key)
  if (running) return running
  const promise = request<RemoteAgentStatus | null>({ type: 'agents.usage', agent: account.agent, ...(account.profileId ? { profileId: account.profileId } : {}) })
    .then((status): UsageRead => {
      if (status) useApp.getState().applyEvent({ type: 'agent.status', status })
      return status?.usage?.length ? 'ok' : 'empty'
    })
    .catch((): UsageRead => 'error')
    .then((result) => {
      reading.delete(account.key)
      if (result !== 'error') lastRead.set(account.key, Date.now())
      return result
    })
  reading.set(account.key, promise)
  return promise
}

/** Gli account nativi da rileggere: con `all` tutti (tirando giù la lista), altrimenti solo quelli mai letti o vecchi di un minuto. */
export function accountsToRead(accounts: UsageAccount[], all: boolean): UsageAccount[] {
  return accounts.filter((a) => a.native && (all || isStale(a.status?.usageAt, lastRead.get(a.key), Date.now())))
}

/** Rilegge gli account in parallelo; risolve con l'esito di ciascuno. */
export async function readAll(accounts: UsageAccount[]): Promise<Record<string, UsageRead>> {
  const results = await Promise.all(accounts.map(async (a) => [a.key, await readUsage(a)] as const))
  return Object.fromEntries(results)
}

