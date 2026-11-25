// Pezzi dei limiti d'uso (LAD-90): barra, riga di una finestra, segno d'avviso. Colori dal tema; la regola dei tre segnali vale
// anche qui: ambra solo vicino al limite, rosa solo a limite esaurito, e sempre insieme a una forma (triangolo) e a un'etichetta.
import { View } from 'react-native'
import { t } from '@shared/i18n'
import type { UsageWindow } from '@shared/protocol'
import { clampPercent, resetsLabel, USAGE_WARN_AT, windowName, type UsageAlert } from '@/lib/usage'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Icon } from '@/ui/Icon'
import { Text } from '@/ui/Text'

/** Barra: iris sotto soglia, ambra vicino al limite, rosa a limite esaurito. */
export function UsageBar({ percent, state }: { percent: number; state: UsageWindow['state'] }) {
  const { c } = useTheme()
  const tone = state === 'limited' ? c.error : state === 'warning' || percent >= USAGE_WARN_AT ? c.waiting : c.accent
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: alpha(c.text, 0.1), overflow: 'hidden' }} accessibilityElementsHidden importantForAccessibility="no">
      <View style={{ width: `${Math.max(percent, percent > 0 ? 2 : 0)}%`, height: '100%', borderRadius: 3, backgroundColor: tone }} />
    </View>
  )
}

/** Cosa dice la finestra a parole: "62% used", oppure lo stato quando la percentuale manca. */
function valueText(usage: UsageWindow, percent: number | null): string {
  if (percent !== null) return t('{percent}% used', { percent: Math.round(percent) })
  return usage.state === 'limited' ? t('Limit reached') : usage.state === 'warning' ? t('Near the limit') : t('OK')
}

/** Una finestra: nome e percentuale, barra, quando si azzera (ora locale) oppure il dettaglio dell'host. `now` in secondi Unix. */
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

/** Triangolo d'avviso: ambra, rosa se il limite è esaurito. */
export function AlertGlyph({ limited, size = 16 }: { limited: boolean; size?: number }) {
  const { c } = useTheme()
  return <Icon name="alert" size={size} color={limited ? c.error : c.waiting} strokeWidth={2} />
}

/** Riga tenue sotto il nome dell'account: quale finestra è vicina al limite e quando si azzera. */
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
