import { Stack, useRouter } from 'expo-router'
import { View } from 'react-native'
import { useWindowDimensions } from 'react-native'
import { t } from '@shared/i18n'
import { HomeContent } from '@/features/home/HomeContent'
import { IOS } from '@/lib/platform'
import { openSheet } from '@/lib/sheets'
import { useLanguage } from '@/store/prefs'
import { IconButton } from '@/ui/Button'
import { ConnectionPill } from '@/ui/ConnectionPill'
import { TabHeader } from '@/ui/TabHeader'
import { Text } from '@/ui/Text'
import { WIDE } from '@/ui/Sheet'

/** Sessions tab: "Now" and the project sections. Title and Mac pill on the same row; search is the first item of the list. */
export default function Sessions() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  useLanguage()
  // On wide screens the Home is already docked on the left: only a placeholder remains here.
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
      <Stack.Screen options={{ headerShown: false }} />
      <HomeContent />
      {/* On iOS "New session" is the detached "+" of the tab bar; on Android it is the button next to the pill. */}
      <TabHeader
        title={t('Sessions')}
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
            <ConnectionPill />
            {IOS ? null : <IconButton icon="plus" label={t('New session')} onPress={() => openSheet(router, { kind: 'new-session' })} />}
          </View>
        }
      />
    </>
  )
}
