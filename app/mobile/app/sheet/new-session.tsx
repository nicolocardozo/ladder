import { NewSessionContent } from '@/features/sheets/NewSessionContent'
import { useSheetClose } from '@/lib/use-sheet-close'
import { NativeSheet } from '@/ui/NativeSheet'

// Il modulo ha scelte che cambiano l'altezza (opzioni, elenchi): niente `fit`: altezza piena e il contenuto scorre (con la tastiera su si sposta sopra di essa).
export default function NewSessionRoute() {
  const close = useSheetClose()
  return (
    <NativeSheet>
      <NewSessionContent onClose={close} />
    </NativeSheet>
  )
}
