// Markdown nativo per le risposte dell'agente (react-native-markdown-display: solo View e Text, niente WebView, App Store 4.2).
// Testo con il font di sistema, codice in Monaspace Neon.
import { memo, useMemo } from 'react'
import { Linking, Platform } from 'react-native'
import MarkdownDisplay from 'react-native-markdown-display'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'

const SYSTEM = Platform.select({ ios: 'System', default: undefined })

export const CHAT_FONT_SIZE = 16
export const CHAT_LINE_HEIGHT = 24

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  const { c } = useTheme()
  const style = useMemo(
    () => ({
      body: { color: c.text, fontFamily: SYSTEM, fontSize: CHAT_FONT_SIZE, lineHeight: CHAT_LINE_HEIGHT },
      paragraph: { marginTop: 0, marginBottom: 10 },
      strong: { fontWeight: '700' as const },
      em: { fontStyle: 'italic' as const },
      link: { color: c.accent, textDecorationLine: 'underline' as const },
      heading1: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const, marginTop: 8, marginBottom: 8 },
      heading2: { fontSize: 19, lineHeight: 26, fontWeight: '700' as const, marginTop: 8, marginBottom: 6 },
      heading3: { fontSize: 17, lineHeight: 24, fontWeight: '700' as const, marginTop: 6, marginBottom: 4 },
      bullet_list: { marginBottom: 6 },
      ordered_list: { marginBottom: 6 },
      list_item: { marginBottom: 2 },
      bullet_list_icon: { color: c.textMuted, marginLeft: 4, marginRight: 8 },
      ordered_list_icon: { color: c.textMuted, marginLeft: 4, marginRight: 8 },
      code_inline: { fontFamily: 'MonaspaceNeon-Regular', fontSize: 14, backgroundColor: c.codeBackground, color: c.text, borderRadius: 4, paddingHorizontal: 4, borderWidth: 0 },
      code_block: { fontFamily: 'MonaspaceNeon-Regular', fontSize: 13, lineHeight: 20, backgroundColor: c.codeBackground, color: c.text, borderRadius: RADIUS.md, padding: 12, borderWidth: 0, marginBottom: 10 },
      fence: { fontFamily: 'MonaspaceNeon-Regular', fontSize: 13, lineHeight: 20, backgroundColor: c.codeBackground, color: c.text, borderRadius: RADIUS.md, padding: 12, borderWidth: 0, marginBottom: 10 },
      blockquote: { backgroundColor: 'transparent', borderLeftColor: c.controlBorder, borderLeftWidth: 3, paddingHorizontal: 12, marginLeft: 0, marginBottom: 10 },
      hr: { backgroundColor: c.border, height: 1, marginVertical: 12 },
      table: { borderColor: c.border, borderWidth: 1, borderRadius: RADIUS.sm, marginBottom: 10 },
      th: { padding: 6, fontWeight: '700' as const },
      td: { padding: 6, borderColor: alpha(c.border, 0.6) },
      tr: { borderColor: c.border }
    }),
    [c]
  )
  return (
    <MarkdownDisplay
      style={style}
      onLinkPress={(url) => {
        void Linking.openURL(url)
        return false
      }}
    >
      {children}
    </MarkdownDisplay>
  )
})
