// Home: "adesso" (cosa succede) e "sfoglia" (la mappa del Mac). Non è una copia della sidebar del desktop.
import { useRouter } from 'expo-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Platform, Pressable, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { plural, t } from '@shared/i18n'
import type { SessionSummary } from '@shared/protocol'
import { relativeAge } from '@/lib/format'
import { buildHome, type ProjectRow, type SectionModel } from '@/lib/home-model'
import { hasSignals, type Signals } from '@/lib/session-state'
import { useApp } from '@/store/app'
import { usePrefs } from '@/store/prefs'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { IconButton, MIN_TOUCH } from '@/ui/Button'
import { ConnectionPill } from '@/ui/ConnectionPill'
import { Icon } from '@/ui/Icon'
import { SignalGlyph, StateGlyph } from '@/ui/StateGlyph'
import { Text } from '@/ui/Text'
import { ProjectSessions } from '../sessions/ProjectSessions'
import { SessionRow } from '../sessions/SessionRow'

const SEARCH_H = 52

type Row =
  | { kind: 'search' }
  | { kind: 'waiting'; count: number }
  | { kind: 'header'; title: string; key: string }
  | { kind: 'session'; session: SessionSummary; key: string }
  | { kind: 'section'; section: SectionModel }
  | { kind: 'project'; row: ProjectRow; dim: boolean; key: string }
  | { kind: 'empty' }

export function SignalsInline({ signals, size = 12 }: { signals: Signals; size?: number }) {
  const { c } = useTheme()
  const items: { kind: 'running' | 'waiting' | 'unread' | 'error'; n: number }[] = [
    { kind: 'waiting', n: signals.waiting },
    { kind: 'error', n: signals.error },
    { kind: 'running', n: signals.running },
    { kind: 'unread', n: signals.unread }
  ]
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {items
        .filter((i) => i.n > 0)
        .map((i) => (
          <View key={i.kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }} accessible accessibilityLabel={`${i.n} ${i.kind}`}>
            <SignalGlyph kind={i.kind} size={size} />
            <Text variant="caption" style={{ color: i.kind === 'waiting' ? c.waiting : i.kind === 'error' ? c.error : c.textMuted }}>
              {i.n}
            </Text>
          </View>
        ))}
    </View>
  )
}

