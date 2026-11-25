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

/** La schermata in primo piano (la più interna) con i suoi parametri, o null. Serve a sapere "dove si è" quando si apre uno sheet. */
export function focusedRoute(): { name: string; params?: Record<string, unknown> } | null {
  return (root?.getCurrentRoute() as { name: string; params?: Record<string, unknown> } | undefined) ?? null
}

/** Schermate della radice che stanno sopra i tab (chat, Plan limits): da lì una rotta dei tab non va aperta sopra, si torna prima ai tab. */
const ROOT_SCREENS = ['session/', 'limits']
const onRootScreen = (name: string | undefined): boolean => !!name && ROOT_SCREENS.some((p) => name.startsWith(p))

/**
 * Apre una rotta dei tab (Waiting, un progetto, Mac) da qualunque punto, anche con una chat o "Plan limits" in primo piano
 * (layout largo: la Home fissa a sinistra resta sempre toccabile). Prima si torna ai tab, poi si va: senza, la rotta aprirebbe
 * un secondo (tabs) sopra la chat, senza tasto indietro.
 */
export function openInTabs(router: ReturnType<typeof useRouter>, href: Href, how: 'push' | 'navigate' = 'push'): void {
  if (onRootScreen(focusedRoute()?.name) && router.canDismiss()) router.dismissAll()
  if (how === 'navigate') router.navigate(href)
  else router.push(href)
}

/**
 * Apre la chat di una sessione (rotta della radice). Se è già aperta una chat si sostituisce, così i tocchi non impilano chat una
 * sull'altra; `onSession` dice se sotto c'è una chat quando la rotta in primo piano non è affidabile (uno sheet che si sta chiudendo).
 */
export function openSession(router: ReturnType<typeof useRouter>, sessionId: string, onSession?: boolean): void {
  const there = onSession ?? focusedRoute()?.name?.startsWith('session/') ?? false
  const href = { pathname: '/session/[id]', params: { id: sessionId } } as const
  if (there) router.replace(href)
  else router.push(href)
}
