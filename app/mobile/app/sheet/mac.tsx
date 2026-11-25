import { MacContent } from '@/features/mac/MacContent'
import { NativeSheet, SheetTitle } from '@/ui/NativeSheet'
import { t } from '@shared/i18n'

// The Mac and the connection above the Home: it closes and you go back there (no jump to Settings).
export default function MacRoute() {
  return (
    <NativeSheet fit>
      <SheetTitle>{t('Your Mac')}</SheetTitle>
      <MacContent sheet />
    </NativeSheet>
  )
}
