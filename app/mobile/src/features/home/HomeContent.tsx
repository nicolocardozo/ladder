// Home: "now" (what is happening) and "browse" (the Mac's map). It is not a copy of the desktop sidebar.
import { useRouter } from 'expo-router'
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import { FlatList, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { plural, t } from '@shared/i18n'
import type { SessionSummary } from '@shared/protocol'
import { relativeAge } from '@/lib/format'
import { openInTabs, openSession } from '@/lib/nav'
import { buildHome, type ProjectRow, type SectionModel } from '@/lib/home-model'
import { hasSignals, type Signals } from '@/lib/session-state'
import { useApp } from '@/store/app'
import { useDev } from '@/store/dev'
import { usePrefs } from '@/store/prefs'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { openSheet } from '@/lib/sheets'
import { IconButton, MIN_TOUCH } from '@/ui/Button'
import { ConnectionPill } from '@/ui/ConnectionPill'
import { Icon } from '@/ui/Icon'
import { SignalGlyph } from '@/ui/StateGlyph'
import { useTabHeaderPad } from '@/ui/TabHeader'
import { Text } from '@/ui/Text'
import { TextInput } from '@/ui/TextInput'
import { ArchivedSection, ProjectItemRow, projectItemKey, useProjectItems, type ProjectItem } from '../sessions/ProjectSessions'
import { SessionRow } from '../sessions/SessionRow'

type Row =
  | { kind: 'header'; title: string; key: string }
  | { kind: 'session'; session: SessionSummary; key: string }
  | { kind: 'section'; section: SectionModel }
  | { kind: 'project'; row: ProjectRow; dim: boolean; key: string }
  | { kind: 'ptitle'; name: string }
  | { kind: 'pitem'; item: ProjectItem; key: string }
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

/**
 * Search is the first item of the list. In the docked panel on the left (`docked`, from 600 pt) there is no tab header:
 * there, above the field, also sit the Mac pill and the "+".
 */
export function HomeContent({ docked }: { docked?: boolean }) {
  const { c } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const projects = useApp((s) => s.projects)
  const sessionsMap = useApp((s) => s.sessions)
  const groups = useApp((s) => s.projectGroups)
  const collapsed = usePrefs((s) => s.collapsed)
  const setCollapsed = usePrefs((s) => s.setCollapsed)
  const [query, setDockedQuery] = useState('')
  const dockedQuery = query
  const headerPad = useTabHeaderPad()
  const sessions = useMemo(() => Object.values(sessionsMap), [sessionsMap])
  const model = useMemo(() => buildHome({ projects, sessions, projectGroups: groups, collapsed }), [projects, sessions, groups, collapsed])

  const q = query.trim().toLowerCase()
  const searching = q.length > 0

  // With a single project the Home shows its sessions in place of the sections: same list, so search doesn't remount the field.
  const single = model.singleProject?.project.id ?? ''
  const projectItems = useProjectItems(single)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    if (searching) {
      const nameOf = (id: string) => projects.find((p) => p.id === id)?.name.toLowerCase() ?? ''
      const hits = sessions.filter((s) => !s.archived && (s.title.toLowerCase().includes(q) || nameOf(s.projectId).includes(q)))
      hits.sort((a, b) => b.activityAt - a.activityAt)
      for (const s of hits) out.push({ kind: 'session', session: s, key: `q-${s.id}` })
      if (!hits.length) out.push({ kind: 'empty' })
      return out
    }
    if (model.now.length > 0) {
      out.push({ kind: 'header', title: t('Now'), key: 'h-now' })
      for (const s of model.now) out.push({ kind: 'session', session: s, key: `n-${s.id}` })
    }
    if (model.singleProject) {
      out.push({ kind: 'ptitle', name: model.singleProject.project.name })
      for (const item of projectItems) out.push({ kind: 'pitem', item, key: `i-${projectItemKey(item)}` })
      return out
    }
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
  }, [model, searching, q, projects, sessions, projectItems])

  const open = (s: SessionSummary) => openSession(router, s.id)

  const renderItem = ({ item }: { item: Row }) => {
    switch (item.kind) {
      case 'ptitle':
        return (
          <Text variant="headline" style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 }}>
            {item.name}
          </Text>
        )
      case 'pitem':
        return <ProjectItemRow item={item.item} />
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
            onPress={() => openInTabs(router, { pathname: '/project/[id]', params: { id: r.project.id } })}
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

  // At the top of the list: search (in the docked panel, with the Mac pill and the "+", which elsewhere sit in the header).
  const top = (
    <View style={{ paddingHorizontal: 16, paddingTop: docked ? 4 : 0, paddingBottom: 10, alignItems: 'flex-start', gap: 8 }}>
      <View style={{ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <DockedSearch value={dockedQuery} onChange={setDockedQuery} />
        </View>
        {docked ? <IconButton icon="plus" label={t('New session')} onPress={() => openSheet(router, { kind: 'new-session' })} /> : null}
      </View>
      {docked && !searching ? <ConnectionPill /> : null}
    </View>
  )

  const list = (
    <FlatList
      data={rows}
      ListHeaderComponent={top}
      ListFooterComponent={model.singleProject && !searching ? <ArchivedSection projectId={model.singleProject.project.id} /> : undefined}
      keyExtractor={(r, i) => (r.kind === 'session' || r.kind === 'project' || r.kind === 'header' || r.kind === 'pitem' ? r.key : r.kind === 'section' ? `s-${r.section.id}` : `${r.kind}-${i}`)}
      renderItem={renderItem}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      style={docked ? undefined : { backgroundColor: c.background }}
      contentContainerStyle={{ paddingTop: docked ? 0 : headerPad, paddingBottom: docked ? insets.bottom + 24 : 24 }}
      scrollIndicatorInsets={{ top: docked ? 0 : headerPad }}
      // The native tab bar moves the content on its own (and on iOS 26 it scrolls underneath, over the glass).
      contentInsetAdjustmentBehavior={docked ? 'never' : 'automatic'}
      showsVerticalScrollIndicator={false}
    />
  )
  // On the phone the list is the screen's only direct child: it is the main scroll view that UIKit observes to shrink the tab
  // bar on scroll (wrapped in a container the bar doesn't shrink). The docked panel instead has its own container.
  if (!docked) return list
  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: insets.top }}>
      {list}
      <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 1, backgroundColor: c.border }} />
    </View>
  )
}

/** Search field: first item of the list (and, in the docked panel, next to the "+"). */
function DockedSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { c } = useTheme()
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  // Development only: the driver focuses the field (keyboard up) without a tap.
  const devFocus = useDev((d) => d.focusSearch)
  useEffect(() => {
    if (__DEV__ && devFocus) setTimeout(() => input.current?.focus(), 400)
  }, [devFocus])
  return (
    <View style={{ alignSelf: 'stretch', height: 40, borderRadius: RADIUS.lg, backgroundColor: c.surface, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 }}>
      <Icon name="search" size={18} color={c.textMuted} />
      <TextInput
        ref={input}
        value={value}
        onChangeText={onChange}
        placeholder={t('Search sessions')}
        placeholderTextColor={c.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={t('Search sessions')}
        style={{ flex: 1, alignSelf: 'stretch', color: c.text, fontFamily: 'MonaSans-Regular', fontSize: 15, padding: 0 }}
      />
      {value ? (
        <Pressable onPress={() => onChange('')} hitSlop={12} accessibilityLabel={t('Clear search')}>
          <Icon name="x" size={16} color={c.textMuted} />
        </Pressable>
      ) : null}
    </View>
  )
}
