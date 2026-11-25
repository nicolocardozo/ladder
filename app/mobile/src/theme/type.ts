// Phone type scale: one step up for touch compared to the desktop (DESIGN.md).
// 13 / 15 / 17 / 17 semibold / 22 / 28. Mona Sans for the interface, system font for the chat, Monaspace Neon for code.
export const FONT = {
  regular: 'MonaSans-Regular',
  medium: 'MonaSans-Medium',
  semibold: 'MonaSans-SemiBold',
  monoRegular: 'MonaspaceNeon-Regular',
  monoSemibold: 'MonaspaceNeon-SemiBold'
} as const

export type Variant = 'caption' | 'body' | 'bodyL' | 'title' | 'headline' | 'display' | 'label' | 'code'

export interface TypeStyle {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing?: number
}

export const TYPE: Record<Variant, TypeStyle> = {
  caption: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
  label: { fontFamily: FONT.medium, fontSize: 13, lineHeight: 18 },
  body: { fontFamily: FONT.regular, fontSize: 15, lineHeight: 22 },
  bodyL: { fontFamily: FONT.regular, fontSize: 17, lineHeight: 24 },
  title: { fontFamily: FONT.semibold, fontSize: 17, lineHeight: 24, letterSpacing: -0.2 },
  headline: { fontFamily: FONT.semibold, fontSize: 22, lineHeight: 28, letterSpacing: -0.33 },
  display: { fontFamily: FONT.semibold, fontSize: 28, lineHeight: 34, letterSpacing: -0.56 },
  code: { fontFamily: FONT.monoRegular, fontSize: 13, lineHeight: 20 }
}

/** Cap on growth with Dynamic Type / Android font size, so the UI does not break. */
export const MAX_FONT_SCALE = 1.5

export const SPACE = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 } as const
export const RADIUS = { sm: 6, md: 8, lg: 12, xl: 16 } as const
export const HAIRLINE = 1
/** Minimum target: 44 pt on iOS, 48 dp on Android. */
export const TOUCH = { ios: 44, android: 48 }
