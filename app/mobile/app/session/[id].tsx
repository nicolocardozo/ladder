import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo } from 'react'
import { Pressable, View, useWindowDimensions } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { plural, t } from '@shared/i18n'
import { Composer } from '@/features/session/Composer'
import { ChatList } from '@/features/session/ChatList'
import { levelName } from '@/features/session/PermissionSheet'
import { UsageBanner, useOpenLimits, useSessionUsageAlert } from '@/features/usage/SessionUsage'
import { AlertGlyph } from '@/features/usage/UsageBits'
import { actions } from '@/host/actions'
import { canAct, follow } from '@/host/controller'
import { clearSessionNotifications } from '@/host/push'
import { stateLabel } from '@/lib/format'
import { sessionState } from '@/lib/session-state'
import { IOS } from '@/lib/platform'
import { openSheet } from '@/lib/sheets'
import { buildChatRows, openRequests, type TurnSummary } from '@/lib/turns'
import { useDev } from '@/store/dev'
import { usePush } from '@/store/push'
import { useApp } from '@/store/app'
import { useTheme } from '@/theme/theme'
import { AgentMark, useModelLabel } from '@/ui/AgentMark'
import { Chip } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
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
  const router = useRouter()
  const { width } = useWindowDimensions()
  const setTurn = useCallback((turn: TurnSummary) => openSheet(router, { kind: 'turn', sessionId: id, turn }), [router, id])
  const setReviewing = useCallback((requestId: string) => openSheet(router, { kind: 'request', sessionId: id, requestId }), [router, id])
  const openPermission = useCallback(() => openSheet(router, { kind: 'permission', sessionId: id }), [router, id])
  const openLimits = useOpenLimits(session)
  const openSwitch = useCallback(() => openSheet(router, { kind: 'switch', sessionId: id }), [router, id])

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
    if (devSheet === 'permission' || devSheet === 'full') openPermission()
    else if (devSheet === 'switch') openSwitch()
    else if (devSheet === 'request' && pinned) setReviewing(pinned.requestId)
    else if (devSheet === 'turn') {
      const turn = (buildChatRows(items, session.run).find((r) => r.kind === 'turn') as { turn: TurnSummary } | undefined)?.turn
      if (turn) setTurn(turn)
    }
    useDev.getState().setSheet(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devSheet, !!session, !!items])

  // Opzioni dell'header: si ricalcolano solo quando cambia ciò che si vede (titolo, modello, stato, permesso, tema), non a ogni
  // pezzo di testo in arrivo, altrimenti setOptions scatterebbe a ogni rendering durante lo streaming.
  const title = session?.title
  const agent = session?.agent
  const permission = session?.permission
  const state = session ? sessionState(session) : 'idle'
  // Avviso d'uso: il triangolo nell'header (da 80%, o a limite esaurito) accanto al permesso.
  const usage = useSessionUsageAlert(session)
  const usageLimited = usage?.alert.limited
  const usageLabel = usage ? `${usage.text.what}${usage.text.reset ? ` ${usage.text.reset}` : ''}` : null
  const headerOptions = useMemo(() => {
    if (!title || !agent || !permission) {
      // Sessione sparita: via titolo e pulsanti della sessione di prima, resta il titolo generico.
      return { title: t('Session'), headerTitle: t('Session'), headerRight: () => null, unstable_headerRightItems: () => [] }
    }
    const stateColor = state === 'waiting' ? c.waiting : state === 'error' ? c.error : c.textMuted
    const titleView = (
      <Pressable onPress={openSwitch} accessibilityRole="button" accessibilityLabel={`${title}. ${t('Switch session')}`} hitSlop={6} style={{ maxWidth: width - (IOS ? 190 : 170), alignItems: IOS ? 'center' : 'flex-start' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text variant="title" numberOfLines={1} style={{ flexShrink: 1 }}>
            {title}
          </Text>
          <Icon name="chevron-down" size={14} color={c.textMuted} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <AgentMark agent={agent} size={12} />
          <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
            {model}
          </Text>
          <Text variant="caption" tone="muted">
            ·
          </Text>
          {state !== 'idle' ? <StateGlyph state={state} size={11} /> : null}
          <Text variant="caption" style={{ color: stateColor }} numberOfLines={1}>
            {state === 'idle' ? t('Idle') : stateLabel(state)}
          </Text>
        </View>
      </Pressable>
    )
    // Il livello di permesso si legge a colpo d'occhio: icona e nome ("Ask"). Su iOS sta in una capsula di vetro dell'header.
    const chip = IOS ? (
      <Pressable onPress={openPermission} accessibilityRole="button" accessibilityLabel={`${t('Permission')}: ${levelName(permission)}`} hitSlop={6} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, height: 36 }}>
        <Icon name="shield" size={16} color={c.text} />
        <Text variant="label" style={{ color: c.text }}>
          {levelName(permission)}
        </Text>
      </Pressable>
    ) : (
      <Chip label={levelName(permission)} icon="shield" onPress={openPermission} />
    )
    const warn =
      usageLabel !== null ? (
        <Pressable onPress={openLimits} accessibilityRole="button" accessibilityLabel={`${usageLabel} ${t('Plan limits')}`} hitSlop={8} style={{ width: IOS ? 36 : 40, height: IOS ? 36 : 40, alignItems: 'center', justifyContent: 'center' }}>
          <AlertGlyph limited={!!usageLimited} size={20} />
        </Pressable>
      ) : null
    return {
      title,
      headerLargeTitleEnabled: false,
      headerTitle: () => titleView,
      headerTitleAlign: 'left' as const,
      // La chat è una lista invertita: il sistema non le applica l'effetto di bordo, quindi l'header ha lo sfondo pieno (i pulsanti restano di vetro).
      headerTransparent: false,
      headerStyle: { backgroundColor: c.background },
      unstable_headerRightItems: () => [...(warn ? [{ type: 'custom' as const, element: warn }] : []), { type: 'custom' as const, element: chip }],
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {warn}
          {chip}
        </View>
      )
    }
    // `model` e `state` dipendono da session ma cambiano di rado; il resto della sessione (attività, testo) non entra qui.
  }, [title, agent, permission, state, model, c, width, openSwitch, openPermission, openLimits, usageLabel, usageLimited])

  if (!session) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <Stack.Screen options={headerOptions} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text variant="title">{t('This session is gone')}</Text>
          <Text variant="body" tone="muted" style={{ textAlign: 'center', marginTop: 6 }}>
            {t('It may have been archived on your Mac.')}
          </Text>
        </View>
      </View>
    )
  }

  const agentsRunning = session.subagentCounts?.running ?? 0
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen options={headerOptions} />
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
        <>
          <UsageBanner session={session} />
          <Composer sessionId={id} request={pinned} onReview={setReviewing} />
        </>
      )}
    </KeyboardAvoidingView>
  )
}
