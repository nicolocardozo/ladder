// Testo in streaming mostrato a ritmo costante: i pezzi arrivano a scatti, l'occhio vede scorrere. Idea da Paseo
// (packages/app/src/agent-stream/text-reveal.ts), riscritta: velocità base fissa, più alta solo se si accumula ritardo.
const BASE_CPS = 70
/** Se il ritardo supera questo numero di caratteri si accelera, per non restare indietro di pagine. */
const CATCH_UP_AT = 120

/** Quanti caratteri mostrare dopo `dtMs`, dato quanti ne sono già visibili e il testo disponibile. */
export function nextRevealLength(shown: number, available: number, dtMs: number): number {
  if (shown >= available) return available
  const backlog = available - shown
  const cps = BASE_CPS + (backlog > CATCH_UP_AT ? (backlog - CATCH_UP_AT) * 4 : 0)
  const step = Math.max(1, Math.round((cps * dtMs) / 1000))
  return Math.min(available, shown + step)
}

/** Taglia su un confine di parola/carattere intero (evita di spezzare una coppia surrogata). */
export function sliceReveal(text: string, length: number): string {
  if (length >= text.length) return text
  const code = text.charCodeAt(length - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length + 1 : length)
}
