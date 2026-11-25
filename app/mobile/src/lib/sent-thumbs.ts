// Miniature delle immagini appena inviate (LAD-92): il Mac riporta in chat solo nome e tipo dell'allegato, non i dati.
// Il telefono ricorda la miniatura locale per nome (unico a ogni invio) e la mostra nel messaggio; senza, resta il nome.
const thumbs = new Map<string, string>()
const MAX = 60

export function rememberThumb(name: string, uri: string): void {
  thumbs.delete(name)
  thumbs.set(name, uri)
  while (thumbs.size > MAX) thumbs.delete(thumbs.keys().next().value as string)
}

export const thumbFor = (name: string): string | undefined => thumbs.get(name)
