// Contenuto di uno sheet nativo (rotta `formSheet` di iOS): maniglia e vetro li mette il sistema, qui solo l'impaginazione.
// `fit`: lo sheet è alto quanto il contenuto (nessuno scroll); altrimenti due altezze (metà e piena) e il contenuto scorre.
import { type ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from './Text'

/** Titolo di uno sheet: lo disegna il contenuto, uguale nello sheet nativo e in quello nostro. */
export function SheetTitle({ children }: { children: ReactNode }) {
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12 }}>
      <Text variant="headline" accessibilityRole="header">
        {children}
      </Text>
    </View>
  )
}

export function NativeSheet({ fit, children }: { fit?: boolean; children: ReactNode }) {
  const insets = useSafeAreaInsets()
  // Sotto la maniglia (circa 20 pt) il titolo respira.
  const pad = { paddingTop: 28, paddingBottom: Math.max(insets.bottom, 16) + 8 }
  if (fit) return <View style={pad}>{children}</View>
  return (
    <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentInsetAdjustmentBehavior="never" contentContainerStyle={pad}>
      {children}
    </ScrollView>
  )
}