export function HomeContent({ docked }: { docked?: boolean }) {
  const { c } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const projects = useApp((s) => s.projects)
  const sessionsMap = useApp((s) => s.sessions)
  const groups = useApp((s) => s.projectGroups)
  const loadedOnce = useApp((s) => s.mode !== 'none')
  const collapsed = usePrefs((s) => s.collapsed)
  const setCollapsed = usePrefs((s) => s.setCollapsed)
  const [query, setQuery] = useState('')
  const listRef = useRef<FlatList<Row>>(null)
  const sessions = useMemo(() => Object.values(sessionsMap), [sessionsMap])
  const model = useMemo(() => buildHome({ projects, sessions, projectGroups: groups, collapsed }), [projects, sessions, groups, collapsed])

  const q = query.trim().toLowerCase()
  const searching = q.length > 0

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [{ kind: 'search' }]
    if (searching) {
      const nameOf = (id: string) => projects.find((p) => p.id === id)?.name.toLowerCase() ?? ''
      const hits = sessions.filter((s) => !s.archived && (s.title.toLowerCase().includes(q) || nameOf(s.projectId).includes(q)))
      hits.sort((a, b) => b.activityAt - a.activityAt)
      for (const s of hits) out.push({ kind: 'session', session: s, key: `q-${s.id}` })
      if (!hits.length) out.push({ kind: 'empty' })
      return out
    }
    if (model.waitingCount > 0) out.push({ kind: 'waiting', count: model.waitingCount })
    if (model.now.length > 0) {
      out.push({ kind: 'header', title: t('Now'), key: 'h-now' })
      for (const s of model.now) out.push({ kind: 'session', session: s, key: `n-${s.id}` })
    }
    if (model.singleProject) return out
    if (model.sections.length === 0 && model.now.length === 0) out.push({ kind: 'empty' })
    let first = true
    for (const section of model.sections) {
      if (section.titled) out.push({ kind: 'section', section })
      else if (model.now.length > 0 || !first) out.push({ kind: 'header', title: t('Projects'), key: 'h-projects' })
      first = false
      if (section.expanded) {
        for (const row of section.projects) out.push({ kind: 'project', row, dim: row.sessions.length === 0, key: `p-${row.project.id}` })
      }
    }
    return out
  }, [model, searching, q, projects, sessions])

  // La ricerca sta sopra l'elenco, nascosta: tirando giù compare. Su iOS parte già scorsa oltre la barra.
  useEffect(() => {
    if (Platform.OS === 'android') requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: SEARCH_H, animated: false }))
  }, [loadedOnce])
  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y
    // Fermo a metà: o tutta la barra o niente.
    if (y > 0 && y < SEARCH_H && !searching) listRef.current?.scrollToOffset({ offset: y > SEARCH_H / 2 ? SEARCH_H : 0, animated: true })
  }

  const open = (s: SessionSummary) => router.push({ pathname: '/session/[id]', params: { id: s.id } })

  const renderItem = ({ item }: { item: Row }) => {
    switch (item.kind) {
      case 'search':
        return (
          <View style={{ height: SEARCH_H, paddingHorizontal: 16, justifyContent: 'center' }}>
            <View style={{ height: 40, borderRadius: RADIUS.lg, backgroundColor: c.surface, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 }}>
              <Icon name="search" size={18} color={c.textMuted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={t('Search sessions')}
                placeholderTextColor={c.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                returnKeyType="search"
                accessibilityLabel={t('Search sessions')}
                style={{ flex: 1, color: c.text, fontFamily: 'MonaSans-Regular', fontSize: 15, padding: 0 }}
              />
              {query ? (
                <Pressable onPress={() => setQuery('')} hitSlop={12} accessibilityLabel={t('Clear search')}>
                  <Icon name="x" size={16} color={c.textMuted} />
                </Pressable>
              ) : null}
            </View>
          </View>
        )
      case 'waiting':
        return (
          <Pressable
            onPress={() => router.push('/waiting')}
            accessibilityRole="button"
            accessibilityLabel={plural(item.count, '1 session waiting for you', '{n} waiting for you')}
            style={({ pressed }) => ({ marginHorizontal: 16, marginBottom: 8, minHeight: MIN_TOUCH + 8, borderRadius: RADIUS.lg, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: alpha(c.waiting, pressed ? 0.22 : 0.14), borderWidth: 1, borderColor: alpha(c.waiting, 0.5) })}
          >
            <StateGlyph state="waiting" size={18} />
            <Text variant="title" tone="waiting" style={{ flex: 1 }}>
              {t('{n} waiting for you', { n: item.count })}
            </Text>
            <Icon name="chevron-right" size={18} color={c.waiting} />
          </Pressable>
        )
      case 'header':
        return (
          <Text variant="label" tone="muted" style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 6 }} accessibilityRole="header">
            {item.title}
          </Text>
        )
      case 'session':
        return (
          <View style={{ paddingHorizontal: 4 }}>
            <SessionRow session={item.session} showProject onPress={() => open(item.session)} />
          </View>
        )
      case 'section': {
        const s = item.section
        return (
          <Pressable
            onPress={() => setCollapsed(s.id, s.expanded)}
            accessibilityRole="button"
            accessibilityState={{ expanded: s.expanded }}
            accessibilityLabel={`${s.name}. ${plural(s.projects.length, '1 project', '{n} projects')}`}
            style={({ pressed }) => ({ minHeight: MIN_TOUCH, paddingHorizontal: 20, paddingTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: pressed ? c.selection : 'transparent' })}
          >
            <View style={{ transform: [{ rotate: s.expanded ? '0deg' : '-90deg' }] }}>
              <Icon name="chevron-down" size={16} color={c.textMuted} />
            </View>
            <Text variant="label" tone="muted" style={{ flex: 1 }} numberOfLines={1}>
              {s.name}
            </Text>
            {!s.expanded ? (
              <>
                <SignalsInline signals={s.signals} />
                <Text variant="caption" tone="muted">
                  {plural(s.projects.length, '1 project', '{n} projects')}
                </Text>
              </>
            ) : null}
          </Pressable>
        )
      }
      case 'project': {
        const r = item.row
        return (
          <Pressable
            onPress={() => router.push({ pathname: '/project/[id]', params: { id: r.project.id } })}
            accessibilityRole="button"
            accessibilityLabel={`${r.project.name}`}
            style={({ pressed }) => ({ minHeight: 52, marginHorizontal: 4, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, backgroundColor: pressed ? c.selection : 'transparent', opacity: item.dim ? 0.5 : 1 })}
          >
            <Text variant="body" numberOfLines={1} style={{ flex: 1, fontFamily: 'MonaSans-Medium' }}>
              {r.project.name}
            </Text>
            {hasSignals(r.signals) ? <SignalsInline signals={r.signals} /> : null}
            <Text variant="caption" tone="muted" style={{ minWidth: 44, textAlign: 'right' }}>
              {r.lastActivity ? relativeAge(r.lastActivity) : ''}
            </Text>
            <Icon name="chevron-right" size={16} color={alpha(c.textMuted, 0.7)} />
          </Pressable>
        )
      }
      case 'empty':
        return (
          <View style={{ paddingHorizontal: 32, paddingTop: 48, alignItems: 'center', gap: 6 }}>
            <Text variant="title" style={{ textAlign: 'center' }}>
              {searching ? t('No sessions match') : t('Nothing here yet')}
            </Text>
            <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
              {searching ? t('Try another word.') : t('Sessions you start on your Mac will show up here.')}
            </Text>
          </View>
        )
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: insets.top }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 8, paddingVertical: 6, gap: 8 }}>
        <View style={{ flex: 1, alignItems: 'flex-start' }}>
          <ConnectionPill />
        </View>
        <IconButton icon="sliders" label={t('Settings')} onPress={() => router.push('/settings')} />
      </View>
      {model.singleProject && !searching ? (
        <ProjectSessions
          projectId={model.singleProject.project.id}
          header={
            <View>
              {model.waitingCount > 0 ? renderItem({ item: { kind: 'waiting', count: model.waitingCount } }) : null}
              <Text variant="headline" style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 }}>
                {model.singleProject.project.name}
              </Text>
            </View>
          }
        />
      ) : (
        <FlatList
          ref={listRef}
          data={rows}
          keyExtractor={(r, i) => (r.kind === 'session' || r.kind === 'project' || r.kind === 'header' ? r.key : r.kind === 'section' ? `s-${r.section.id}` : `${r.kind}-${i}`)}
          renderItem={renderItem}
          contentOffset={Platform.OS === 'ios' ? { x: 0, y: SEARCH_H } : undefined}
          onScrollEndDrag={settle}
          onMomentumScrollEnd={settle}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          contentInsetAdjustmentBehavior="never"
          showsVerticalScrollIndicator={false}
        />
      )}
      {docked ? <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 1, backgroundColor: c.border }} /> : null}
    </View>
  )
}
