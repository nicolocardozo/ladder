// Things that hold for one Mac (or for the demo) and must not pass to the next: usage reads, dismissed banners. Whoever holds them
// registers here; the Mac data store clears them on every `reset` (demo start, new Mac, disconnect).
const handlers = new Set<() => void>()
export const onWorldReset = (fn: () => void): void => void handlers.add(fn)
export const runWorldReset = (): void => handlers.forEach((fn) => fn())
