import type { Href, useRouter } from 'expo-router'

/** Va a `href` svuotando la pila: il tasto indietro di Android non deve riportare a un passo dell'abbinamento o a una schermata di un Mac scollegato. */
export function resetTo(router: ReturnType<typeof useRouter>, href: Href): void {
  if (router.canDismiss()) router.dismissAll()
  router.replace(href)
}
