// Sheet della richiesta: permesso con comando o percorso per intero, motivo, anteprima della modifica, Deny e Approve
// (niente "Always allow" nella v1, niente swipe per approvare). Domande: opzioni singole o multiple e "Other…".
import { useEffect, useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { t } from '@shared/i18n'
import type { Question } from '@shared/protocol'
import { actions } from '@/host/actions'
import { canAct } from '@/host/controller'
import type { RequestItem } from '@/lib/turns'
import { useApp } from '@/store/app'
import { useDev } from '@/store/dev'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { AgentMark, useModelLabel } from '@/ui/AgentMark'
import { Button } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import { useOnce } from '@/lib/use-once'
import { SheetTitle } from '@/ui/NativeSheet'
import { Text } from '@/ui/Text'
import { TextInput as Input } from '@/ui/TextInput'
import { CodeBlock, EditPreview, subjectOf } from './parts'

const OTHER = '__other__'

/** La richiesta viva: dalla chat se c'è, altrimenti dal riepilogo della sessione. */
export function useRequest(sessionId: string | null, requestId: string | null): RequestItem | null {
  return useApp((s) => {
    if (!sessionId || !requestId) return null
    const fromItems = s.items[sessionId]?.find((i): i is RequestItem => i.kind === 'request' && i.requestId === requestId)
    if (fromItems) return fromItems
    const r = s.sessions[sessionId]?.request
    return r && r.requestId === requestId ? r : null
  })
}

/** Titolo dello sheet: la domanda o il titolo del permesso. */
const requestTitle = (request: RequestItem): string => (request.requestType === 'question' ? t('Question') : request.title)

/** Contenuto dello sheet della richiesta, uguale nello sheet nativo (iOS) e in quello nostro (Android, schermi larghi). */
export function RequestContent({ sessionId, requestId, onClose: onCloseRaw }: { sessionId: string; requestId: string; onClose: () => void }) {
  const request = useRequest(sessionId, requestId)
  const session = useApp((s) => s.sessions[sessionId])
  // Una sola chiusura, qualunque strada la chieda: la risposta (onDone) e la richiesta che si chiude dopo, quasi insieme.
  const onClose = useOnce(onCloseRaw)
  // Se la richiesta si chiude mentre lo sheet è aperto (risposta dal Mac o da qui), lo sheet si chiude.
  useEffect(() => {
    if (!request || request.state !== 'open') onClose()
  }, [request, onClose])
  if (!request || !session) return null
  return (
    <>
      <SheetTitle>{requestTitle(request)}</SheetTitle>
      <Body sessionId={sessionId} request={request} onDone={onClose} />
    </>
  )
}

function Body({ sessionId, request, onDone }: { sessionId: string; request: RequestItem; onDone: () => void }) {
  const { c } = useTheme()
  const session = useApp((s) => s.sessions[sessionId])
  const project = useApp((s) => s.projects.find((p) => p.id === session?.projectId)?.name)
  const model = useModelLabel(session.agent, session.model)
  const online = useApp((s) => canAct(s.conn))
  const [busy, setBusy] = useState(false)
  const subject = subjectOf(request)

  return (
    <View style={{ paddingHorizontal: 20, gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -6 }}>
        <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
          {project} / {session.title}
        </Text>
        <AgentMark agent={session.agent} size={13} />
        <Text variant="caption" tone="muted">
          {model}
        </Text>
      </View>
      {request.requestType === 'question' ? (
        <QuestionForm sessionId={sessionId} request={request} online={online} busy={busy} setBusy={setBusy} onDone={onDone} />
      ) : (
        <PermissionForm sessionId={sessionId} request={request} online={online} busy={busy} setBusy={setBusy} onDone={onDone} subject={subject} c={c} />
      )}
      {!online ? (
        <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
          {t('Reconnect to your Mac to respond.')}
        </Text>
      ) : null}
    </View>
  )
}

function PermissionForm({ sessionId, request, online, busy, setBusy, onDone, subject, c }: FormProps & { subject: ReturnType<typeof subjectOf>; c: ReturnType<typeof useTheme>['c'] }) {
  // Solo sviluppo: il driver apre subito il campo del motivo (prova della tastiera).
  const [reasonOpen, setReasonOpen] = useState(__DEV__ && useDev.getState().reasonField)
  const [reason, setReason] = useState('')
  const finish = async (fn: () => Promise<boolean>) => {
    setBusy(true)
    const ok = await fn()
    setBusy(false)
    if (ok) onDone()
  }
  return (
    <>
      {subject ? (
        <View style={{ gap: 6 }}>
          <Text variant="label" tone="muted">
            {subject.label === 'command' ? t('Command') : subject.label === 'files' ? t('Files') : t('File')}
          </Text>
          <CodeBlock text={subject.text} selectable />
        </View>
      ) : null}
      {request.reason ? (
        <View style={{ gap: 6 }}>
          <Text variant="label" tone="muted">
            {t('Reason')}
          </Text>
          <Text variant="body">{request.reason}</Text>
        </View>
      ) : null}
      {request.preview ? (
        <View style={{ gap: 6 }}>
          <Text variant="label" tone="muted">
            {t('Proposed change')}
          </Text>
          <EditPreview text={request.preview.text} />
          {request.preview.truncated ? (
            <Text variant="caption" tone="muted">
              {t('The preview is shortened.')}
            </Text>
          ) : null}
        </View>
      ) : null}
      {reasonOpen ? (
        <Input
          value={reason}
          onChangeText={setReason}
          placeholder={t('Tell the agent what to do instead')}
          placeholderTextColor={c.textMuted}
          multiline
          autoFocus
          style={{ minHeight: 48, borderRadius: RADIUS.lg, backgroundColor: c.background, color: c.text, paddingHorizontal: 12, paddingVertical: 8, fontFamily: 'MonaSans-Regular', fontSize: 15, textAlignVertical: 'top' }}
          accessibilityLabel={t('Reason for denying')}
        />
      ) : null}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Button label={t('Deny')} grow disabled={!online || busy} onPress={() => finish(() => actions.deny(sessionId, request, reason))} />
        <Button label={t('Approve')} variant="primary" grow disabled={!online || busy} onPress={() => finish(() => actions.approve(sessionId, request))} />
      </View>
      {!reasonOpen ? <Button label={t('Deny with a reason…')} variant="quiet" onPress={() => setReasonOpen(true)} /> : null}
    </>
  )
}

interface FormProps {
  sessionId: string
  request: RequestItem
  online: boolean
  busy: boolean
  setBusy: (b: boolean) => void
  onDone: () => void
}

function QuestionForm({ sessionId, request, online, busy, setBusy, onDone }: FormProps) {
  const { c } = useTheme()
  const questions = useMemo(() => request.questions ?? [], [request.questions])
  // Solo sviluppo: il driver sceglie subito "Altro…" nella prima domanda.
  const [picked, setPicked] = useState<Record<number, string[]>>(() => {
    const start: Record<number, string[]> = {}
    if (__DEV__ && useDev.getState().reasonField) start[0] = [OTHER]
    return start
  })
  const [other, setOther] = useState<Record<number, string>>({})
  const answerFor = (i: number): string | null => {
    const values = (picked[i] ?? []).map((v) => (v === OTHER ? (other[i] ?? '').trim() : v)).filter(Boolean)
    return values.length ? values.join(', ') : null
  }
  const valid = questions.length > 0 && questions.every((_, i) => answerFor(i) !== null)
  const toggle = (i: number, value: string, multi: boolean) =>
    setPicked((prev) => {
      const cur = prev[i] ?? []
      if (!multi) return { ...prev, [i]: [value] }
      return { ...prev, [i]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] }
    })
  const submit = async () => {
    const answers: Record<string, string> = {}
    questions.forEach((q, i) => (answers[q.question] = answerFor(i) ?? ''))
    setBusy(true)
    const ok = await actions.answer(sessionId, request, answers)
    setBusy(false)
    if (ok) onDone()
  }
  return (
    <>
      {questions.map((q, i) => (
        <QuestionBlock key={i} q={q} picked={picked[i] ?? []} other={other[i] ?? ''} onToggle={(v) => toggle(i, v, q.multiSelect)} onOther={(txt) => setOther((p) => ({ ...p, [i]: txt }))} c={c} />
      ))}
      <Button label={t('Send answer')} variant="primary" disabled={!online || busy || !valid} onPress={submit} />
    </>
  )
}

