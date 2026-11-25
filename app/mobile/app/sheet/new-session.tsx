import { NewSessionContent } from '@/features/sheets/NewSessionContent'
import { useSheetClose } from '@/lib/use-sheet-close'
import { NativeSheet } from '@/ui/NativeSheet'

export default function NewSessionRoute() {
  const close = useSheetClose()
  return (
    <NativeSheet fit>
      <NewSessionContent onClose={close} />
    </NativeSheet>
  )
}
