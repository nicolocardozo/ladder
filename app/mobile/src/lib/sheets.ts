// Apertura degli sheet. Su iOS (telefono) sono rotte `formSheet` native (app/sheet/*, dati nei parametri e in questo store);
// su Android e da 600 pt in su restano gli sheet nostri (ui/Sheet.tsx), montati da SheetHost.
import type { useRouter } from 'expo-router'
import { Dimensions } from 'react-native'
import { create } from 'zustand'
import type { RequestItem, TurnSummary } from '@/lib/turns'
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
  close: () => void
}

export const useSheets = create<SheetsState>((set) => ({ current: null, turn: null, close: () => set((st) => (st.current ? { current: null } : st)) }))

/** I sheet sono rotte native? Solo su iOS e sotto i 600 pt. */
export const nativeSheets = (): boolean => IOS && Dimensions.get('window').width < WIDE

type Router = ReturnType<typeof useRouter>

export function openSheet(router: Router, spec: SheetSpec): void {
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
