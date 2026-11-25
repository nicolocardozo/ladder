import { Platform, Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native'
import { useTheme, type Tokens } from '@/theme/theme'
import { MAX_FONT_SCALE, TYPE, type Variant } from '@/theme/type'

export type Tone = 'default' | 'muted' | 'accent' | 'waiting' | 'error' | 'success' | 'running' | 'onAccent'

export function toneColor(c: Tokens, tone: Tone): string {
  switch (tone) {
    case 'muted':
      return c.textMuted
    case 'accent':
      return c.accent
    case 'waiting':
      return c.waiting
    case 'error':
      return c.error
    case 'success':
      return c.success
    case 'running':
      return c.running
    case 'onAccent':
      return c.onAccent
    default:
      return c.text
  }
}

/** Android aggiunge spazio sopra e sotto il testo (font padding): senza, il testo sta al centro della sua riga come su iOS. */
const ANDROID: TextStyle = { includeFontPadding: false }

interface Props extends RNTextProps {
  variant?: Variant
  tone?: Tone
  /** Font di sistema (per il testo della chat). */
  system?: boolean
}

/** Testo dell'interfaccia: Mona Sans, scala 13/15/17/22/28, con Dynamic Type limitato. */
export function Text({ variant = 'body', tone = 'default', system, style, ...rest }: Props) {
  const { c } = useTheme()
  const base = TYPE[variant]
  const override: TextStyle = system ? { fontFamily: undefined, fontWeight: variant === 'title' || variant === 'headline' || variant === 'display' ? '600' : '400' } : {}
  return <RNText maxFontSizeMultiplier={MAX_FONT_SCALE} {...rest} style={[base, Platform.OS === 'android' ? ANDROID : null, { color: toneColor(c, tone) }, override, style]} />
}
