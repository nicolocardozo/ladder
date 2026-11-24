// Sessioni di un progetto divise per i gruppi del Mac (ui[projectId].groups / groupOf).
import { useRouter } from 'expo-router'
import { useMemo, type ReactElement } from 'react'
import { FlatList, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '@shared/i18n'
import type { SessionSummary } from '@shared/protocol'
import { groupProjectSessions } from '@/lib/home-model'
import { useApp } from '@/store/app'
import { Text } from '@/ui/Text'
import { SessionRow } from './SessionRow'

type Item = { kind: 'header'; name: string; key: string } | { kind: 'session'; session: SessionSummary }

export function ProjectSessions({ projectId, header }: { projectId: string; header?: ReactElement }) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const sessionsMap = useApp((s) => s.sessions)
  const ui = useApp((s) => s.ui[projectId])
  const items = useMemo<Item[]>(() => {
    const list = Object.values(sessionsMap).filter((s) => s.projectId === projectId && !s.archived)
    const groups = groupProjectSessions(list, ui)
    const out: Item[] = []
    for (const g of groups) {
      if (g.name) out.push({ kind: 'header', name: g.name, key: `g-${g.id}` })
      for (const s of g.sessions) out.push({ kind: 'session', session: s })
    }
    return out
  }, [sessionsMap, ui, projectId])
  return (
    <FlatList
      data={items}
      ListHeaderComponent={header}
      keyExtractor={(i) => (i.kind === 'header' ? i.key : i.session.id)}
      renderItem={({ item }) =>
        item.kind === 'header' ? (
          <Text variant="label" tone="muted" style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 6 }} accessibilityRole="header">
            {item.name}
          </Text>
        ) : (
          <View style={{ paddingHorizontal: 4 }}>
            <SessionRow session={item.session} onPress={() => router.push({ pathname: '/session/[id]', params: { id: item.session.id } })} />
          </View>
        )
      }
      ListEmptyComponent={
        <View style={{ paddingHorizontal: 32, paddingTop: 48, alignItems: 'center', gap: 6 }}>
          <Text variant="title">{t('No sessions yet')}</Text>
          <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
            {t('Start a session on your Mac and it will appear here.')}
          </Text>
        </View>
      }
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      showsVerticalScrollIndicator={false}
    />
  )
}
