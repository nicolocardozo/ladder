import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { plural, t } from '@shared/i18n'
import { Composer } from '@/features/session/Composer'
import { ChatList } from '@/features/session/ChatList'
import { PermissionSheet, levelName } from '@/features/session/PermissionSheet'
import { SwitchSheet } from '@/features/session/SwitchSheet'
import { TurnSheet } from '@/features/session/TurnSheet'
import { RequestSheet } from '@/features/request/RequestSheet'
import { actions } from '@/host/actions'
import { canAct, follow } from '@/host/controller'
import { clearSessionNotifications } from '@/host/push'
import { stateLabel } from '@/lib/format'
import { sessionState } from '@/lib/session-state'
import { buildChatRows, openRequests, type TurnSummary } from '@/lib/turns'
import { useDev } from '@/store/dev'
import { usePush } from '@/store/push'
import { useApp } from '@/store/app'
import { useTheme } from '@/theme/theme'
import { AgentMark, useModelLabel } from '@/ui/AgentMark'
import { Chip } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import { ScreenHeader } from '@/ui/ScreenHeader'
import { StateGlyph } from '@/ui/StateGlyph'
import { Text } from '@/ui/Text'

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const session = useApp((s) => s.sessions[id])
  const items = useApp((s) => s.items[id])
  const online = useApp((s) => canAct(s.conn))
  const model = useModelLabel(session?.agent ?? 'claude-code', session?.model ?? null)
  const [turn, setTurn] = useState<TurnSummary | null>(null)
  const [switching, setSwitching] = useState(false)
  const [permission, setPermission] = useState(false)
  const [reviewing, setReviewing] = useState<string | null>(null)

  // Segue la sessione mentre la schermata è aperta (chat in diretta, ultima pagina).
  useEffect(() => {
    void follow(id).catch(() => {})
  }, [id])
  // Aprendola, la sessione si segna letta (anche quando arriva una risposta mentre guardi).
  const unread = session?.unread
  useFocusEffect(
    useCallback(() => {
      if (unread && online) void actions.markRead(id)
    }, [id, unread, online])
  )

  // Le notifiche di questa sessione, già nel Centro notifiche, non servono più.
  useFocusEffect(
    useCallback(() => {
      void clearSessionNotifications(id)
    }, [id])
  )

  const request = useMemo(() => (items ? openRequests(items)[0] : null), [items]) ?? null
  // Fallback: la richiesta del riepilogo, finché la chat non è arrivata.
  const pinned = request ?? (session?.request && session.request.state === 'open' ? session.request : null)

  // Aperta da una notifica "ti aspetta": si apre il foglio della richiesta, se è ancora aperta, ma solo dopo che la chat è stata riletta
  // dal Mac dopo il tocco (push-taps.ts azzera `loaded`) e il collegamento è pieno: una chat vecchia non dice se la richiesta c'è ancora.
  // Si lascia perdere se la sessione non esiste (più), se la richiesta è chiusa o se è passato troppo tempo.
  const wanted = usePush((p) => p.openRequest)
  const loaded = useApp((s) => !!s.loaded[id])
  useEffect(() => {
    if (!wanted || wanted.sessionId !== id) return
    const drop = () => usePush.getState().set({ openRequest: null })
    if (Date.now() - wanted.at > 60_000) return drop()
    if (!online) return
    const open = (items ? openRequests(items) : []).find((r) => r.requestId === wanted.requestId) ?? (session?.request?.state === 'open' && session.request.requestId === wanted.requestId ? session.request : null)
    if (open && loaded) {
      setReviewing(open.requestId)
      drop()
    } else if (loaded || !session) drop()
  }, [wanted, id, items, session, loaded, online])

  // Solo sviluppo: apre lo sheet richiesto dal deep link ladder://dev?sheet=…
  const devSheet = useDev((d) => d.sheet)
  useEffect(() => {
    if (!__DEV__ || !devSheet || !session || !items) return
    if (devSheet === 'permission' || devSheet === 'full') setPermission(true)
    else if (devSheet === 'switch') setSwitching(true)
    else if (devSheet === 'request' && pinned) setReviewing(pinned.requestId)
    else if (devSheet === 'turn') setTurn((buildChatRows(items, session.run).find((r) => r.kind === 'turn') as { turn: TurnSummary } | undefined)?.turn ?? null)
    useDev.getState().setSheet(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devSheet, !!session, !!items])

  if (!session) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <ScreenHeader title={t('Session')} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text variant="title">{t('This session is gone')}</Text>
          <Text variant="body" tone="muted" style={{ textAlign: 'center', marginTop: 6 }}>
            {t('It may have been archived on your Mac.')}
          </Text>
        </View>
      </View>
    )
  }

  const state = sessionState(session)
  const agentsRunning = session.subagentCounts?.running ?? 0
  const stateColor = state === 'waiting' ? c.waiting : state === 'error' ? c.error : c.textMuted
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader
        right={
          <View style={{ paddingRight: 8 }}>
            <Chip label={levelName(session.permission)} icon="shield" onPress={() => setPermission(true)} />
          </View>
        }
      >
        <Pressable onPress={() => setSwitching(true)} accessibilityRole="button" accessibilityLabel={`${session.title}. ${t('Switch session')}`} style={{ flex: 1, minHeight: 48, justifyContent: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text variant="title" numberOfLines={1} style={{ flexShrink: 1 }}>
              {session.title}
            </Text>
            <Icon name="chevron-down" size={16} color={c.textMuted} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <AgentMark agent={session.agent} size={13} />
            <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
              {model}
            </Text>
            <Text variant="caption" tone="muted">
              ·
            </Text>
            {state !== 'idle' ? <StateGlyph state={state} size={12} /> : null}
            <Text variant="caption" style={{ color: stateColor }} numberOfLines={1}>
              {state === 'idle' ? t('Idle') : stateLabel(state)}
            </Text>
          </View>
        </Pressable>
      </ScreenHeader>
      {agentsRunning > 0 ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
          <Text variant="caption" tone="muted">
            {plural(agentsRunning, '1 agent running', '{n} agents running')}
          </Text>
        </View>
      ) : null}
      <ChatList sessionId={id} onTurn={setTurn} bottomInset={insets.bottom} />
      {session.archived ? (
        <View style={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: Math.max(insets.bottom, 14), borderTopWidth: 1, borderTopColor: c.border }}>
          <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
            {t('Archived on your Mac. You can read it here.')}
          </Text>
        </View>
      ) : (
        <Composer sessionId={id} request={pinned} onReview={setReviewing} />
      )}
      <TurnSheet turn={turn} onClose={() => setTurn(null)} />
      <SwitchSheet sessionId={id} visible={switching} onClose={() => setSwitching(false)} />
      <PermissionSheet sessionId={id} visible={permission} onClose={() => setPermission(false)} />
      <RequestSheet sessionId={reviewing ? id : null} requestId={reviewing} onClose={() => setReviewing(null)} />
    </KeyboardAvoidingView>
  )
}
