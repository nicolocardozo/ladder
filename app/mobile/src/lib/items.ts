// Merging of the chat items received from the channel. Pure logic only (tested with node --test).
import type { ChatItem, SessionSummary } from '@shared/protocol'

/** Default size of a chat page (`session.page` without `limit`) and of a `session.items` with replace. */
export const PAGE_SIZE = 60

/** Merges items by id, in seq order. */
export function mergeById(current: ChatItem[], incoming: ChatItem[]): ChatItem[] {
  const map = new Map(current.map((i) => [i.id, i]))
  for (const i of incoming) map.set(i.id, i)
  return [...map.values()].sort((a, b) => a.seq - b.seq)
}

/**
 * Effect of a `session.items` event. With `replace` (the host sends only the latest page) the list becomes that page
 * and, if the page is full, there may be older history: `hasMore` stays true and it is reloaded by scrolling up.
 * Without `replace` the items are merged and `hasMore` does not change.
 */
export function applyItemsEvent(current: ChatItem[], hasMore: boolean, incoming: ChatItem[], replace: boolean): { items: ChatItem[]; hasMore: boolean } {
  if (!replace) return { items: mergeById(current, incoming), hasMore }
  return { items: mergeById([], incoming), hasMore: incoming.length >= PAGE_SIZE }
}

/**
 * Sessions after a new snapshot. The snapshot only has the non-archived ones: archived sessions already read by the project
 * screen (`archived: true`) stay, if their project still exists and the snapshot did not report them as active.
 */
export function mergeSnapshotSessions(previous: Record<string, SessionSummary>, incoming: SessionSummary[], projectIds: string[]): Record<string, SessionSummary> {
  const out: Record<string, SessionSummary> = {}
  for (const s of incoming) out[s.id] = s
  const alive = new Set(projectIds)
  for (const s of Object.values(previous)) if (s.archived && !out[s.id] && alive.has(s.projectId)) out[s.id] = s
  return out
}
