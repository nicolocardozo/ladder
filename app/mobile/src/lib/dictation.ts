// Dictation: pure logic only (text, level, language, model availability). The actual recognition is in
// features/composer/useDictation.ts, always on the phone (`requiresOnDeviceRecognition`): never network recognition.

/** After this much silence since the last text dictation stops by itself; and in any case after 5 minutes. */
export const SILENCE_MS = 6_000
export const MAX_DICTATION_MS = 5 * 60_000

/** Recognition language: the app's (BCP-47 with the most common region). */
export const dictationLocale = (lang: string): string => (lang === 'it' ? 'it-IT' : 'en-US')

/** Words that help recognition spell proper names correctly: Ladder, worktree and the project names. */
export function contextualStrings(projectNames: readonly string[]): string[] {
  const out = new Set<string>(['Ladder', 'worktree'])
  for (const n of projectNames) if (n.trim() && out.size < 100) out.add(n.trim())
  return [...out]
}

/** Field text while dictating: what was there before, a space if needed, the transcript. Without a transcript it stays as it was. */
export function mergeTranscript(base: string, transcript: string): string {
  const spoken = transcript.trim()
  if (!spoken) return base
  if (!base || /\s$/.test(base)) return base + spoken
  return `${base} ${spoken}`
}

/** Recognition volume goes from -2 (silence) to 10 (loud): maps it to 0..1. */
export function meterLevel(volume: number): number {
  if (!Number.isFinite(volume)) return 0
  return Math.max(0, Math.min(1, (volume + 2) / 12))
}

/** Languages like "it-IT" or "it_IT": the base "it" to compare them. */
const base = (tag: string): string => tag.toLowerCase().replace('_', '-').split('-')[0]

export type OnDevice = { ok: true; locale: string } | { ok: false; reason: 'unsupported' | 'not-installed'; locale: string }

/**
 * Can the language be dictated on the phone? `supported` = the service's languages; `installed` = those with the model already on the phone.
 * With empty lists (iOS does not always provide them) `supportsOnDevice` decides: the general flag from getSupportedLocales/supportsOnDeviceRecognition.
 */
export function onDeviceStatus(locale: string, supported: readonly string[], installed: readonly string[], supportsOnDevice: boolean): OnDevice {
  const want = base(locale)
  const has = (list: readonly string[]) => list.some((l) => l.toLowerCase().replace('_', '-') === locale.toLowerCase() || base(l) === want)
  if (!supportsOnDevice) return { ok: false, reason: 'unsupported', locale }
  if (installed.length > 0) return has(installed) ? { ok: true, locale } : { ok: false, reason: has(supported) ? 'not-installed' : 'unsupported', locale }
  return supported.length === 0 || has(supported) ? { ok: true, locale } : { ok: false, reason: 'unsupported', locale }
}
