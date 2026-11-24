// Un solo componente per gli sheet: sul telefono sale dal basso (con maniglia e swipe per chiudere), da 600 pt in su è una card
// centrata. Costruito su Modal nativo + Reanimated. Si era provato @gorhom/bottom-sheet (come in Paseo): con Expo SDK 58
// (gesture-handler 3.3, Reanimated 4.7) il modale veniva "presentato" ma non compariva; per ora un componente nostro,
// con la stessa interfaccia, così si può tornare a gorhom cambiando solo questo file.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Modal, PanResponder, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '@shared/i18n'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Text } from './Text'

export const WIDE = 600
const DURATION = 240

interface Props {
  visible: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  /** Altezza massima come frazione dello schermo. */
  maxHeight?: number
}

export function Sheet({ visible, onClose, title, children, maxHeight = 0.9 }: Props) {
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const { c } = useTheme()
  const wide = width >= WIDE
  // Resta montato durante l'animazione di chiusura.
  const [mounted, setMounted] = useState(visible)
  const progress = useSharedValue(visible ? 1 : 0)
  const drag = useSharedValue(0)

  const unmount = useCallback(() => setMounted(false), [])
  useEffect(() => {
    if (visible) {
      setMounted(true)
      drag.value = 0
      progress.value = withTiming(1, { duration: DURATION, easing: Easing.out(Easing.cubic) })
    } else if (mounted) {
      progress.value = withTiming(0, { duration: 200, easing: Easing.in(Easing.cubic) }, (done) => {
        if (done) runOnJS(unmount)()
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
        onPanResponderMove: (_, g) => {
          drag.value = Math.max(0, g.dy)
        },
        onPanResponderRelease: (_, g) => {
          if (g.dy > 110 || g.vy > 0.9) closeRef.current()
          else drag.value = withTiming(0, { duration: 160 })
        }
      }),
    [drag]
  )

  const backdrop = useAnimatedStyle(() => ({ opacity: progress.value * 0.55 }))
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - progress.value) * height + drag.value }] }))
  const cardStyle = useAnimatedStyle(() => ({ opacity: progress.value, transform: [{ scale: 0.97 + progress.value * 0.03 }] }))

  if (!mounted) return null

  const header = title ? (
    <View style={{ paddingHorizontal: 20, paddingTop: wide ? 0 : 4, paddingBottom: 12 }}>
      <Text variant="headline" accessibilityRole="header">
        {title}
      </Text>
    </View>
  ) : null

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent supportedOrientations={['portrait', 'landscape']}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, backdrop]} />
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t('Close')} accessibilityRole="button" />
      {wide ? (
        <View pointerEvents="box-none" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Animated.View style={[{ width: 520, maxWidth: '100%', maxHeight: height * 0.85, backgroundColor: c.surface, borderRadius: RADIUS.xl, paddingTop: 20, borderWidth: 1, borderColor: c.border }, cardStyle]}>
            {header}
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 20 }}>
              {children}
            </ScrollView>
          </Animated.View>
        </View>
      ) : (
        <KeyboardAvoidingView behavior="padding" pointerEvents="box-none" style={{ flex: 1, justifyContent: 'flex-end' }}>
          <Animated.View style={[{ maxHeight: height * maxHeight - insets.top, backgroundColor: c.surface, borderTopLeftRadius: RADIUS.xl + 4, borderTopRightRadius: RADIUS.xl + 4, overflow: 'hidden' }, sheetStyle]}>
            <View {...pan.panHandlers} style={{ height: 28, alignItems: 'center', justifyContent: 'center' }} accessibilityElementsHidden importantForAccessibility="no">
              <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: c.controlBorder }} />
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" bounces={false} contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
              {header}
              {children}
            </ScrollView>
          </Animated.View>
        </KeyboardAvoidingView>
      )}
    </Modal>
  )
}
