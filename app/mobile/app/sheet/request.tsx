import { useLocalSearchParams } from 'expo-router'
import { RequestContent } from '@/features/request/RequestSheet'
import { useSheetClose } from '@/lib/use-sheet-close'
import { NativeSheet } from '@/ui/NativeSheet'

/** Richiesta dell'agente in un `formSheet` nativo (iOS). `fit=1`: permesso semplice, lo sheet è alto quanto il contenuto. */
export default function RequestRoute() {
  const { sessionId, requestId, fit } = useLocalSearchParams<{ sessionId: string; requestId: string; fit?: string }>()
  const close = useSheetClose()
  return (
    <NativeSheet fit={fit === '1'}>
      <RequestContent sessionId={sessionId} requestId={requestId} onClose={close} />
    </NativeSheet>
  )
}
