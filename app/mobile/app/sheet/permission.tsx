import { useLocalSearchParams } from 'expo-router'
import { PermissionContent } from '@/features/session/PermissionSheet'
import { useSheetClose } from '@/lib/use-sheet-close'
import { NativeSheet } from '@/ui/NativeSheet'

export default function PermissionRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>()
  const close = useSheetClose()
  return (
    <NativeSheet fit>
      <PermissionContent sessionId={sessionId} onClose={close} />
    </NativeSheet>
  )
}
