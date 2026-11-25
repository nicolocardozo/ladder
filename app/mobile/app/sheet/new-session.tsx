import { NewSessionContent } from '@/features/sheets/NewSessionContent'
import { useSheetClose } from '@/lib/use-sheet-close'
import { NativeSheet } from '@/ui/NativeSheet'

// The sheet is as tall as the content (NativeSheet `fit`); with the keyboard up, the field and Send stay above it and, if they don't fit, the content scrolls.
export default function NewSessionRoute() {
  const close = useSheetClose()
  return (
    <NativeSheet fit>
      <NewSessionContent onClose={close} />
    </NativeSheet>
  )
}
