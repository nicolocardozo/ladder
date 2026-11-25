import { useLocalSearchParams } from 'expo-router'
import { SwitchContent } from '@/features/session/SwitchSheet'
import { useSheetClose } from '@/lib/use-sheet-close'
import { NativeSheet } from '@/ui/NativeSheet'

export default function SwitchRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>()
  const close = useSheetClose()
  return (
    <NativeSheet>
      <SwitchContent sessionId={sessionId} onClose={close} />
    </NativeSheet>
  )
}
