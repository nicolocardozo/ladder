// Nuova sessione: segnaposto. Il modulo vero è LAD-89 (il Mac non accetta ancora `session.create` dal telefono).
import { View } from 'react-native'
import { t } from '@shared/i18n'
import { Button } from '@/ui/Button'
import { SheetTitle } from '@/ui/NativeSheet'
import { Text } from '@/ui/Text'

export function NewSessionContent({ onClose }: { onClose: () => void }) {
  return (
    <>
      <SheetTitle>{t('New session')}</SheetTitle>
      <View style={{ paddingHorizontal: 20, gap: 16 }}>
        <Text variant="body" tone="muted">
          {t('Starting a session from your phone is coming soon. For now, start it on your Mac and it will show up here.')}
        </Text>
        <Button label={t('Close')} onPress={onClose} />
      </View>
    </>
  )
}
