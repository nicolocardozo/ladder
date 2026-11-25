// Cose che valgono per un Mac (o per la demo) e non devono passare al prossimo: letture dei limiti, bannerini chiusi. Chi le tiene si
// registra qui; lo store dei dati del Mac le azzera a ogni `reset` (avvio della demo, nuovo Mac, scollegamento).
const handlers = new Set<() => void>()
export const onWorldReset = (fn: () => void): void => void handlers.add(fn)
export const runWorldReset = (): void => handlers.forEach((fn) => fn())
