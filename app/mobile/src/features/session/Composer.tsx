// Composer: il tasto fa ciò che dice la preferenza (di default accoda), la pressione lunga fa l'altra azione con una vibrazione;
// coda sopra il campo con righe modificabili e "Send now"; Stop al posto di Invia con il campo vuoto e la sessione al lavoro.
// Con una richiesta aperta il composer diventa la risposta: l'invio vale Deny con quel testo.
import * as Haptics from 'expo-haptics'
import { useEffect, useRef, useState } from 'react'
import { Keyboard, Pressable, ScrollView, TextInput, View } from 'react-native'
import { KeyboardEvents } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '@shared/i18n'
import type { QueuedMessage } from '@shared/protocol'
import { actions } from '@/host/actions'
import { canAct } from '@/host/controller'
import type { RequestItem } from '@/lib/turns'
import { useApp } from '@/store/app'
import { usePrefs } from '@/store/prefs'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Button, MIN_TOUCH } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import { StateGlyph } from '@/ui/StateGlyph'
import { Text } from '@/ui/Text'
import { useToast } from '@/ui/toast'
import { CodeBlock, subjectOf } from '../request/parts'

function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const a = KeyboardEvents.addListener('keyboardWillShow', () => setOpen(true))
    const b = KeyboardEvents.addListener('keyboardWillHide', () => setOpen(false))
    return () => {
      a.remove()
      b.remove()
    }
  }, [])
  return open
}

