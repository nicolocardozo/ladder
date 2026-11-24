// Card ambra della lista "In attesa": titolo della richiesta, progetto e sessione, agente e modello, comando in mono (3 righe),
// Deny e Approve. Domande e modifiche con anteprima si decidono nello sheet.
import { View } from 'react-native'
import { t } from '@shared/i18n'
import type { SessionSummary } from '@shared/protocol'
import { actions } from '@/host/actions'
import { canAct } from '@/host/controller'
import { relativeAge } from '@/lib/format'
import { useApp } from '@/store/app'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { AgentMark, useModelLabel } from '@/ui/AgentMark'
import { Button } from '@/ui/Button'
import { StateGlyph } from '@/ui/StateGlyph'
import { Text } from '@/ui/Text'
import { Pressable } from 'react-native'
import { CodeBlock, needsSheet, subjectOf } from './parts'

export function RequestCard({ session, onReview, onOpenSession }: { session: SessionSummary; onReview: (sessionId: string, requestId: string) => void; onOpenSession: () => void }) {
  const { c } = useTheme()
  const request = session.request
  const project = useApp((s) => s.projects.find((p) => p.id === session.projectId)?.name)
  const model = useModelLabel(session.agent, session.model)
  const online = useApp((s) => canAct(s.conn))
  if (!request) return null
  const subject = subjectOf(request)
  const sheet = needsSheet(request)
  const extra = session.openRequests - 1
  return (
    <View style={{ borderRadius: RADIUS.lg, backgroundColor: alpha(c.waiting, 0.1), borderWidth: 1, borderColor: alpha(c.waiting, 0.45), padding: 16, gap: 12 }}>
      <Pressable onPress={onOpenSession} accessibilityRole="button" accessibilityLabel={`${project} / ${session.title}`} style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <StateGlyph state="waiting" size={16} />
          <Text variant="title" style={{ flex: 1 }} numberOfLines={2}>
            {request.requestType === 'question' ? (request.questions?.[0]?.header ?? t('Question')) + ': ' + (request.questions?.[0]?.question ?? '') : request.title}
          </Text>
          <Text variant="caption" tone="waiting">
            {relativeAge(session.waitingSince ?? request.at)}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
            {project} / {session.title}
          </Text>
          <AgentMark agent={session.agent} size={13} />
          <Text variant="caption" tone="muted">
            {model}
          </Text>
        </View>
      </Pressable>
      {subject ? <CodeBlock text={subject.text} lines={3} /> : null}
      {extra > 0 ? (
        <Text variant="caption" tone="muted">
          {t('+{n} more in this session', { n: extra })}
        </Text>
      ) : null}
      {sheet ? (
        <Button label={t('Review')} variant="primary" onPress={() => onReview(session.id, request.requestId)} />
      ) : (
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Button label={t('Deny')} grow disabled={!online} onPress={() => void actions.deny(session.id, request)} />
          <Button label={t('Approve')} variant="primary" grow disabled={!online} onPress={() => void actions.approve(session.id, request)} />
        </View>
      )}
    </View>
  )
}
