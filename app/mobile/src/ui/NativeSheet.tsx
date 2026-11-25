// Content of a native sheet (iOS `formSheet` route): handle and glass come from the system, here only the layout.
// `fit`: the sheet is as tall as its content (scrolls only if it doesn't fit above the keyboard); otherwise two heights (half and full) and the content scrolls.
import { useEffect, useRef, type ComponentRef, type ReactNode } from 'react'
import { ScrollView, View, useWindowDimensions } from 'react-native'
import { KeyboardAwareScrollView, useKeyboardState } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useDev } from '@/store/dev'
import { Text } from './Text'

/** Sheet title: drawn by the content, the same in the native sheet and in our own. */
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
  // Development only: the driver scrolls the sheet (scroll test with the keyboard).
  useEffect(() => {
    if (!__DEV__) return
    const fn = (y: number) => scroller.current?.scrollTo({ y, animated: false })
    useDev.setState({ scrollSheet: fn })
    return () => {
      if (useDev.getState().scrollSheet === fn) useDev.setState({ scrollSheet: null })
    }
  }, [])
  const kb = useKeyboardState((st) => (st.isVisible ? st.height : 0))
  // Below the handle (about 20 pt) the title gets room to breathe.
  const base = { paddingTop: 28, paddingBottom: Math.max(insets.bottom, 16) + 8 }
  // With the keyboard up the phone's bottom safe area is already within the keyboard's height.
  const pad = { ...base, paddingBottom: kb > 0 ? 12 : base.paddingBottom }
  if (fit) {
    // As tall as the content, but never more than the space above the keyboard. The system stretches the keyboard's sheet and gives the list all
    // that height: `contentInset` lets the bottom scroll above the keyboard when the content (small phone, options open) is taller.
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
