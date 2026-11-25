// Building blocks for settings screens: titled group, row with a value, row with a switch, single choice.
import type { ReactNode } from 'react'
import { Pressable, Switch, View } from 'react-native'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { MIN_TOUCH } from './Button'
import { Icon } from './Icon'
import { Text } from './Text'

export function Group({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  const { c } = useTheme()
  return (
    <View style={{ gap: 6, marginTop: 20 }}>
      {title ? (
        <Text variant="label" tone="muted" style={{ paddingHorizontal: 20 }} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      <View style={{ marginHorizontal: 16, borderRadius: RADIUS.lg, backgroundColor: c.surface, overflow: 'hidden' }}>{children}</View>
      {footer ? (
        <Text variant="caption" tone="muted" style={{ paddingHorizontal: 20 }}>
          {footer}
        </Text>
      ) : null}
    </View>
  )
}

function Separator() {
  const { c } = useTheme()
  return <View style={{ height: 1, backgroundColor: c.border, marginLeft: 16, opacity: 0.6 }} />
}

export function Row({ label, value, onPress, right, last, destructive, selected, detail, disabled }: { label: string; value?: string; onPress?: () => void; right?: ReactNode; last?: boolean; destructive?: boolean; selected?: boolean; detail?: string; disabled?: boolean }) {
  const { c } = useTheme()
  return (
    <>
      <Pressable
        onPress={onPress}
        disabled={!onPress || disabled}
        accessibilityRole={onPress ? 'button' : 'text'}
        accessibilityState={{ ...(selected === undefined ? {} : { selected }), ...(disabled ? { disabled: true } : {}) }}
        style={({ pressed }) => ({ minHeight: MIN_TOUCH + 8, paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: pressed ? c.selection : 'transparent', opacity: disabled ? 0.45 : 1 })}
      >
        <View style={{ flex: 1 }}>
          <Text variant="body" tone={destructive ? 'error' : 'default'}>
            {label}
          </Text>
          {detail ? (
            <Text variant="caption" tone="muted">
              {detail}
            </Text>
          ) : null}
        </View>
        {value ? (
          <Text variant="body" tone="muted" numberOfLines={1} style={{ maxWidth: '55%' }}>
            {value}
          </Text>
        ) : null}
        {right}
        {selected ? <Icon name="check" size={18} color={c.accent} strokeWidth={2.4} /> : null}
        {onPress && value !== undefined ? <Icon name="chevron-right" size={16} color={c.textMuted} /> : null}
      </Pressable>
      {!last ? <Separator /> : null}
    </>
  )
}

export function ToggleRow({ label, value, onChange, last, detail }: { label: string; value: boolean; onChange: (v: boolean) => void; last?: boolean; detail?: string }) {
  const { c } = useTheme()
  return (
    <Row label={label} detail={detail} last={last} onPress={() => onChange(!value)} right={<Switch value={value} onValueChange={onChange} trackColor={{ true: c.accent, false: c.controlBorder }} thumbColor={c.onAccent} accessibilityLabel={label} />} />
  )
}
