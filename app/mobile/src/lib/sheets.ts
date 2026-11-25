// Apertura degli sheet. Su iOS (telefono) sono rotte `formSheet` native (app/sheet/*, dati nei parametri e in questo store);
// su Android e da 600 pt in su restano gli sheet nostri (ui/Sheet.tsx), montati da SheetHost.
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

interface SheetsState {
  /** Lo sheet aperto con le implementazioni nostre (Android, schermi larghi). */
  current: SheetSpec | null
  /** Il turno mostrato: troppo grosso per i parametri di una rotta, resta qui. */
  turn: TurnSummary | null
  /** Il progetto in cui si era quando si è aperto "Nuova sessione" (schermata del progetto o di una sua sessione). */
  newSessionProject: string | null
  close: () => void
}

export const useSheets = create<SheetsState>((set) => ({ current: null, turn: null, newSessionProject: null, close: () => set((st) => (st.current ? { current: null } : st)) }))

/** I sheet sono rotte native? Solo su iOS e sotto i 600 pt. */
export const nativeSheets = (): boolean => IOS && Dimensions.get('window').width < WIDE

type Router = ReturnType<typeof useRouter>

/** Il progetto della schermata in primo piano: quello aperto, o quello della sessione aperta. */
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
      // Un permesso semplice (niente domande né anteprima) sta in uno sheet alto quanto il contenuto; il resto scorre.
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
  }
}
