// Impostazione "Theme": Same as Mac (predefinito) o un tema scelto; "Match system appearance" con un tema chiaro e uno scuro.
import { ScrollView, View } from 'react-native'
import { t } from '@shared/i18n'
import { usePrefs } from '@/store/prefs'
import { THEMES, useTheme, type ThemeId, type ThemeInfo } from '@/theme/theme'
import { Group, Row, ToggleRow } from '@/ui/List'

function Swatch({ theme }: { theme: ThemeInfo }) {
  const k = theme.tokens
  return (
    <View style={{ width: 44, height: 28, borderRadius: 7, backgroundColor: k.background, borderWidth: 1, borderColor: k.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: k.accent }} />
      <View style={{ width: 8, height: 8, borderRadius: 1.5, backgroundColor: k.waiting }} />
      <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 2, borderColor: k.running }} />
    </View>
  )
}

function ThemeRow({ theme, selected, onPress, last }: { theme: ThemeInfo; selected: boolean; onPress: () => void; last?: boolean }) {
  return <Row label={theme.name} detail={theme.appearance === 'dark' ? t('Dark') : t('Light')} selected={selected} onPress={onPress} last={last} right={<Swatch theme={theme} />} />
}

export default function ThemeScreen() {
  const { c } = useTheme()
  const prefs = usePrefs((s) => s.theme)
  const setTheme = usePrefs((s) => s.setTheme)
  const light = THEMES.filter((x) => x.appearance === 'light')
  const dark = THEMES.filter((x) => x.appearance === 'dark')
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: 32 }}>
        <Group footer={t('Same as Mac follows the theme your Mac uses. Until your Mac sends it, Circuit is used.')}>
          <ToggleRow label={t('Match system appearance')} detail={t('One light and one dark theme that follow your phone.')} value={prefs.matchSystem} onChange={(v) => setTheme({ matchSystem: v })} last />
        </Group>
        {prefs.matchSystem ? (
          <>
            <Group title={t('Light appearance')}>
              {light.map((x, i) => (
                <ThemeRow key={x.id} theme={x} selected={prefs.lightTheme === x.id} onPress={() => setTheme({ lightTheme: x.id as ThemeId })} last={i === light.length - 1} />
              ))}
            </Group>
            <Group title={t('Dark appearance')}>
              {dark.map((x, i) => (
                <ThemeRow key={x.id} theme={x} selected={prefs.darkTheme === x.id} onPress={() => setTheme({ darkTheme: x.id as ThemeId })} last={i === dark.length - 1} />
              ))}
            </Group>
          </>
        ) : (
          <>
            <Group>
              <Row label={t('Same as Mac')} selected={prefs.choice === 'mac'} onPress={() => setTheme({ choice: 'mac' })} last />
            </Group>
            <Group title={t('Dark')}>
              {dark.map((x, i) => (
                <ThemeRow key={x.id} theme={x} selected={prefs.choice === x.id} onPress={() => setTheme({ choice: x.id as ThemeId })} last={i === dark.length - 1} />
              ))}
            </Group>
            <Group title={t('Light')}>
              {light.map((x, i) => (
                <ThemeRow key={x.id} theme={x} selected={prefs.choice === x.id} onPress={() => setTheme({ choice: x.id as ThemeId })} last={i === light.length - 1} />
              ))}
            </Group>
          </>
        )}
    </ScrollView>
  )
}
