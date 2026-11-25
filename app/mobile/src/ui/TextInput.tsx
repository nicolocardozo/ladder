// Campo di testo dell'app: come quello di React Native, ma con il testo allineato uguale su iOS e Android.
// Android aggiunge di suo il "font padding" (spazio per accenti e discendenti) e per un campo a riga singola mette il testo in alto:
// risultato, il testo sta più in basso del centro rispetto a icone e pulsanti accanto. Qui si toglie il padding e si centra
// (riga singola) o si parte dall'alto (più righe). Lo stile passato da chi usa il campo vince.
import { forwardRef, type ComponentRef } from 'react'
import { Platform, TextInput as RNTextInput, type TextInputProps } from 'react-native'

export const TextInput = forwardRef<ComponentRef<typeof RNTextInput>, TextInputProps>(function TextInput({ style, multiline, ...rest }, ref) {
  const base = Platform.OS === 'android' ? { includeFontPadding: false, textAlignVertical: multiline ? ('top' as const) : ('center' as const) } : null
  return <RNTextInput ref={ref} multiline={multiline} {...rest} style={[base, style]} />
})
