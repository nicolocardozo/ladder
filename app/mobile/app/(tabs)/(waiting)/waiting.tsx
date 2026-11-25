import { Stack, useRouter } from 'expo-router'
import { useMemo } from 'react'
import { FlatList, View } from 'react-native'
import { t } from '@shared/i18n'
import { RequestCard } from '@/features/request/RequestCard'
import { openSheet } from '@/lib/sheets'
import { useApp } from '@/store/app'
import { useLanguage } from '@/store/prefs'
import { useTheme } from '@/theme/theme'
import { Text } from '@/ui/Text'

/** "Waiting for you": le richieste aperte di tutte le sessioni, dalla più vecchia. */
export default function Waiting() {
  const { c } = useTheme()
  const router = useRouter()
  useLanguage()
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
      <Stack.Screen options={{ title: t('Waiting for you'), headerLargeTitleEnabled: true }} />
      <FlatList
        style={{ backgroundColor: c.background }}
        data={waiting}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <RequestCard
            session={item}
            onReview={(sessionId, requestId) => openSheet(router, { kind: 'request', sessionId, requestId })}
            onOpenSession={() => router.push({ pathname: '/session/[id]', params: { id: item.id } })}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, paddingBottom: 24, flexGrow: 1 }}
        ListEmptyComponent={
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingBottom: 80 }}>
            <Text variant="title">{t('All clear')}</Text>
            <Text variant="body" tone="muted">
              {t('Nobody is waiting for you.')}
            </Text>
          </View>
        }
      />
    </>
  )
}
