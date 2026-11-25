// Pieces of the usage limits: bar, window row, warning mark. Colors from the theme; the three-signal rule applies
// here too: amber only near the limit, pink only when the limit is exhausted, and always together with a shape (triangle) and a label.
import { View } from 'react-native'
import { t } from '@shared/i18n'
import type { UsageWindow } from '@shared/protocol'
import { clampPercent, resetsLabel, USAGE_WARN_AT, windowName, type UsageAlert } from '@/lib/usage'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Icon } from '@/ui/Icon'
import { Text } from '@/ui/Text'

/** Bar: iris below the threshold, amber near the limit, pink when the limit is exhausted. */
export function UsageBar({ percent, state }: { percent: number; state: UsageWindow['state'] }) {
  const { c } = useTheme()
  const tone = state === 'limited' ? c.error : state === 'warning' || percent >= USAGE_WARN_AT ? c.waiting : c.accent
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: alpha(c.text, 0.1), overflow: 'hidden' }} accessibilityElementsHidden importantForAccessibility="no">
      <View style={{ width: `${Math.max(percent, percent > 0 ? 2 : 0)}%`, height: '100%', borderRadius: 3, backgroundColor: tone }} />
    </View>
  )
}

/** What the window says in words: "62% used", or the state when the percentage is missing. */
function valueText(usage: UsageWindow, percent: number | null): string {
  if (percent !== null) return t('{percent}% used', { percent: Math.round(percent) })
  return usage.state === 'limited' ? t('Limit reached') : usage.state === 'warning' ? t('Near the limit') : t('OK')
}

/** A window: name and percentage, bar, when it resets (local time) or the host's detail. `now` in Unix seconds. */
export function UsageRow({ usage, now }: { usage: UsageWindow; now: number }) {
  const { c } = useTheme()
  const percent = clampPercent(usage.percent)
  const value = valueText(usage, percent)
  const sub = usage.detail ?? (usage.resetsAt !== null ? resetsLabel(usage.resetsAt, now) : null)
  const color = usage.state === 'limited' ? c.error : usage.state === 'warning' || (percent !== null && percent >= USAGE_WARN_AT) ? c.waiting : c.text
  return (
    <View style={{ gap: 6 }} accessible accessibilityLabel={[windowName(usage), value, sub].filter(Boolean).join('. ')}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <Text variant="body" numberOfLines={1} style={{ flexShrink: 1 }}>
          {windowName(usage)}
        </Text>
        <Text variant="label" style={{ color, fontVariant: ['tabular-nums'] }}>
          {value}
        </Text>
      </View>
      {percent !== null ? <UsageBar percent={percent} state={usage.state} /> : null}
      {sub ? (
        <Text variant="caption" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
          {sub}
        </Text>
      ) : null}
      {usage.breakdown && usage.breakdown.length > 1 ? (
        <Text variant="caption" tone="muted">
          {usage.breakdown.map((part) => `${part.label} ${Math.round(part.percent)}%`).join(' · ')}
        </Text>
      ) : null}
    </View>
  )
}

/** Warning triangle: amber, pink if the limit is exhausted. */
export function AlertGlyph({ limited, size = 16 }: { limited: boolean; size?: number }) {
  const { c } = useTheme()
  return <Icon name="alert" size={size} color={limited ? c.error : c.waiting} strokeWidth={2} />
}

/** Muted row below the account name: which window is near the limit and when it resets. */
export function AlertNote({ alert, text }: { alert: UsageAlert; text: { what: string; reset: string | null } }) {
  const { c } = useTheme()
  const tone = alert.limited ? c.error : c.waiting
  return (
    <View accessibilityRole="alert" style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', padding: 10, borderRadius: RADIUS.md, backgroundColor: alpha(tone, 0.12) }}>
      <View style={{ marginTop: 2 }}>
        <AlertGlyph limited={alert.limited} size={16} />
      </View>
      <Text variant="caption" style={{ flex: 1 }}>
        <Text variant="label">{text.what}</Text>
        {text.reset ? ` ${text.reset}` : ''}
      </Text>
    </View>
  )
}
