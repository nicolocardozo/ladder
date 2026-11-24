// Il link di abbinamento arrivato da fuori (deep link). expo-router lo vede prima che la schermata esista: lo intercetta
// app/+native-intent.tsx e lo parcheggia qui, la schermata /pair lo prende al montaggio. Solo in memoria, mai nei log.
let pending: string | null = null

export const setPendingPairLink = (link: string): void => {
  pending = link
}

/** Lo restituisce una volta sola. */
export function takePendingPairLink(): string | null {
  const link = pending
  pending = null
  return link
}

/** Link già letto (usato o scartato): `useURL` continua a restituire quello con cui l'app si è aperta, e non va riletto. */
let consumed: string | null = null
export const markConsumed = (link: string): void => {
  consumed = link
}
export const wasConsumed = (link: string): boolean => consumed === link
