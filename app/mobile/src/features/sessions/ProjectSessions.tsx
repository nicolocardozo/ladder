// Sessions of a project split by the Mac's groups (ui[projectId].groups / groupOf).
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

export type ProjectItem = { kind: 'header'; name: string; key: string } | { kind: 'session'; session: SessionSummary }

/** The rows of a project: sessions split by the Mac's groups. */
export function useProjectItems(projectId: string): ProjectItem[] {
  const sessionsMap = useApp((s) => s.sessions)
  const ui = useApp((s) => s.ui[projectId])
  return useMemo<ProjectItem[]>(() => {
    const list = Object.values(sessionsMap).filter((s) => s.projectId === projectId && !s.archived)
    const groups = groupProjectSessions(list, ui)
    const out: ProjectItem[] = []
    for (const g of groups) {
      if (g.name) out.push({ kind: 'header', name: g.name, key: `g-${g.id}` })
      for (const s of g.sessions) out.push({ kind: 'session', session: s })
    }
    return out
  }, [sessionsMap, ui, projectId])
}

export const projectItemKey = (i: ProjectItem): string => (i.kind === 'header' ? i.key : i.session.id)

export function ProjectItemRow({ item, showProject }: { item: ProjectItem; showProject?: boolean }) {
  const router = useRouter()
  if (item.kind === 'header')
    return (
      <Text variant="label" tone="muted" style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 6 }} accessibilityRole="header">
        {item.name}
      </Text>
    )
  return (
    <View style={{ paddingHorizontal: 4 }}>
      <SessionRow session={item.session} showProject={showProject} onPress={() => openSession(router, item.session.id)} />
    </View>
  )
}

/** `native`: below a header and above the native tab bar (default); `false` in the fixed left pane, which has neither. */
export function ProjectSessions({ projectId, header, native = true, topPad = 0 }: { projectId: string; header?: ReactElement; native?: boolean; topPad?: number }) {
  const insets = useSafeAreaInsets()
  const items = useProjectItems(projectId)
  return (
    <FlatList
      data={items}
      ListHeaderComponent={header}
      ListFooterComponent={<ArchivedSection projectId={projectId} />}
      keyExtractor={projectItemKey}
      renderItem={({ item }) => <ProjectItemRow item={item} />}
      ListEmptyComponent={
        <View style={{ paddingHorizontal: 32, paddingTop: 48, alignItems: 'center', gap: 6 }}>
          <Text variant="title">{t('No sessions yet')}</Text>
          <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
            {t('Start a session on your Mac and it will appear here.')}
          </Text>
        </View>
      }
      contentContainerStyle={{ paddingTop: topPad, paddingBottom: native ? 24 : insets.bottom + 24 }}
      scrollIndicatorInsets={{ top: topPad }}
      contentInsetAdjustmentBehavior={native ? 'automatic' : 'never'}
      showsVerticalScrollIndicator={false}
    />
  )
}

const ARCHIVED_PAGE = 30

/** Sessions archived on the Mac: read-only, paged (`project.sessions.archived`), collapsed until you open them. */
export function ArchivedSection({ projectId }: { projectId: string }) {
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
