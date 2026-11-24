// Permesso della sessione: Plan, Ask, Edit, Full. I livelli sopra il massimo del progetto sono spenti, con il motivo;
// Full chiede conferma e avvisa che le richieste aperte si approvano da sole; con Codex il cambio può valere dal prossimo turno.
import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'
import { plural, t } from '@shared/i18n'
import type { PermissionLevel } from '@shared/protocol'
import { actions } from '@/host/actions'
import { canAct } from '@/host/controller'
import { allowedLevel, PERMISSION_LEVELS } from '@/lib/permission'
import { useApp } from '@/store/app'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Button } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { useToast } from '@/ui/toast'

export const levelName = (level: PermissionLevel): string => ({ plan: t('Plan'), ask: t('Ask'), edit: t('Edit'), full: t('Full') })[level]

const levelHelp = (level: PermissionLevel): string =>
  ({
    plan: t('Reads and plans. Changes nothing.'),
    ask: t('Asks before editing files or running commands.'),
    edit: t('Edits files freely. Asks before running commands.'),
    full: t('Runs everything without asking.')
  })[level]

export function PermissionSheet({ sessionId, visible, onClose }: { sessionId: string; visible: boolean; onClose: () => void }) {
  const { c } = useTheme()
  const session = useApp((s) => s.sessions[sessionId])
  const max = useApp((s) => (session ? s.permissionsMax[session.projectId] : undefined)) ?? null
  const allowFull = useApp((s) => s.prefs.allowFull)
  const online = useApp((s) => canAct(s.conn))
  const [confirmFull, setConfirmFull] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!visible) setConfirmFull(false)
  }, [visible])
  if (!session) return null
  const working = session.run === 'running' || session.run === 'starting' || session.run === 'waiting'
  const nextTurnOnly = session.agent === 'codex' && working

  const apply = async (level: PermissionLevel) => {
    setBusy(true)
    const result = await actions.setPermission(sessionId, level)
    setBusy(false)
    if (!result) return
    if (result.appliesFrom === 'next-turn') useToast.getState().show(t('{level} applies from the next turn.', { level: levelName(result.permission) }))
    onClose()
  }
  const pick = (level: PermissionLevel) => {
    if (level === 'full') setConfirmFull(true)
    else void apply(level)
  }

  if (confirmFull) {
    const open = session.openRequests
    return (
      <Sheet visible={visible} onClose={onClose} title={t('Switch to Full?')}>
        <View style={{ paddingHorizontal: 20, gap: 16 }}>
          <Text variant="body">{t('The agent will run commands and edit files without asking you first.')}</Text>
          {open > 0 ? (
            <View style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: RADIUS.lg, backgroundColor: alpha(c.waiting, 0.14), borderWidth: 1, borderColor: alpha(c.waiting, 0.5) }}>
              <Text variant="body" tone="waiting" style={{ flex: 1 }}>
                {plural(open, '1 open request will be approved automatically.', '{n} open requests will be approved automatically.')}
              </Text>
            </View>
          ) : null}
          {nextTurnOnly ? (
            <Text variant="caption" tone="muted">
              {t('Codex applies the change from the next turn.')}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <Button label={t('Cancel')} grow onPress={() => setConfirmFull(false)} />
            <Button label={t('Switch to Full')} variant="primary" grow disabled={busy || !online} onPress={() => void apply('full')} />
          </View>
        </View>
      </Sheet>
    )
  }

  return (
    <Sheet visible={visible} onClose={onClose} title={t('Permission')}>
      <View style={{ paddingHorizontal: 16, gap: 8 }}>
        {PERMISSION_LEVELS.map((level) => {
          const aboveMax = !allowedLevel(level, max)
          // Full può essere spento dal Mac ("Allow Full access from phone"), a prescindere dal tetto del progetto.
          const fullOff = level === 'full' && !allowFull
          const allowed = !aboveMax && !fullOff
          const current = session.permission === level
          const pending = session.permissionNext === level
          return (
            <Pressable
              key={level}
              disabled={!allowed || !online || busy || current}
              onPress={() => pick(level)}
              accessibilityRole="radio"
              accessibilityState={{ checked: current, disabled: !allowed || !online }}
              style={({ pressed }) => ({ minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS.lg, backgroundColor: pressed ? c.selection : c.background, borderWidth: 1.5, borderColor: current ? c.accent : c.border, opacity: allowed && online ? 1 : 0.5 })}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="title">{levelName(level)}</Text>
                <Text variant="caption" tone="muted">
                  {aboveMax ? t('Above this project’s maximum ({max}).', { max: levelName(max!) }) : fullOff ? t('Turned off on your Mac.') : levelHelp(level)}
                </Text>
                {pending ? (
                  <Text variant="caption" tone="accent">
                    {t('From the next turn')}
                  </Text>
                ) : null}
              </View>
              {current ? <Icon name="check" size={20} color={c.accent} strokeWidth={2.4} /> : level === 'full' && allowed ? <Icon name="shield" size={18} color={c.textMuted} /> : null}
            </Pressable>
          )
        })}
        {nextTurnOnly ? (
          <Text variant="caption" tone="muted" style={{ paddingHorizontal: 4 }}>
            {t('While Codex is working, a change applies from the next turn.')}
          </Text>
        ) : null}
        {!online ? (
          <Text variant="caption" tone="muted" style={{ paddingHorizontal: 4 }}>
            {t('Reconnect to your Mac to change this.')}
          </Text>
        ) : null}
      </View>
    </Sheet>
  )
}
