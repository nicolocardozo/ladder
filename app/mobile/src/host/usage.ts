// Reading usage limits: `agents.usage` per account. The host does at most one real read per minute per device and
// account (before that it answers from cache), so here it is enough not to start two at once for the same account and not to insist
// on fresh data. The value also arrives as `agent.status`; it is applied to the store anyway.
import type { RemoteAgentStatus } from '@shared/protocol'
import { isStale, type UsageAccount } from '@/lib/usage'
import { onWorldReset } from '@/lib/world-reset'
import { useApp } from '@/store/app'
import { request } from './controller'

/** Outcome of a read: `ok` with windows, `empty` if the host answers but there is nothing to show, `error` if the request fails. */
export type UsageRead = 'ok' | 'empty' | 'error'

const reading = new Map<string, Promise<UsageRead>>()
const lastRead = new Map<string, number>()
// Another Mac (or the demo) does not inherit the time and in-flight reads of the previous one.
onWorldReset(() => {
  reading.clear()
  lastRead.clear()
})

/** Re-reads an account (one request at a time per account: whoever asks while another is in flight gets the same one). */
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

/** The native accounts to re-read: with `all` every one (pull to refresh), otherwise only those never read or a minute old. */
export function accountsToRead(accounts: UsageAccount[], all: boolean): UsageAccount[] {
  return accounts.filter((a) => a.native && (all || isStale(a.status?.usageAt, lastRead.get(a.key), Date.now())))
}

/** Re-reads the accounts in parallel; resolves with the outcome of each. */
export async function readAll(accounts: UsageAccount[]): Promise<Record<string, UsageRead>> {
  const results = await Promise.all(accounts.map(async (a) => [a.key, await readUsage(a)] as const))
  return Object.fromEntries(results)
}

