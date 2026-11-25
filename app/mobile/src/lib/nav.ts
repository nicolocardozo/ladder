import type { Href, useNavigationContainerRef, useRouter } from 'expo-router'
import { CommonActions } from 'expo-router/react-navigation'

/** The root navigation container, registered by app/_layout.tsx. */
let root: ReturnType<typeof useNavigationContainerRef> | null = null
export const setRootNavigation = (ref: ReturnType<typeof useNavigationContainerRef> | null): void => {
  root = ref
}

/** Root routes that `resetTo` can rebuild by itself: everything else goes through router. */
const ROOT_ROUTE: Record<string, string> = { '/': '(tabs)', '/welcome': 'welcome' }

/**
 * Goes to `href` clearing the stack: Android's back button must not lead back to a pairing step or to a screen
 * of a disconnected Mac, and no second `(tabs)` must remain underneath. With tabs the root stack is truly reset
 * (dismissAll + replace from inside a nested stack would leave the previous tabs under the new screen).
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

/** The foreground (innermost) screen with its parameters, or null. Used to know "where we are" when opening a sheet. */
export function focusedRoute(): { name: string; params?: Record<string, unknown> } | null {
  return (root?.getCurrentRoute() as { name: string; params?: Record<string, unknown> } | undefined) ?? null
}

/** Root screens that sit above the tabs (chat, Plan limits): from there a tabs route must not be opened on top, go back to the tabs first. */
const ROOT_SCREENS = ['session/', 'limits']
const onRootScreen = (name: string | undefined): boolean => !!name && ROOT_SCREENS.some((p) => name.startsWith(p))

/**
 * Opens a tabs route (Waiting, a project, Mac) from anywhere, even with a chat or "Plan limits" in the foreground
 * (wide layout: the Home pinned on the left stays always tappable). First go back to the tabs, then go: otherwise the route would open
 * a second (tabs) over the chat, with no back button.
 */
export function openInTabs(router: ReturnType<typeof useRouter>, href: Href, how: 'push' | 'navigate' = 'push'): void {
  if (onRootScreen(focusedRoute()?.name) && router.canDismiss()) router.dismissAll()
  if (how === 'navigate') router.navigate(href)
  else router.push(href)
}

/**
 * Opens a session's chat (root route). If a chat is already open it is replaced, so taps do not stack chats one
 * on top of the other; `onSession` says whether there is a chat underneath when the foreground route is unreliable (a sheet that is closing).
 */
export function openSession(router: ReturnType<typeof useRouter>, sessionId: string, onSession?: boolean): void {
  const there = onSession ?? focusedRoute()?.name?.startsWith('session/') ?? false
  const href = { pathname: '/session/[id]', params: { id: sessionId } } as const
  if (there) router.replace(href)
  else router.push(href)
}
