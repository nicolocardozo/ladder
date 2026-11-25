// Two-level session row: status, title and age; below, project, Agent Mark, model and activity.
import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { t } from '@shared/i18n'
import type { SessionSummary } from '@shared/protocol'
import { relativeAge, stateLabel } from '@/lib/format'
import { sessionState } from '@/lib/session-state'
import { useApp } from '@/store/app'
import { useTheme } from '@/theme/theme'
import { AgentMark, useModelLabel } from '@/ui/AgentMark'
import { StateGlyph } from '@/ui/StateGlyph'
import { Text } from '@/ui/Text'

export const SessionRow = memo(function SessionRow({ session, showProject, onPress, selected }: { session: SessionSummary; showProject?: boolean; onPress: () => void; selected?: boolean }) {
  const { c } = useTheme()
  const state = sessionState(session)
  const project = useApp((s) => (showProject ? s.projects.find((p) => p.id === session.projectId)?.name : undefined))
  const model = useModelLabel(session.agent, session.model)
  const note =
    state === 'waiting' ? (session.waitingLabel ? (session.waitingLabel === 'Approval' ? t('Approval') : session.waitingLabel === 'Question' ? t('Question') : session.waitingLabel) : t('Needs you')) : state === 'running' ? session.activity : state === 'idle' ? null : stateLabel(state)
  const noteColor = state === 'waiting' ? c.waiting : state === 'error' ? c.error : c.textMuted
  const age = relativeAge(state === 'waiting' && session.waitingSince ? session.waitingSince : session.activityAt)
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${session.title}. ${stateLabel(state)}. ${age}`}
      style={({ pressed }) => ({ minHeight: 60, paddingVertical: 10, paddingLeft: 12, paddingRight: 16, flexDirection: 'row', gap: 10, backgroundColor: pressed || selected ? c.selection : 'transparent', borderRadius: 12 })}
    >
      <View style={{ width: 24, height: 22, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
        <StateGlyph state={state} size={16} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text variant="body" numberOfLines={1} style={{ flex: 1, fontFamily: 'MonaSans-Medium' }}>
            {session.title}
          </Text>
          <Text variant="caption" tone="muted">
            {age}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {project ? (
            <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
              {project}
            </Text>
          ) : null}
          {project ? <Text variant="caption" tone="muted">·</Text> : null}
          <AgentMark agent={session.agent} size={13} />
          <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 0 }}>
            {model}
          </Text>
          {note ? (
            <Text variant="caption" numberOfLines={1} style={{ flex: 1, color: noteColor }}>
              · {note}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  )
})
