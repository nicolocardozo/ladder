// Opening of sheets. On iOS (phone) they are native `formSheet` routes (app/sheet/*, data in the params and in this store);
// on Android and from 600 pt up our own sheets stay (ui/Sheet.tsx), mounted by SheetHost.
import type { useRouter } from 'expo-router'
import { Dimensions } from 'react-native'
import { create } from 'zustand'
import type { RequestItem, TurnSummary } from '@/lib/turns'
import { focusedRoute } from '@/lib/nav'
import { IOS } from '@/lib/platform'
import { useApp } from '@/store/app'
import { WIDE } from '@/ui/Sheet'

export type SheetSpec =
  | { kind: 'request'; sessionId: string; requestId: string }
  | { kind: 'permission'; sessionId: string }
  | { kind: 'switch'; sessionId: string }
  | { kind: 'turn'; sessionId: string; turn: TurnSummary }
  | { kind: 'new-session' }
  | { kind: 'mac' }

interface SheetsState {
  /** The sheet opened with our own implementations (Android, wide screens). */
  current: SheetSpec | null
  /** The turn shown: too big for a route's params, it stays here. */
  turn: TurnSummary | null
  /** The project we were in when "New session" was opened (project screen or one of its sessions). */
  newSessionProject: string | null
  close: () => void
}

export const useSheets = create<SheetsState>((set) => ({ current: null, turn: null, newSessionProject: null, close: () => set((st) => (st.current ? { current: null } : st)) }))

/** Are sheets native routes? Only on iOS and below 600 pt. */
export const nativeSheets = (): boolean => IOS && Dimensions.get('window').width < WIDE

type Router = ReturnType<typeof useRouter>

/** The project of the foreground screen: the open one, or that of the open session. */
function projectInView(): string | null {
  const route = focusedRoute()
  const id = typeof route?.params?.id === 'string' ? route.params.id : null
  if (!id || !route) return null
  if (route.name.startsWith('project/')) return useApp.getState().projects.some((p) => p.id === id) ? id : null
  if (route.name.startsWith('session/')) return useApp.getState().sessions[id]?.projectId ?? null
  return null
}

export function openSheet(router: Router, spec: SheetSpec): void {
  if (spec.kind === 'new-session') useSheets.setState({ newSessionProject: projectInView() })
  if (!nativeSheets()) {
    useSheets.setState({ current: spec, turn: spec.kind === 'turn' ? spec.turn : null })
    return
  }
  switch (spec.kind) {
    case 'request': {
      // A simple permission (no questions or preview) goes in a sheet as tall as its content; the rest scrolls.
      const st = useApp.getState()
      const r: RequestItem | null | undefined = st.items[spec.sessionId]?.find((i): i is RequestItem => i.kind === 'request' && i.requestId === spec.requestId) ?? st.sessions[spec.sessionId]?.request
      const fit = !!r && r.requestType !== 'question' && !r.preview
      router.push({ pathname: '/sheet/request', params: { sessionId: spec.sessionId, requestId: spec.requestId, ...(fit ? { fit: '1' } : {}) } })
      break
    }
    case 'permission':
      router.push({ pathname: '/sheet/permission', params: { sessionId: spec.sessionId } })
      break
    case 'switch':
      router.push({ pathname: '/sheet/switch', params: { sessionId: spec.sessionId } })
      break
    case 'turn':
      useSheets.setState({ turn: spec.turn })
      router.push({ pathname: '/sheet/turn', params: { sessionId: spec.sessionId } })
      break
    case 'new-session':
      router.push('/sheet/new-session')
      break
    case 'mac':
      router.push('/sheet/mac')
      break
  }
}
