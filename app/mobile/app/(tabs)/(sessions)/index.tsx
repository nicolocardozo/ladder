import { Stack, useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { useWindowDimensions, View } from 'react-native'
import { t } from '@shared/i18n'
import { HomeContent } from '@/features/home/HomeContent'
import { IOS } from '@/lib/platform'
import { openSheet } from '@/lib/sheets'
import { useLanguage } from '@/store/prefs'
import { useTheme } from '@/theme/theme'
import { IconButton } from '@/ui/Button'
import { Text } from '@/ui/Text'
import { WIDE } from '@/ui/Sheet'

/** Tab Sessions: "Now" e le sezioni dei progetti. La ricerca è la barra nativa dell'header (su iOS compare tirando giù). */
export default function Sessions() {
  const { c } = useTheme()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const [query, setQuery] = useState('')
  const language = useLanguage()
  const options = useMemo(
    () => ({
      title: t('Sessions'),
      headerLargeTitleEnabled: true,
      headerSearchBarOptions: {
        placeholder: t('Search sessions'),
        placement: 'stacked' as const,
        autoCapitalize: 'none' as const,
        tintColor: c.accent,
        textColor: c.text,
        hintTextColor: c.textMuted,
        headerIconColor: c.textMuted,
        barTintColor: c.surface,
        onChangeText: (e: { nativeEvent: { text: string } }) => setQuery(e.nativeEvent.text),
        onCancelButtonPress: () => setQuery(''),
        onClose: () => setQuery('')
      },
      // Su iOS "Nuova sessione" è il "+" staccato della barra dei tab; su Android è il pulsante in alto a destra.
      ...(IOS ? {} : { headerRight: () => <IconButton icon="plus" label={t('New session')} onPress={() => openSheet(router, { kind: 'new-session' })} /> })
    }),
    [c.accent, c.text, c.textMuted, c.surface, router, language]
  )
  // Su schermi larghi la Home sta già a sinistra: qui resta un segnaposto.
  if (width >= WIDE)
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text variant="title" tone="muted">
            {t('Pick a session')}
          </Text>
        </View>
      </>
    )
  return (
    <>
      <Stack.Screen options={options} />
      <HomeContent query={query} />
    </>
  )
}