function QuestionBlock({ q, picked, other, onToggle, onOther, c }: { q: Question; picked: string[]; other: string; onToggle: (v: string) => void; onOther: (t: string) => void; c: ReturnType<typeof useTheme>['c'] }) {
  return (
    <View style={{ gap: 8 }}>
      {q.header ? (
        <Text variant="label" tone="muted">
          {q.header}
        </Text>
      ) : null}
      <Text variant="title">{q.question}</Text>
      {q.multiSelect ? (
        <Text variant="caption" tone="muted">
          {t('Choose any that apply')}
        </Text>
      ) : null}
      <View style={{ gap: 8 }}>
        {q.options.map((o) => (
          <Option key={o.label} label={o.label} description={o.description} on={picked.includes(o.label)} multi={q.multiSelect} onPress={() => onToggle(o.label)} />
        ))}
        <Option label={t('Other…')} description={null} on={picked.includes(OTHER)} multi={q.multiSelect} onPress={() => onToggle(OTHER)} />
        {picked.includes(OTHER) ? (
          <Input
            value={other}
            onChangeText={onOther}
            placeholder={t('Your answer')}
            placeholderTextColor={c.textMuted}
            autoFocus
            style={{ minHeight: 48, borderRadius: RADIUS.lg, backgroundColor: c.background, color: c.text, paddingHorizontal: 12, fontFamily: 'MonaSans-Regular', fontSize: 15 }}
            accessibilityLabel={t('Your answer')}
          />
        ) : null}
      </View>
    </View>
  )
}

function Option({ label, description, on, multi, onPress }: { label: string; description: string | null; on: boolean; multi: boolean; onPress: () => void }) {
  const { c } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: on }}
      style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS.lg, backgroundColor: c.background, borderWidth: 1.5, borderColor: on ? c.accent : c.border }}
    >
      <View style={{ width: 22, height: 22, borderRadius: multi ? 6 : 11, borderWidth: 1.5, borderColor: on ? c.accent : c.controlBorder, backgroundColor: on ? c.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
        {on ? <Icon name="check" size={14} color={c.onAccent} strokeWidth={2.5} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="body" style={{ fontFamily: 'MonaSans-Medium' }}>
          {label}
        </Text>
        {description ? (
          <Text variant="caption" tone="muted">
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}
