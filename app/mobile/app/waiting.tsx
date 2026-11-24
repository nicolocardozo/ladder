import { useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { FlatList, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { plural, t } from '@shared/i18n'
import { RequestCard } from '@/features/request/RequestCard'
import { RequestSheet } from '@/features/request/RequestSheet'
import { useApp } from '@/store/app'
import { useTheme } from '@/theme/theme'
import { ScreenHeader } from '@/ui/ScreenHeader'
import { Text } from '@/ui/Text'

/** "Waiting for you": le richieste aperte di tutte le sessioni, dalla più vecchia. */
export default function Waiting() {
  const { c } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const sessionsMap = useApp((s) => s.sessions)
  const waiting = useMemo(
    () =>
      Object.values(sessionsMap)
        .filter((s) => s.run === 'waiting' && !s.archived)
        .sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0)),
    [sessionsMap]
  )
  const [sheet, setSheet] = useState<{ sessionId: string; requestId: string } | null>(null)
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title={t('Waiting for you')} subtitle={waiting.length ? plural(waiting.length, '1 session', '{n} sessions') : undefined} />
      <FlatList
        data={waiting}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => <RequestCard session={item} onReview={(sessionId, requestId) => setSheet({ sessionId, requestId })} onOpenSession={() => router.push({ pathname: '/session/[id]', params: { id: item.id } })} />}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        ListEmptyComponent={
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingBottom: 80 }}>
            <Text variant="title">{t('All clear')}</Text>
            <Text variant="body" tone="muted">
              {t('Nobody is waiting for you.')}
            </Text>
          </View>
        }
      />
      <RequestSheet sessionId={sheet?.sessionId ?? null} requestId={sheet?.requestId ?? null} onClose={() => setSheet(null)} />
    </View>
  )
}
