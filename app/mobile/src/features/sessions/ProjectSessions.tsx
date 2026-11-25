// Sessioni di un progetto divise per i gruppi del Mac (ui[projectId].groups / groupOf).
import { useRouter } from 'expo-router'
import { useMemo, useState, type ReactElement } from 'react'
import { FlatList, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '@shared/i18n'
import type { SessionSummary } from '@shared/protocol'
import { request } from '@/host/controller'
import { groupProjectSessions } from '@/lib/home-model'
import { openSession } from '@/lib/nav'
import { useToast } from '@/ui/toast'
import { Button } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import { useTheme } from '@/theme/theme'
import { useApp } from '@/store/app'
import { Text } from '@/ui/Text'
import { SessionRow } from './SessionRow'

type Item = { kind: 'header'; name: string; key: string } | { kind: 'session'; session: SessionSummary }

/** `native`: sotto un header e sopra la barra dei tab nativi (default); `false` nel pannello fisso a sinistra, che non li ha. */
export function ProjectSessions({ projectId, header, native = true }: { projectId: string; header?: ReactElement; native?: boolean }) {
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
      ListFooterComponent={<ArchivedSection projectId={projectId} />}
      keyExtractor={(i) => (i.kind === 'header' ? i.key : i.session.id)}
      renderItem={({ item }) =>
        item.kind === 'header' ? (
          <Text variant="label" tone="muted" style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 6 }} accessibilityRole="header">
            {item.name}
          </Text>
        ) : (
          <View style={{ paddingHorizontal: 4 }}>
            <SessionRow session={item.session} onPress={() => openSession(router, item.session.id)} />
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
      contentContainerStyle={{ paddingBottom: native ? 24 : insets.bottom + 24 }}
      contentInsetAdjustmentBehavior={native ? 'automatic' : 'never'}
      showsVerticalScrollIndicator={false}
    />
  )
}

const ARCHIVED_PAGE = 30

/** Sessioni archiviate sul Mac: sola lettura, a pagine (`project.sessions.archived`), chiuse finché non le apri. */
function ArchivedSection({ projectId }: { projectId: string }) {
  const { c } = useTheme()
  const router = useRouter()
  const sessionsMap = useApp((s) => s.sessions)
  const online = useApp((s) => s.conn.kind === 'connected')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const archived = useMemo(
    () =>
      Object.values(sessionsMap)
        .filter((s) => s.archived && s.projectId === projectId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessionsMap, projectId]
  )

  const load = async () => {
    if (loading || !online) return
    setLoading(true)
    try {
      const before = archived.length ? archived[archived.length - 1].updatedAt : undefined
      const page = await request<SessionSummary[]>({ type: 'project.sessions.archived', projectId, ...(before !== undefined ? { before } : {}), limit: ARCHIVED_PAGE })
      useApp.getState().addArchived(page)
      if (page.length < ARCHIVED_PAGE) setDone(true)
    } catch (error) {
      useToast.getState().show(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setLoading(false)
    }
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && archived.length === 0 && !done) void load()
  }

  return (
    <View style={{ marginTop: 8 }}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: pressed ? c.selection : 'transparent' })}
      >
        <View style={{ transform: [{ rotate: open ? '0deg' : '-90deg' }] }}>
          <Icon name="chevron-down" size={16} color={c.textMuted} />
        </View>
        <Text variant="label" tone="muted" style={{ flex: 1 }}>
          {t('Archived')}
        </Text>
      </Pressable>
      {open ? (
        <>
          {archived.map((s) => (
            <View key={s.id} style={{ paddingHorizontal: 4 }}>
              <SessionRow session={s} onPress={() => openSession(router, s.id)} />
            </View>
          ))}
          {archived.length === 0 && done ? (
            <Text variant="body" tone="muted" style={{ paddingHorizontal: 20, paddingVertical: 8 }}>
              {t('No archived sessions.')}
            </Text>
          ) : null}
          {!done && (archived.length > 0 || loading) ? <Button label={loading ? t('Loading…') : t('Load more')} variant="quiet" disabled={loading || !online} onPress={() => void load()} /> : null}
        </>
      ) : null}
    </View>
  )
}
