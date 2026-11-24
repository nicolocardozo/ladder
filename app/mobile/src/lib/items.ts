// Unione degli item della chat ricevuti dal canale. Solo logica pura (provata con node --test).
import type { ChatItem } from '@shared/protocol'

/** Dimensione predefinita di una pagina di chat (`session.page` senza `limit`) e di un `session.items` con replace. */
export const PAGE_SIZE = 60

/** Unisce item per id, in ordine di seq. */
export function mergeById(current: ChatItem[], incoming: ChatItem[]): ChatItem[] {
  const map = new Map(current.map((i) => [i.id, i]))
  for (const i of incoming) map.set(i.id, i)
  return [...map.values()].sort((a, b) => a.seq - b.seq)
}

/**
 * Effetto di un evento `session.items`. Con `replace` (l'host manda solo l'ultima pagina) la lista diventa quella pagina
 * e, se la pagina è piena, ci può essere storia più vecchia: `hasMore` resta vero e si ricarica scorrendo in alto.
 * Senza `replace` gli item si uniscono e `hasMore` non cambia.
 */
export function applyItemsEvent(current: ChatItem[], hasMore: boolean, incoming: ChatItem[], replace: boolean): { items: ChatItem[]; hasMore: boolean } {
  if (!replace) return { items: mergeById(current, incoming), hasMore }
  return { items: mergeById([], incoming), hasMore: incoming.length >= PAGE_SIZE }
}
