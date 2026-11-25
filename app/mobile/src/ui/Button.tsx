import { ActivityIndicator, Platform, Pressable, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS, TOUCH } from '@/theme/type'
import { Icon, type IconName } from './Icon'
import { Text } from './Text'

export const MIN_TOUCH = Platform.OS === 'android' ? TOUCH.android : TOUCH.ios

interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
  icon?: IconName
  style?: StyleProp<ViewStyle>
  /** Occupa tutta la riga (nelle coppie Deny/Approve). */
  grow?: boolean
  /** Al posto dell'icona un indicatore: l'azione è in corso (il pulsante resta com'è, non si tocca di nuovo). */
  loading?: boolean
}

/** Pulsante piatto: primario = accento pieno, secondario = superficie, danger = testo rosa su superficie. */
export function Button({ label, variant = 'secondary', icon, style, grow, loading, disabled, ...rest }: ButtonProps) {
  const { c } = useTheme()
  const bg = variant === 'primary' ? c.accent : variant === 'quiet' ? 'transparent' : c.surface
  const fg = variant === 'primary' ? c.onAccent : variant === 'danger' ? c.error : variant === 'quiet' ? c.accent : c.text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      disabled={disabled}
      {...rest}
      style={({ pressed }) => [
        {
          minHeight: MIN_TOUCH,
          paddingHorizontal: 16,
          borderRadius: RADIUS.lg,
          backgroundColor: pressed ? (variant === 'primary' ? alpha(c.accent, 0.85) : c.selection) : bg,
          borderWidth: variant === 'secondary' || variant === 'danger' ? 1 : 0,
          borderColor: c.border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          opacity: disabled ? 0.4 : 1
        },
        grow && { flex: 1 },
        style
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={18} color={fg} /> : null}
      <Text variant="title" style={{ color: fg }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

export function IconButton({ icon, label, onPress, color, size = 22, disabled, style }: { icon: IconName; label: string; onPress?: () => void; color?: string; size?: number; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={({ pressed }) => [{ width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center', borderRadius: MIN_TOUCH / 2, backgroundColor: pressed ? c.selection : 'transparent', opacity: disabled ? 0.4 : 1 }, style]}
    >
      <Icon name={icon} size={size} color={color ?? c.text} />
    </Pressable>
  )
}

/** Riga di separazione: i fili stanno solo tra le zone. */
export function Hairline({ inset = 0 }: { inset?: number }) {
  const { c } = useTheme()
  return <View style={{ height: 1, backgroundColor: c.border, marginLeft: inset, opacity: 0.7 }} />
}

/** Chip: etichetta compatta, anche toccabile (permesso della sessione). */
export function Chip({ label, onPress, tone = 'muted', icon, disabled }: { label: string; onPress?: () => void; tone?: 'muted' | 'waiting' | 'error'; icon?: IconName; disabled?: boolean }) {
  const { c } = useTheme()
  const color = tone === 'waiting' ? c.waiting : tone === 'error' ? c.error : c.textMuted
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress || disabled}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={label}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 10, borderRadius: RADIUS.md, backgroundColor: pressed ? c.selection : c.surface })}
    >
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      <Text variant="label" style={{ color: tone === 'muted' ? c.text : color }}>
        {label}
      </Text>
      {onPress ? <Icon name="chevron-down" size={14} color={c.textMuted} /> : null}
    </Pressable>
  )
}
