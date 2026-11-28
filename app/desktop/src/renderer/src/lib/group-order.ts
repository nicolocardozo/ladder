// Manual order of the sessions inside a sidebar group.
/**
 * Sessions of a group in the order you arranged them. Those not placed yet (just added) come first, in the order given
 * (newest on top), so a session you move into a group shows up where you look first.
 */
export function orderInGroup<T extends { id: string }>(sessions: T[], order: string[] | undefined): T[] {
  if (!order?.length) return sessions
  const at = new Map(order.map((id, i) => [id, i]))
  const loose = sessions.filter((s) => !at.has(s.id))
  const placed = sessions.filter((s) => at.has(s.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!)
  return [...loose, ...placed]
}
