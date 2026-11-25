// Chat header (iOS): follow the session on the lock screen and in the Dynamic Island. One tap turns it on or off
// for this session, regardless of auto-start; the state is read from the icon (color and label), not from color alone.
import * as Haptics from 'expo-haptics'
import { Pressable } from 'react-native'
import { t } from '@shared/i18n'
import { liveActivitySupported } from '@/host/live-activity'
import { follows } from '@/lib/live-activity'
import { IOS } from '@/lib/platform'
import { usePrefs } from '@/store/prefs'
import { useTheme } from '@/theme/theme'
import { Icon } from '@/ui/Icon'
import { useToast } from '@/ui/toast'
import { useLive } from '@/store/live'

/** The button, or null where Live Activities do not exist (Android, builds without the extension). */
export function FollowButton({ sessionId }: { sessionId: string }) {
  const { c } = useTheme()
  const live = usePrefs((s) => s.live)
  const opened = useLive((s) => !!s.opened[sessionId])
  if (!IOS || !liveActivitySupported()) return null
  const on = follows(live, sessionId, opened)
  const toggle = () => {
    const prefs = usePrefs.getState()
    // Turning it on while the global switch is off turns the switch on: the intent is clear.
    if (!on) prefs.setLive({ enabled: true })
    prefs.setSessionFollow(sessionId, on ? 'off' : 'on')
    void Haptics.selectionAsync()
    useToast.getState().show(on ? t('Stopped following on the Lock Screen.') : t('Following on the Lock Screen while it works.'))
  }
  return (
    <Pressable onPress={toggle} accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={t('Follow on Lock Screen')} hitSlop={6} style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="live" size={20} color={on ? c.accent : c.textMuted} />
    </Pressable>
  )
}
