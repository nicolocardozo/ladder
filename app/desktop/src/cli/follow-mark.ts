// How much of a chat line `ladder attach` has already printed. Shared by the host (which sends only these numbers as
// history, not the whole lines) and the CLI. No path aliases.
import type { ChatItem } from '../shared/protocol'

/** For assistant text, the length; for a request 0 = open, 1 = closed; for a tool 1 = failed, 2 otherwise; for anything else 1. */
export function markOf(item: ChatItem): number {
  return item.kind === 'assistant' ? item.text.length : item.kind === 'request' ? (item.state === 'open' ? 0 : 1) : item.kind === 'tool' ? (item.status === 'error' ? 1 : 2) : 1
}
