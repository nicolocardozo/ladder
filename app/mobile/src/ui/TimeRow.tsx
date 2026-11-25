// Settings row with a time (HH:MM). iOS: compact picker in the row; Android: the row opens the clock dialog.
import DateTimePicker, { DateTimePickerAndroid, type DateTimePickerEvent } from '@react-native-community/datetimepicker'
import { Platform } from 'react-native'
import { dateToTime, displayTime, timeToDate } from '@/lib/notify-prefs'
import { useTheme } from '@/theme/theme'
import { Row } from './List'
import { Text } from './Text'

/** Does the phone show time in 24-hour format? (needed by Android's dialog, which would otherwise always use 12). */
function uses24Hour(): boolean {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 === false
  } catch {
    return true
  }
}

export function TimeRow({ label, value, onChange, last }: { label: string; value: string; onChange: (time: string) => void; last?: boolean }) {
  const { c, dark } = useTheme()
  const date = timeToDate(value)
  const picked = (event: DateTimePickerEvent, next?: Date) => {
    if (event.type === 'set' && next) onChange(dateToTime(next))
  }
  if (Platform.OS === 'android') {
    return (
      <Row
        label={label}
        last={last}
        right={<Text variant="body" tone="accent">{displayTime(value)}</Text>}
        onPress={() => DateTimePickerAndroid.open({ value: date, mode: 'time', is24Hour: uses24Hour(), onChange: picked })}
      />
    )
  }
  return <Row label={label} last={last} right={<DateTimePicker value={date} mode="time" display="compact" themeVariant={dark ? 'dark' : 'light'} accentColor={c.accent} onChange={picked} />} />
}
