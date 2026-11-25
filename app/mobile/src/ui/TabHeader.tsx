// Intestazione delle schermate radice dei tab (Sessioni, Richieste, Impostazioni): il titolo sta subito sotto la barra di stato, senza la
// riga vuota della barra di navigazione nativa, con un'azione a destra sulla stessa riga. Il contenuto della lista scorre sotto: lo sfondo
// è pieno fino al titolo e sfuma sotto di esso, così sul testo del titolo non passa mai nulla.
import { type ReactNode } from 'react'
import { Platform, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { useTheme } from '@/theme/theme'
import { Text } from './Text'

/** Altezza della riga del titolo (sotto la barra di stato) e della sfumatura sotto di essa. */
export const TAB_HEADER_ROW = 52
const FADE = 12

/**
 * Spazio da lasciare in cima al contenuto della lista sotto l'intestazione. Su iOS la lista (`contentInsetAdjustmentBehavior="automatic"`)
 * aggiunge già l'altezza della barra di stato; su Android no.
 */
export function useTabHeaderPad(): number {
  const insets = useSafeAreaInsets()
  // Più la sfumatura: a riposo il primo elemento sta sotto di essa, intero.
  return TAB_HEADER_ROW + FADE + (Platform.OS === 'ios' ? 0 : insets.top)
}

export function TabHeader({ title, right }: { title: string; right?: ReactNode }) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const solid = insets.top + TAB_HEADER_ROW
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 }}>
      <View pointerEvents="box-none" style={{ height: solid, paddingTop: insets.top, backgroundColor: c.background, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, gap: 12 }}>
        <Text variant="display" numberOfLines={1} accessibilityRole="header" style={{ flex: 1 }}>
          {title}
        </Text>
        {right}
      </View>
      <Svg pointerEvents="none" width="100%" height={FADE}>
        <Defs>
          <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={c.background} stopOpacity={1} />
            <Stop offset="1" stopColor={c.background} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={FADE} fill="url(#fade)" />
      </Svg>
    </View>
  )
}
