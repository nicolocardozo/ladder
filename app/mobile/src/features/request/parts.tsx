// Shared pieces for showing a request: command in mono, paths, preview with - and +.
import { View } from 'react-native'
import type { RequestItemData } from '@shared/protocol'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Text } from '@/ui/Text'

export function CodeBlock({ text, lines, selectable }: { text: string; lines?: number; selectable?: boolean }) {
  const { c } = useTheme()
  return (
    <View style={{ backgroundColor: c.codeBackground, borderRadius: RADIUS.md, paddingHorizontal: 12, paddingVertical: 10 }}>
      <Text variant="code" numberOfLines={lines} selectable={selectable} style={{ fontFamily: 'MonaspaceNeon-Regular' }}>
        {text}
      </Text>
    </View>
  )
}

/** Preview of the change: lines with - and +, shape (sign) and tint together. */
export function EditPreview({ text }: { text: string }) {
  const { c } = useTheme()
  const lines = text.split('\n')
  return (
    <View style={{ backgroundColor: c.codeBackground, borderRadius: RADIUS.md, paddingVertical: 6, overflow: 'hidden' }}>
      {lines.map((line, i) => {
        const sign = line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : ' '
        const body = line.slice(1)
        const bg = sign === '+' ? alpha(c.success, 0.14) : sign === '-' ? alpha(c.error, 0.14) : 'transparent'
        const color = sign === '+' ? c.success : sign === '-' ? c.error : c.textMuted
        return (
          <View key={i} style={{ flexDirection: 'row', backgroundColor: bg, paddingHorizontal: 12 }}>
            <Text variant="code" style={{ color, width: 14, fontFamily: 'MonaspaceNeon-SemiBold' }}>
              {sign === ' ' ? '' : sign}
            </Text>
            <Text variant="code" style={{ flex: 1, fontFamily: 'MonaspaceNeon-Regular' }}>
              {body}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

/** What to show as the "command or path" of a request. */
export function subjectOf(r: RequestItemData): { label: 'command' | 'file' | 'files'; text: string } | null {
  if (r.command) return { label: 'command', text: r.command }
  if (r.paths && r.paths.length > 1) return { label: 'files', text: r.paths.join('\n') }
  if (r.path) return { label: 'file', text: r.path }
  return null
}

/** Request that is better decided in the sheet: questions and edits with a preview. */
export const needsSheet = (r: RequestItemData): boolean => r.requestType === 'question' || !!r.preview
