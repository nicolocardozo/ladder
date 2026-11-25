// Thumbnails of images just sent: the Mac reports only the attachment's name and type back in the chat, not the data.
// The phone remembers the local thumbnail by name (unique per send) and shows it in the message; without it, the name remains.
const thumbs = new Map<string, string>()
const MAX = 60

export function rememberThumb(name: string, uri: string): void {
  thumbs.delete(name)
  thumbs.set(name, uri)
  while (thumbs.size > MAX) thumbs.delete(thumbs.keys().next().value as string)
}

export const thumbFor = (name: string): string | undefined => thumbs.get(name)
