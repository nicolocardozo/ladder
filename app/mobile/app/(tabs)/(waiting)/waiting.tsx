import { Stack, useRouter } from 'expo-router'
import { useMemo } from 'react'
import { FlatList, View } from 'react-native'
import { t } from '@shared/i18n'
import { RequestCard } from '@/features/request/RequestCard'
import { openSession } from '@/lib/nav'
import { openSheet } from '@/lib/sheets'
import { useApp } from '@/store/app'
import { useLanguage } from '@/store/prefs'
import { useTheme } from '@/theme/theme'
import { TabHeader, useTabHeaderPad } from '@/ui/TabHeader'
import { Text } from '@/ui/Text'

/** Requests: the open requests of all sessions, oldest first. */
export default function Waiting() {
  const { c } = useTheme()
  const router = useRouter()
  useLanguage()
  const headerPad = useTabHeaderPad()
  const sessionsMap = useApp((s) => s.sessions)
  const waiting = useMemo(
    () =>
      Object.values(sessionsMap)
        .filter((s) => s.run === 'waiting' && !s.archived)
        .sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0)),
    [sessionsMap]
  )
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <FlatList
        style={{ backgroundColor: c.background }}
        data={waiting}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <RequestCard
            session={item}
            onReview={(sessionId, requestId) => openSheet(router, { kind: 'request', sessionId, requestId })}
            onOpenSession={() => openSession(router, item.id)}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: headerPad + 4, paddingBottom: 24, flexGrow: 1 }}
        scrollIndicatorInsets={{ top: headerPad }}
        ListEmptyComponent={
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingBottom: 80 }}>
            <Text variant="title">{t('No open requests')}</Text>
            <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
              {t('Your agents ask here when they need you.')}
            </Text>
          </View>
        }
      />
      <TabHeader title={t('Requests')} />
    </>
  )
}
