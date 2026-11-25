import { ScrollView } from 'react-native'
import { LOCALES, t } from '@shared/i18n'
import { usePrefs } from '@/store/prefs'
import { useTheme } from '@/theme/theme'
import { Group, Row } from '@/ui/List'

export default function Language() {
  const { c } = useTheme()
  const language = usePrefs((s) => s.language)
  const setLanguage = usePrefs((s) => s.setLanguage)
  const options: { id: 'system' | 'en' | 'it'; name: string }[] = [{ id: 'system', name: t('System') }, ...LOCALES.map((l) => ({ id: l.id, name: l.name }))]
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentInsetAdjustmentBehavior="automatic">
      <Group footer={t('Ladder on your Mac keeps its own language.')}>
        {options.map((o, i) => (
          <Row key={o.id} label={o.name} selected={language === o.id} onPress={() => setLanguage(o.id)} last={i === options.length - 1} />
        ))}
      </Group>
    </ScrollView>
  )
}
