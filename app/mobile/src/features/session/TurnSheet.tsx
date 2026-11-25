// Turn sheet: steps (tools, requests, intermediate texts) and changed files.
import { View } from 'react-native'
import { plural, t } from '@shared/i18n'
import type { ChatItem } from '@shared/protocol'
import { duration } from '@/lib/format'
import type { TurnSummary } from '@/lib/turns'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Icon } from '@/ui/Icon'
import { SheetTitle } from '@/ui/NativeSheet'
import { StateGlyph } from '@/ui/StateGlyph'
import { Text } from '@/ui/Text'
import { summaryText } from './rows'

function Step({ item }: { item: ChatItem }) {
  const { c } = useTheme()
  if (item.kind === 'assistant') {
    return (
      <View style={{ paddingVertical: 8 }}>
        <Text system numberOfLines={4} style={{ fontSize: 15, lineHeight: 22, color: c.textMuted }}>
          {item.text.replace(/[`*_#>]/g, '')}
        </Text>
      </View>
    )
  }
  if (item.kind === 'request') {
    return (
      <View style={{ flexDirection: 'row', gap: 10, paddingVertical: 8, alignItems: 'flex-start' }}>
        <View style={{ marginTop: 2 }}>
          <StateGlyph state={item.state === 'open' ? 'waiting' : 'idle'} size={16} />
          {item.state !== 'open' ? <Icon name="check" size={16} color={c.textMuted} /> : null}
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="body">{item.requestType === 'question' ? t('Question') : item.title}</Text>
          {item.resolution ? (
            <Text variant="caption" tone="muted">
              {item.resolution}
              {item.via === 'phone' ? ` · ${t('from this phone')}` : ''}
            </Text>
          ) : null}
        </View>
      </View>
    )
  }
  if (item.kind !== 'tool') return null
  const failed = item.status === 'error' || item.status === 'denied'
  return (
    <View style={{ flexDirection: 'row', gap: 10, paddingVertical: 8, alignItems: 'flex-start' }}>
      <View style={{ marginTop: 2 }}>{item.status === 'running' ? <StateGlyph state="running" size={16} /> : failed ? <StateGlyph state="error" size={16} /> : <Icon name="check" size={16} color={c.textMuted} />}</View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body">{item.title}</Text>
        {item.detail && !item.title.includes(item.detail) ? (
          <Text variant="code" tone="muted" numberOfLines={2} style={{ fontFamily: 'MonaspaceNeon-Regular' }}>
            {item.detail}
          </Text>
        ) : null}
        {failed && item.output ? (
          <Text variant="caption" tone="error" numberOfLines={2}>
            {item.output}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

/** Turn sheet content, the same in the native sheet (iOS) and in our own. */
export function TurnContent({ turn }: { turn: TurnSummary }) {
  const { c } = useTheme()
  return (
    <>
      <SheetTitle>{summaryText(turn)}</SheetTitle>
        <View style={{ paddingHorizontal: 20, gap: 16 }}>
          {turn.end ? (
            <Text variant="caption" tone="muted" style={{ marginTop: -8 }}>
              {turn.end.status === 'error' ? t('Failed after {time}', { time: duration(turn.end.durationMs) }) : turn.end.status === 'interrupted' ? t('Stopped after {time}', { time: duration(turn.end.durationMs) }) : t('Took {time}', { time: duration(turn.end.durationMs) })}
            </Text>
          ) : null}
          <View>
            <Text variant="label" tone="muted">
              {t('Steps')}
            </Text>
            {turn.steps.length === 0 ? (
              <Text variant="body" tone="muted" style={{ paddingVertical: 8 }}>
                {t('No steps yet.')}
              </Text>
            ) : (
              turn.steps.map((s) => <Step key={s.id} item={s} />)
            )}
          </View>
          {turn.files.length > 0 ? (
            <View style={{ gap: 6 }}>
              <Text variant="label" tone="muted">
                {plural(turn.files.length, 'Changed file', 'Changed files')}
              </Text>
              <View style={{ backgroundColor: c.codeBackground, borderRadius: RADIUS.md, paddingVertical: 4 }}>
                {turn.files.map((f) => (
                  <View key={f.path} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 }}>
                    <Text variant="code" numberOfLines={1} style={{ flex: 1, fontFamily: 'MonaspaceNeon-Regular' }}>
                      {f.path}
                    </Text>
                    <Text variant="caption" tone="success">
                      +{f.added}
                    </Text>
                    <Text variant="caption" tone="error">
                      −{f.removed}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </View>
    </>
  )
}
