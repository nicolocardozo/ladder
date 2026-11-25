import { MacContent } from '@/features/mac/MacContent'
import { NativeSheet, SheetTitle } from '@/ui/NativeSheet'
import { t } from '@shared/i18n'

// Il Mac e la connessione sopra la Home: si chiude e si torna lì (niente salto alle Impostazioni).
export default function MacRoute() {
  return (
    <NativeSheet fit>
      <SheetTitle>{t('Your Mac')}</SheetTitle>
      <MacContent sheet />
    </NativeSheet>
  )
}
