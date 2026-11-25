// Streaming text shown at a steady pace: chunks arrive in bursts, the eye sees a smooth flow. Idea from Paseo
// (packages/app/src/agent-stream/text-reveal.ts), rewritten: fixed base speed, higher only if lag builds up.
const BASE_CPS = 70
/** If the lag exceeds this number of characters it speeds up, so as not to fall behind by pages. */
const CATCH_UP_AT = 120

/** How many characters to show after `dtMs`, given how many are already visible and the available text. */
export function nextRevealLength(shown: number, available: number, dtMs: number): number {
  if (shown >= available) return available
  const backlog = available - shown
  const cps = BASE_CPS + (backlog > CATCH_UP_AT ? (backlog - CATCH_UP_AT) * 4 : 0)
  const step = Math.max(1, Math.round((cps * dtMs) / 1000))
  return Math.min(available, shown + step)
}

/** Cuts on a whole word/character boundary (avoids splitting a surrogate pair). */
export function sliceReveal(text: string, length: number): string {
  if (length >= text.length) return text
  const code = text.charCodeAt(length - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length + 1 : length)
}
