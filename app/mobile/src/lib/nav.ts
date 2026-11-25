import type { Href, useNavigationContainerRef, useRouter } from 'expo-router'
import { CommonActions } from 'expo-router/react-navigation'

/** Il contenitore di navigazione della radice, registrato da app/_layout.tsx. */
let root: ReturnType<typeof useNavigationContainerRef> | null = null
export const setRootNavigation = (ref: ReturnType<typeof useNavigationContainerRef> | null): void => {
  root = ref
}

/** Rotte della radice che `resetTo` sa ricostruire da sole: tutto il resto passa per router. */
const ROOT_ROUTE: Record<string, string> = { '/': '(tabs)', '/welcome': 'welcome' }

/**
 * Va a `href` svuotando la pila: il tasto indietro di Android non deve riportare a un passo dell'abbinamento o a una schermata
 * di un Mac scollegato, e sotto non deve restare un secondo `(tabs)`. Con i tab la pila della radice si azzera davvero
 * (dismissAll + replace da dentro una pila annidata lascerebbe i tab di prima sotto la schermata nuova).
 */
export function resetTo(router: ReturnType<typeof useRouter>, href: Href): void {
  const name = typeof href === 'string' ? ROOT_ROUTE[href] : undefined
  if (root && name) {
    root.dispatch(CommonActions.reset({ index: 0, routes: [{ name }] }))
    return
  }
  if (router.canDismiss()) router.dismissAll()
  router.replace(href)
}
