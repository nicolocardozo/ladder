// Lista della chat: agganciata in fondo (FlatList invertita: il fondo è l'origine, quindi il testo in arrivo non sposta nulla),
// bottone a freccia per tornare giù se si scorre, scorrere chiude la tastiera, pagine più vecchie caricate in testa.
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
/** Oltre questa distanza dal fondo compare il bottone a freccia e il contenuto nuovo non sposta più ciò che leggi. */
const AWAY_PX = 320
/** Entro questa distanza si considera "in fondo": il testo in arrivo resta in vista. */
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

  // Solo sviluppo: il driver può scorrere la chat per provare l'ancoraggio.
  useEffect(() => {
    if (!__DEV__) return
    useDev.getState().setScrollChat((offset) => ref.current?.scrollToOffset({ offset, animated: false }))
    return () => useDev.getState().setScrollChat(null)
  }, [])

  // Ancoraggio. Lista invertita: l'offset 0 è il fondo, quindi il testo che arriva resta in vista da solo. Se stai leggendo più su
  // (offset > AWAY_PX) il contenuto nuovo spingerebbe via quello che guardi: si compensa la crescita. Le pagine più vecchie
  // si aggiungono dall'altra parte e non spostano nulla, quindi in quel caso non si compensa. (maintainVisibleContentPosition
  // ancora all'indice 0, il messaggio più recente: dopo una risposta lasciava la lista lontana dal fondo.)
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
        // Il layout nuovo arriva dopo: si smette di ignorare la crescita solo a cose assestate.
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
