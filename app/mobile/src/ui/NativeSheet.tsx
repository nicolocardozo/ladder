// Contenuto di uno sheet nativo (rotta `formSheet` di iOS): maniglia e vetro li mette il sistema, qui solo l'impaginazione.
// `fit`: lo sheet è alto quanto il contenuto (scorre solo se non sta sopra la tastiera); altrimenti due altezze (metà e piena) e il contenuto scorre.
import { useEffect, useRef, type ComponentRef, type ReactNode } from 'react'
import { ScrollView, View, useWindowDimensions } from 'react-native'
import { KeyboardAwareScrollView, useKeyboardState } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useDev } from '@/store/dev'
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
  const { height: screen } = useWindowDimensions()
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null)
  // Solo sviluppo: il driver fa scorrere lo sheet (prova dello scorrimento con la tastiera).
  useEffect(() => {
    if (!__DEV__) return
    const fn = (y: number) => scroller.current?.scrollTo({ y, animated: false })
    useDev.setState({ scrollSheet: fn })
    return () => {
      if (useDev.getState().scrollSheet === fn) useDev.setState({ scrollSheet: null })
    }
  }, [])
  const kb = useKeyboardState((st) => (st.isVisible ? st.height : 0))
  // Sotto la maniglia (circa 20 pt) il titolo respira.
  const base = { paddingTop: 28, paddingBottom: Math.max(insets.bottom, 16) + 8 }
  // Con la tastiera su il bordo di sicurezza del telefono sta già nell'altezza della tastiera.
  const pad = { ...base, paddingBottom: kb > 0 ? 12 : base.paddingBottom }
  if (fit) {
    // Alto quanto il contenuto, ma mai più dello spazio sopra la tastiera. Il sistema allunga lo sheet della tastiera e dà alla lista tutta
    // quell'altezza: `contentInset` lascia scorrere il fondo sopra la tastiera quando il contenuto (telefono piccolo, opzioni aperte) è più alto.
    const room = screen - insets.top - 24 - kb
    return (
      <ScrollView ref={scroller} style={{ maxHeight: room }} contentInset={{ bottom: kb }} scrollIndicatorInsets={{ bottom: kb }} bounces={false} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="never" contentContainerStyle={pad}>
        {children}
      </ScrollView>
    )
  }
  return (
    <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={24} contentInsetAdjustmentBehavior="never" contentContainerStyle={base}>
      {children}
    </KeyboardAwareScrollView>
  )
}
