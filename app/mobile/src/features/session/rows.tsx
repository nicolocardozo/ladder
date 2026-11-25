// Chat rows: user message, agent reply (markdown, text revealed at a steady pace),
// turn row ("Edited 2 files and ran 3 commands"), notes.
import { memo, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Image, Pressable, View } from 'react-native'
import { plural, t } from '@shared/i18n'
import { isImagePlaceholder } from '@shared/image-placeholder'
import { duration } from '@/lib/format'
import { thumbFor } from '@/lib/sent-thumbs'
import { nextRevealLength, sliceReveal } from '@/lib/text-reveal'
import { summaryParts, type ChatRow, type TurnSummary } from '@/lib/turns'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Icon } from '@/ui/Icon'
import { StateGlyph } from '@/ui/StateGlyph'
import { Text } from '@/ui/Text'
import { CHAT_FONT_SIZE, CHAT_LINE_HEIGHT, Markdown } from './Markdown'

/** Streaming text revealed at a steady pace (see lib/text-reveal). Updates ~12 times per second. */
function useRevealed(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(() => (streaming ? Math.max(0, text.length - 80) : text.length))
  const target = useRef(text.length)
  target.current = text.length
  const active = streaming || shown < text.length
  useEffect(() => {
    if (!active) return
    let last = Date.now()
    const id = setInterval(() => {
      const now = Date.now()
      const dt = now - last
      last = now
      setShown((s) => nextRevealLength(s, target.current, dt))
    }, 80)
    return () => clearInterval(id)
  }, [active])
  return active ? sliceReveal(text, Math.min(shown, text.length)) : text
}

export const AssistantText = memo(function AssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  const shown = useRevealed(text, streaming)
  // No "live" region while the text scrolls (a screen reader would repeat every chunk): the reply is announced at the end of the turn.
  const was = useRef(streaming)
  useEffect(() => {
    if (was.current && !streaming && text) AccessibilityInfo.announceForAccessibility(text.slice(0, 300))
    was.current = streaming
  }, [streaming, text])
  if (!shown && !streaming) return null
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
      <Markdown>{shown || ' '}</Markdown>
    </View>
  )
})

export const UserBubble = memo(function UserBubble({ text, steered, attachments }: { text: string; steered?: boolean; attachments?: { name: string; mediaType: string }[] }) {
  const { c } = useTheme()
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 6, alignItems: 'flex-end', gap: 6 }}>
      {attachments?.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, maxWidth: '86%' }}>
          {attachments.map((a, i) => {
            const uri = thumbFor(a.name)
            return uri ? (
              <Image key={`${a.name}-${i}`} source={{ uri }} accessibilityLabel={t('Photo {n} of {total}', { n: i + 1, total: attachments.length })} accessibilityIgnoresInvertColors style={{ width: 96, height: 96, borderRadius: RADIUS.lg, backgroundColor: c.surface }} />
            ) : (
              <View key={`${a.name}-${i}`} accessible accessibilityLabel={a.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, minHeight: 32, borderRadius: RADIUS.md, backgroundColor: c.surface }}>
                <Icon name="image" size={16} color={c.textMuted} />
                <Text variant="caption" tone="muted" numberOfLines={1} style={{ maxWidth: 180 }}>
                  {a.name}
                </Text>
              </View>
            )
          })}
        </View>
      ) : null}
      {text.trim() && !(attachments?.length && isImagePlaceholder(text.trim())) ? (
        <View style={{ maxWidth: '86%', backgroundColor: c.selection, borderRadius: RADIUS.xl, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 10 }}>
          <Text system selectable style={{ fontSize: CHAT_FONT_SIZE, lineHeight: CHAT_LINE_HEIGHT }}>
            {text}
          </Text>
        </View>
      ) : null}
      {steered ? (
        <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
          {t('Sent into the running turn')}
        </Text>
      ) : null}
    </View>
  )
})

/** "Edited 2 files and ran 3 commands": the sentence saying what happened, from the tool counts. */
export function summaryText(turn: TurnSummary): string {
  const parts = summaryParts(turn.counts, turn.files).map((p) => {
    switch (p.key) {
      case 'edits':
        return plural(p.n, 'edited 1 file', 'edited {n} files')
      case 'commands':
        return plural(p.n, 'ran 1 command', 'ran {n} commands')
      case 'reads':
        return plural(p.n, 'read 1 file', 'read {n} files')
      case 'searches':
        return plural(p.n, 'searched once', 'searched {n} times')
    }
  })
  const sentence = parts.length === 0 ? (turn.end ? t('replied') : t('is working')) : parts.length === 1 ? parts[0] : t('{a} and {b}', { a: parts.slice(0, -1).join(', '), b: parts[parts.length - 1] })
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

export const TurnLine = memo(function TurnLine({ turn, onPress }: { turn: TurnSummary; onPress: () => void }) {
  const { c } = useTheme()
  const failed = turn.end?.status === 'error'
  const text = turn.running && !turn.waiting ? (turn.current?.title ?? summaryText(turn)) : summaryText(turn)
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${summaryText(turn)}. ${t('Show steps')}`}
        style={({ pressed }) => ({ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, borderRadius: RADIUS.lg, backgroundColor: pressed ? c.selection : c.surface })}
      >
        {turn.waiting ? <StateGlyph state="waiting" size={16} /> : turn.running ? <StateGlyph state="running" size={16} /> : failed ? <StateGlyph state="error" size={16} /> : <Icon name="check" size={16} color={c.textMuted} />}
        <View style={{ flex: 1 }}>
          <Text variant="body" numberOfLines={1} style={{ fontFamily: 'MonaSans-Medium' }}>
            {text}
          </Text>
          {turn.running && turn.current ? (
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {summaryText(turn)}
            </Text>
          ) : null}
        </View>
        {turn.end ? (
          <Text variant="caption" tone="muted">
            {duration(turn.end.durationMs)}
          </Text>
        ) : null}
        <Icon name="chevron-right" size={16} color={alpha(c.textMuted, 0.8)} />
      </Pressable>
    </View>
  )
})

export function NoteRow({ row }: { row: Extract<ChatRow, { kind: 'note' }> }) {
  return (
    <Text variant="caption" tone={row.tone === 'error' ? 'error' : 'muted'} style={{ paddingHorizontal: 24, paddingVertical: 6, textAlign: 'center' }}>
      {row.text}
    </Text>
  )
}

export function StoppedRow({ row }: { row: Extract<ChatRow, { kind: 'stopped' }> }) {
  const { c } = useTheme()
  const failed = row.end.status === 'error'
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 6, flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
      <View style={{ marginTop: 3 }}>
        <StateGlyph state={failed ? 'error' : 'queued'} size={14} />
      </View>
      <Text variant="body" style={{ flex: 1, color: failed ? c.error : c.textMuted }}>
        {failed ? (row.end.error ?? t('The turn failed.')) : t('Stopped')}
      </Text>
    </View>
  )
}
