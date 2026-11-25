// App text field: like React Native's, but with text and placeholder vertically centered, the same on iOS and Android.
// - Single line: no `lineHeight` (the system puts the text at the top of the tall line, below center), equal vertical paddings and, on
//   Android, centered text without "font padding". With Mona Sans on iOS the text comes out about one point too low: compensated with
//   more padding below, proportional to the font size (measured at 15 and 17 pt).
// - Multiline: the line height is needed for wrapping; the extra space the line has over the font sits above the text, so
//   the padding is moved from above to below by half of that space. With a minimum height of one or two lines the first line is centered.
// Color, font size and margins are left to whoever uses the field; `lineHeight` and vertical paddings are normalized here.
import { forwardRef, type ComponentRef } from 'react'
import { Platform, StyleSheet, TextInput as RNTextInput, type TextInputProps, type TextStyle } from 'react-native'

export const TextInput = forwardRef<ComponentRef<typeof RNTextInput>, TextInputProps>(function TextInput({ style, multiline, ...rest }, ref) {
  const flat = StyleSheet.flatten(style) ?? {}
  const fontSize = typeof flat.fontSize === 'number' ? flat.fontSize : 16
  // Symmetric vertical padding: the larger of the two (or paddingVertical), as the field's user intended.
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  const vertical = Math.max(num(flat.padding), num(flat.paddingVertical), num(flat.paddingTop), num(flat.paddingBottom))
  const fixed: Record<string, unknown> = { paddingTop: vertical, paddingBottom: vertical, paddingVertical: undefined }
  if (multiline) {
    // Multiline: the line height is needed (wrapping), but the minimum height is one line plus the paddings and the text starts at the top.
    const line = typeof flat.lineHeight === 'number' ? flat.lineHeight : Math.round(fontSize * 1.35)
    fixed.lineHeight = line
    // Minimum height of one or two lines: padding = half the leftover space; with three lines or more the text starts at the top.
    const min = typeof flat.minHeight === 'number' ? flat.minHeight : 0
    if (min > 0 && min <= line * 2.6) {
      const centered = Math.max(vertical, Math.round((min - line) / 2))
      fixed.paddingTop = centered
      fixed.paddingBottom = centered
    }
    if (Platform.OS === 'android') Object.assign(fixed, { includeFontPadding: false, textAlignVertical: 'top' })
    // Extra line space (lineHeight minus the font's natural height): it sits above the text, so it is shifted up by half.
    {
      const natural = typeof flat.fontFamily === 'string' && flat.fontFamily.startsWith('MonaSans') ? 1.35 : 1.2 // natural line height / font size
      const shift = Math.max(0, (line - fontSize * natural) / 2)
      const top = Number(fixed.paddingTop)
      const bottom = Number(fixed.paddingBottom)
      const k = Math.min(shift, top)
      fixed.paddingTop = top - k
      fixed.paddingBottom = bottom + k
    }
    fixed.minHeight = typeof flat.minHeight === 'number' ? flat.minHeight : line + vertical * 2
  } else {
    fixed.lineHeight = undefined
    if (Platform.OS === 'ios' && typeof flat.fontFamily === 'string' && flat.fontFamily.startsWith('MonaSans')) fixed.paddingBottom = vertical + Math.floor(fontSize * 0.18)
    if (Platform.OS === 'android') Object.assign(fixed, { includeFontPadding: false, textAlignVertical: 'center' })
  }
  return <RNTextInput ref={ref} multiline={multiline} {...rest} style={[style, fixed as TextStyle]} />
})