export function Composer({ sessionId, request, onReview }: { sessionId: string; request: RequestItem | null; onReview: (requestId: string) => void }) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const kb = useKeyboardOpen()
  const session = useApp((s) => s.sessions[sessionId])
  const queue = session.queue ?? []
  const online = useApp((s) => canAct(s.conn))
  const draft = usePrefs((s) => s.drafts[sessionId] ?? '')
  const setDraft = usePrefs((s) => s.setDraft)
  const [text, setText] = useState(draft)
  const [editing, setEditing] = useState<string | null>(null)
  // Il testo resta come bozza (anche senza connessione): si salva a ogni modifica.
  const change = (v: string) => {
    setText(v)
    setDraft(sessionId, v)
  }
  const working = session.run === 'running' || session.run === 'starting'
  const empty = text.trim().length === 0
  const answering = !!request
  const showStop = working && empty && !answering
  const canSteer = session.canSteer
  // Cosa fa il tasto è la preferenza del Mac (RemotePrefs.busySend); la pressione lunga fa l'altra azione. Un agente che non
  // accetta messaggi nel turno accoda sempre.
  const prefersSteer = useApp((s) => s.prefs.busySend) === 'steer' && canSteer
  const tapHow: 'queue' | 'steer' = prefersSteer ? 'steer' : 'queue'
  const holdHow: 'queue' | 'steer' = prefersSteer ? 'queue' : 'steer'
  const disabled = !online

  // Se l'invio fallisce il testo torna nel campo, purché nel frattempo non se ne sia scritto altro.
  const textRef = useRef(text)
  textRef.current = text
  const restore = (body: string) => {
    if (textRef.current.trim().length === 0) change(body)
  }

  const send = async (how: 'queue' | 'steer') => {
    const body = text.trim()
    if (!body || disabled) return
    change('')
    if (answering) {
      Keyboard.dismiss()
      if (!(await actions.deny(sessionId, request, body))) restore(body)
      return
    }
    if (!(await actions.send(sessionId, body, how))) restore(body)
  }
  const onLongPress = () => {
    if (empty || disabled || answering || !working) return
    if (holdHow === 'steer' && !canSteer) {
      useToast.getState().show(t('This agent can’t take messages while it works.'))
      return
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    void send(holdHow)
  }

  const sub = request ? subjectOf(request) : null
  const placeholder = answering ? t('Tell the agent what to do instead') : working ? (prefersSteer ? t('Message to the running turn') : t('Message to queue')) : t('Message')
  const bottomPad = kb ? 8 : Math.max(insets.bottom, 8)

  return (
    <View style={{ backgroundColor: c.background, borderTopWidth: 1, borderTopColor: c.border, paddingBottom: bottomPad }}>
      {request ? (
        <View style={{ marginHorizontal: 12, marginTop: 10, borderRadius: RADIUS.lg, backgroundColor: alpha(c.waiting, 0.12), borderWidth: 1, borderColor: alpha(c.waiting, 0.5), padding: 12, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <StateGlyph state="waiting" size={16} />
            <Text variant="label" tone="waiting" style={{ flex: 1 }} numberOfLines={1}>
              {request.requestType === 'question' ? t('The agent has a question') : request.title}
            </Text>
            <Button label={t('Review')} variant="primary" style={{ minHeight: 40, paddingHorizontal: 14 }} onPress={() => onReview(request.requestId)} />
          </View>
          {sub ? <CodeBlock text={sub.text} lines={1} /> : null}
        </View>
      ) : null}
      {queue.length > 0 ? (
        <ScrollView style={{ maxHeight: 148, marginTop: 8 }} keyboardShouldPersistTaps="handled">
          {queue.map((q) => (
            <QueueRow
              key={q.id}
              item={q}
              editing={editing === q.id}
              disabled={disabled}
              onEdit={() => setEditing(q.id)}
              onCommit={(value) => {
                setEditing(null)
                const next = value.trim()
                const updated: QueuedMessage[] = queue.flatMap((m) => (m.id !== q.id ? [m] : next ? [{ ...m, text: next }] : []))
                void actions.queueSet(sessionId, updated)
              }}
              onRemove={() => void actions.queueSet(sessionId, queue.filter((m) => m.id !== q.id))}
              onSendNow={() => void actions.queueDeliver(sessionId, q.id, canSteer ? 'steer' : 'now')}
            />
          ))}
        </ScrollView>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 10 }}>
        <View style={{ flex: 1, minHeight: MIN_TOUCH, maxHeight: 150, borderRadius: 22, backgroundColor: c.surface, borderWidth: 1, borderColor: answering ? alpha(c.waiting, 0.6) : c.border, justifyContent: 'center' }}>
          <TextInput
            value={text}
            onChangeText={change}
            placeholder={placeholder}
            placeholderTextColor={c.textMuted}
            multiline
            accessibilityLabel={placeholder}
            style={{ color: c.text, fontSize: 16, lineHeight: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, maxHeight: 150 }}
          />
        </View>
        {showStop ? (
          <Pressable onPress={() => void actions.interrupt(sessionId)} disabled={disabled} accessibilityRole="button" accessibilityLabel={t('Stop')} style={({ pressed }) => ({ width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.selection : c.surface, borderWidth: 1.5, borderColor: c.controlBorder, opacity: disabled ? 0.4 : 1 })}>
            <Icon name="stop" size={22} color={c.text} />
          </Pressable>
        ) : (
          <Pressable
            onPress={() => void send(tapHow)}
            onLongPress={onLongPress}
            delayLongPress={380}
            disabled={empty || disabled}
            accessibilityRole="button"
            accessibilityLabel={answering ? t('Deny with this message') : working ? (prefersSteer ? t('Send into the running turn') : t('Queue message')) : t('Send')}
            accessibilityHint={working && canSteer && !answering ? (prefersSteer ? t('Hold to queue') : t('Hold to send into the running turn')) : undefined}
            style={({ pressed }) => ({ width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: answering ? c.waiting : c.accent, opacity: empty || disabled ? 0.35 : pressed ? 0.85 : 1 })}
          >
            <Icon name="arrow-up" size={22} color={answering ? c.background : c.onAccent} strokeWidth={2.2} />
          </Pressable>
        )}
      </View>
      {working && !empty && !answering && canSteer ? (
        <Text variant="caption" tone="muted" style={{ paddingHorizontal: 20, paddingTop: 6, textAlign: 'right' }}>
          {prefersSteer ? t('Tap to send into the turn · hold to queue') : t('Tap to queue · hold to send into the turn')}
        </Text>
      ) : null}
      {disabled ? (
        <Text variant="caption" tone="muted" style={{ paddingHorizontal: 20, paddingTop: 6 }}>
          {t('Offline. What you type stays here as a draft.')}
        </Text>
      ) : null}
      {answering && !disabled ? (
        <Text variant="caption" tone="waiting" style={{ paddingHorizontal: 20, paddingTop: 6 }}>
          {t('Sending denies the request with your message.')}
        </Text>
      ) : null}
    </View>
  )
}

function QueueRow({ item, editing, disabled, onEdit, onCommit, onRemove, onSendNow }: { item: QueuedMessage; editing: boolean; disabled: boolean; onEdit: () => void; onCommit: (v: string) => void; onRemove: () => void; onSendNow: () => void }) {
  const { c } = useTheme()
  const [value, setValue] = useState(item.text)
  useEffect(() => setValue(item.text), [item.text])
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginHorizontal: 12, marginBottom: 6, paddingLeft: 12, borderRadius: RADIUS.lg, backgroundColor: c.surface, minHeight: MIN_TOUCH }}>
      <View style={{ marginRight: 4 }}>
        <StateGlyph state="queued" size={16} />
      </View>
      {editing ? (
        <TextInput value={value} onChangeText={setValue} autoFocus multiline onBlur={() => onCommit(value)} style={{ flex: 1, color: c.text, fontSize: 15, paddingVertical: 8 }} accessibilityLabel={t('Edit queued message')} />
      ) : (
        <Pressable onPress={onEdit} disabled={disabled} accessibilityRole="button" accessibilityLabel={`${t('Edit queued message')}: ${item.text}`} style={{ flex: 1, paddingVertical: 8 }}>
          <Text variant="body" numberOfLines={2}>
            {item.text}
          </Text>
        </Pressable>
      )}
      <Button label={t('Send now')} variant="quiet" disabled={disabled} onPress={onSendNow} style={{ minHeight: MIN_TOUCH, paddingHorizontal: 8 }} />
      <Pressable onPress={onRemove} disabled={disabled} accessibilityRole="button" accessibilityLabel={t('Remove from queue')} style={{ width: 40, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="x" size={16} color={c.textMuted} />
      </Pressable>
    </View>
  )
}
