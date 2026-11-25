// Chat list: anchored to the bottom (inverted FlatList: the bottom is the origin, so incoming text shifts nothing),
// arrow button to jump back down when scrolled up, scrolling dismisses the keyboard, older pages load at the top.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import { t } from '@shared/i18n'
import type { ChatItem } from '@shared/protocol'
import { loadOlder } from '@/host/controller'
import { buildChatRows, type ChatRow, type TurnSummary } from '@/lib/turns'
import { useApp } from '@/store/app'
import { useDev } from '@/store/dev'
import { useTheme } from '@/theme/theme'
import { IconButton } from '@/ui/Button'
import { Text } from '@/ui/Text'
import { AssistantText, NoteRow, StoppedRow, TurnLine, UserBubble } from './rows'

const EMPTY: ChatItem[] = []
/** Beyond this distance from the bottom the arrow button appears and new content no longer shifts what you are reading. */
const AWAY_PX = 320
/** Within this distance counts as "at the bottom": incoming text stays in view. */
const STICKY_PX = 40

export function ChatList({ sessionId, onTurn, bottomInset }: { sessionId: string; onTurn: (turn: TurnSummary) => void; bottomInset: number }) {
  const { c } = useTheme()
  const items = useApp((s) => s.items[sessionId] ?? EMPTY)
  const loaded = useApp((s) => !!s.loaded[sessionId])
  const hasMore = useApp((s) => !!s.hasMore[sessionId])
  const ref = useRef<FlatList<ChatRow>>(null)
  const [away, setAway] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const olderRef = useRef(false)
  const run = useApp((s) => s.sessions[sessionId]?.run ?? 'idle')
  const rows = useMemo(() => buildChatRows(items, run).reverse(), [items, run])

  // Development only: the driver can scroll the chat to test anchoring.
  useEffect(() => {
    if (!__DEV__) return
    useDev.getState().setScrollChat((offset) => ref.current?.scrollToOffset({ offset, animated: false }))
    return () => useDev.getState().setScrollChat(null)
  }, [])

  // Anchoring. Inverted list: offset 0 is the bottom, so incoming text stays in view on its own. If you are reading further up
  // (offset > AWAY_PX) new content would push away what you are looking at: the growth is compensated. Older pages
  // are added on the other side and shift nothing, so no compensation in that case. (maintainVisibleContentPosition
  // anchored at index 0, the newest message, left the list far from the bottom after a reply.)
  const offsetRef = useRef(0)
  const heightRef = useRef(0)
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetRef.current = e.nativeEvent.contentOffset.y
    setAway(e.nativeEvent.contentOffset.y > AWAY_PX)
  }, [])
  const onContentSize = useCallback((_: number, h: number) => {
    const delta = h - heightRef.current
    heightRef.current = h
    if (delta > 0 && offsetRef.current > STICKY_PX && !olderRef.current) ref.current?.scrollToOffset({ offset: offsetRef.current + delta, animated: false })
  }, [])
  const older = useCallback(() => {
    if (!hasMore || loadingOlder) return
    setLoadingOlder(true)
    olderRef.current = true
    void loadOlder(sessionId)
      .catch(() => {})
      .finally(() => {
        // The new layout arrives later: growth stops being ignored only once things have settled.
        setTimeout(() => (olderRef.current = false), 400)
        setLoadingOlder(false)
      })
  }, [hasMore, loadingOlder, sessionId])

  const renderItem = useCallback(
    ({ item }: { item: ChatRow }) => {
      switch (item.kind) {
        case 'user':
          return <UserBubble text={item.item.text} steered={item.item.steered} attachments={item.item.attachments} />
        case 'assistant':
          return <AssistantText text={item.item.text} streaming={item.item.streaming} />
        case 'turn':
          return <TurnLine turn={item.turn} onPress={() => onTurn(item.turn)} />
        case 'note':
          return <NoteRow row={item} />
        case 'stopped':
          return <StoppedRow row={item} />
      }
    },
    [onTurn]
  )

  return (
    <View style={{ flex: 1 }}>
      {!loaded ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.textMuted} />
        </View>
      ) : (
        <FlatList
          ref={ref}
          inverted
          data={rows}
          keyExtractor={(r) => r.key}
          renderItem={renderItem}
          onScroll={onScroll}
          scrollEventThrottle={64}
          onEndReached={older}
          onEndReachedThreshold={0.6}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={onContentSize}
          ListHeaderComponent={<View style={{ height: 8 }} />}
          ListFooterComponent={loadingOlder ? <ActivityIndicator color={c.textMuted} style={{ padding: 16 }} /> : <View style={{ height: 12 }} />}
          ListEmptyComponent={
            <View style={{ transform: [{ scaleY: -1 }], padding: 32, alignItems: 'center' }}>
              <Text variant="body" tone="muted">
                {t('No messages yet.')}
              </Text>
            </View>
          }
          showsVerticalScrollIndicator={false}
        />
      )}
      {away ? (
        <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(120)} style={{ position: 'absolute', right: 16, bottom: 12 + bottomInset * 0 }}>
          <View style={{ backgroundColor: c.surface, borderRadius: 24, borderWidth: 1, borderColor: c.border }}>
            <IconButton icon="arrow-down" label={t('Scroll to latest')} onPress={() => ref.current?.scrollToOffset({ offset: 0, animated: true })} />
          </View>
        </Animated.View>
      ) : null}
    </View>
  )
}
