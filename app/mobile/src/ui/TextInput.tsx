// Campo di testo dell'app: come quello di React Native, ma con testo e segnaposto centrati in verticale, uguale su iOS e Android.
// - Riga singola: niente `lineHeight` (il sistema mette il testo in cima alla riga alta, sotto il centro), padding verticali uguali e, su
//   Android, testo centrato senza "font padding". Con Mona Sans su iOS il testo risulta circa un punto troppo in basso: si compensa con
//   più padding sotto, in proporzione al corpo (misurato a 15 e 17 pt).
// - Più righe: l'altezza di una riga serve per l'a capo; lo spazio che la riga ha in più rispetto al font sta sopra il testo, quindi si
//   sposta il padding da sopra a sotto della metà di quello spazio. Con un'altezza minima di una o due righe la prima riga sta al centro.
// Colore, corpo e margini restano a chi usa il campo; `lineHeight` e i padding verticali si normalizzano qui.
import { forwardRef, type ComponentRef } from 'react'
import { Platform, StyleSheet, TextInput as RNTextInput, type TextInputProps, type TextStyle } from 'react-native'

export const TextInput = forwardRef<ComponentRef<typeof RNTextInput>, TextInputProps>(function TextInput({ style, multiline, ...rest }, ref) {
  const flat = StyleSheet.flatten(style) ?? {}
  const fontSize = typeof flat.fontSize === 'number' ? flat.fontSize : 16
  // Padding verticale simmetrico: il maggiore dei due (o paddingVertical), come lo voleva chi usa il campo.
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  const vertical = Math.max(num(flat.padding), num(flat.paddingVertical), num(flat.paddingTop), num(flat.paddingBottom))
  const fixed: Record<string, unknown> = { paddingTop: vertical, paddingBottom: vertical, paddingVertical: undefined }
  if (multiline) {
    // Più righe: l'altezza di una riga serve (a capo), ma l'altezza minima è una riga più i padding e il testo parte dall'alto.
    const line = typeof flat.lineHeight === 'number' ? flat.lineHeight : Math.round(fontSize * 1.35)
    fixed.lineHeight = line
    // Altezza minima di una o due righe: padding = metà dello spazio che avanza; con tre righe o più il testo parte dall'alto.
    const min = typeof flat.minHeight === 'number' ? flat.minHeight : 0
    if (min > 0 && min <= line * 2.6) {
      const centered = Math.max(vertical, Math.round((min - line) / 2))
      fixed.paddingTop = centered
      fixed.paddingBottom = centered
    }
    if (Platform.OS === 'android') Object.assign(fixed, { includeFontPadding: false, textAlignVertical: 'top' })
    // Spazio in più della riga (lineHeight meno altezza naturale del font): sta sopra il testo, si sposta su di metà.
    {
      const natural = typeof flat.fontFamily === 'string' && flat.fontFamily.startsWith('MonaSans') ? 1.35 : 1.2 // altezza naturale della riga / corpo
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
