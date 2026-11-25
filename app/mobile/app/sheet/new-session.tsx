import { NewSessionContent } from '@/features/sheets/NewSessionContent'
import { useSheetClose } from '@/lib/use-sheet-close'
import { NativeSheet } from '@/ui/NativeSheet'

// Lo sheet è alto quanto il contenuto (NativeSheet `fit`); con la tastiera su, campo e Invia restano sopra di essa e, se non ci stanno, il contenuto scorre.
export default function NewSessionRoute() {
  const close = useSheetClose()
  return (
    <NativeSheet fit>
      <NewSessionContent onClose={close} />
    </NativeSheet>
  )
}
