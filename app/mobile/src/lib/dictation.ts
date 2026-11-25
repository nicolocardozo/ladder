// Dettatura (LAD-92): solo logica pura (testo, livello, lingua, disponibilità del modello). Il riconoscimento vero è in
// features/composer/useDictation.ts, sempre sul telefono (`requiresOnDeviceRecognition`): mai il riconoscimento di rete.

/** Dopo tanto silenzio dall'ultimo testo la dettatura si ferma da sola; e comunque dopo 5 minuti. */
export const SILENCE_MS = 6_000
export const MAX_DICTATION_MS = 5 * 60_000

/** Lingua del riconoscimento: quella dell'app (BCP-47 con la regione più comune). */
export const dictationLocale = (lang: string): string => (lang === 'it' ? 'it-IT' : 'en-US')

/** Parole che aiutano il riconoscimento a scrivere bene nomi propri: Ladder, worktree e i nomi dei progetti. */
export function contextualStrings(projectNames: readonly string[]): string[] {
  const out = new Set<string>(['Ladder', 'worktree'])
  for (const n of projectNames) if (n.trim() && out.size < 100) out.add(n.trim())
  return [...out]
}

/** Testo del campo mentre si detta: quello di prima, uno spazio se serve, la trascrizione. Senza trascrizione resta com'era. */
export function mergeTranscript(base: string, transcript: string): string {
  const spoken = transcript.trim()
  if (!spoken) return base
  if (!base || /\s$/.test(base)) return base + spoken
  return `${base} ${spoken}`
}

/** Il volume del riconoscimento va da -2 (silenzio) a 10 (forte): lo porta a 0..1. */
export function meterLevel(volume: number): number {
  if (!Number.isFinite(volume)) return 0
  return Math.max(0, Math.min(1, (volume + 2) / 12))
}

/** Lingue come "it-IT" o "it_IT": la base "it" per confrontarle. */
const base = (tag: string): string => tag.toLowerCase().replace('_', '-').split('-')[0]

export type OnDevice = { ok: true; locale: string } | { ok: false; reason: 'unsupported' | 'not-installed'; locale: string }

/**
 * La lingua si può dettare sul telefono? `supported` = lingue del servizio; `installed` = quelle con il modello già sul telefono.
 * Con elenchi vuoti (iOS non li dà sempre) si decide `supportsOnDevice`: il flag generale di getSupportedLocales/supportsOnDeviceRecognition.
 */
export function onDeviceStatus(locale: string, supported: readonly string[], installed: readonly string[], supportsOnDevice: boolean): OnDevice {
  const want = base(locale)
  const has = (list: readonly string[]) => list.some((l) => l.toLowerCase().replace('_', '-') === locale.toLowerCase() || base(l) === want)
  if (!supportsOnDevice) return { ok: false, reason: 'unsupported', locale }
  if (installed.length > 0) return has(installed) ? { ok: true, locale } : { ok: false, reason: has(supported) ? 'not-installed' : 'unsupported', locale }
  return supported.length === 0 || has(supported) ? { ok: true, locale } : { ok: false, reason: 'unsupported', locale }
}
