// Switch session without going back to Home: "Now" at the top, below it the other sessions of the same project.
import { useRouter } from 'expo-router'
import { useMemo } from 'react'
import { View } from 'react-native'
import { t } from '@shared/i18n'
import { byUrgency, isLive, sessionState } from '@/lib/session-state'
import { SessionRow } from '@/features/sessions/SessionRow'
import { useApp } from '@/store/app'
import { useOnce } from '@/lib/use-once'
import { SheetTitle } from '@/ui/NativeSheet'
import { Text } from '@/ui/Text'

/** Content of the "switch session" sheet, the same in the native sheet (iOS) and in our own. */
export function SwitchContent({ sessionId, onClose: onCloseRaw }: { sessionId: string; onClose: () => void }) {
  const onClose = useOnce(onCloseRaw)
  const router = useRouter()
  const sessionsMap = useApp((s) => s.sessions)
  const projects = useApp((s) => s.projects)
  const current = sessionsMap[sessionId]
  const { now, others } = useMemo(() => {
    const all = Object.values(sessionsMap).filter((s) => !s.archived && s.id !== sessionId)
    const live = all.filter((s) => isLive(sessionState(s))).sort(byUrgency)
    const liveIds = new Set(live.map((s) => s.id))
    const rest = all.filter((s) => current && s.projectId === current.projectId && !liveIds.has(s.id)).sort((a, b) => b.activityAt - a.activityAt)
    return { now: live, others: rest }
  }, [sessionsMap, sessionId, current])
  const projectName = projects.find((p) => p.id === current?.projectId)?.name ?? ''
  const go = (id: string) => {
    onClose()
    router.replace({ pathname: '/session/[id]', params: { id } })
  }
  return (
    <>
      <SheetTitle>{t('Sessions')}</SheetTitle>
      <View style={{ paddingHorizontal: 8 }}>
        {now.length > 0 ? (
          <>
            <Text variant="label" tone="muted" style={{ paddingHorizontal: 12, paddingVertical: 6 }}>
              {t('Now')}
            </Text>
            {now.map((s) => (
              <SessionRow key={s.id} session={s} showProject onPress={() => go(s.id)} />
            ))}
          </>
        ) : null}
        {others.length > 0 ? (
          <>
            <Text variant="label" tone="muted" style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6 }}>
              {projectName}
            </Text>
            {others.map((s) => (
              <SessionRow key={s.id} session={s} onPress={() => go(s.id)} />
            ))}
          </>
        ) : null}
        {now.length === 0 && others.length === 0 ? (
          <Text variant="body" tone="muted" style={{ padding: 16 }}>
            {t('No other sessions.')}
          </Text>
        ) : null}
      </View>
    </>
  )
}
