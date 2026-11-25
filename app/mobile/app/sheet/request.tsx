import { useLocalSearchParams } from 'expo-router'
import { RequestContent } from '@/features/request/RequestSheet'
import { useSheetClose } from '@/lib/use-sheet-close'
import { NativeSheet } from '@/ui/NativeSheet'

/** Agent request in a native `formSheet` (iOS). `fit=1`: simple permission, the sheet is as tall as the content. */
export default function RequestRoute() {
  const { sessionId, requestId, fit } = useLocalSearchParams<{ sessionId: string; requestId: string; fit?: string }>()
  const close = useSheetClose()
  return (
    <NativeSheet fit={fit === '1'}>
      <RequestContent sessionId={sessionId} requestId={requestId} onClose={close} />
    </NativeSheet>
  )
}
