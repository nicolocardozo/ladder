// Header della chat (iOS): segui la sessione sulla schermata di blocco e nella Dynamic Island (LAD-93). Un tocco la accende o la spegne
// per questa sessione, a prescindere dall'avvio automatico; lo stato si legge dall'icona (colore e etichetta), non solo dal colore.
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

/** Il pulsante, o null dove le Live Activity non esistono (Android, build senza estensione). */
export function FollowButton({ sessionId }: { sessionId: string }) {
  const { c } = useTheme()
  const live = usePrefs((s) => s.live)
  const opened = useLive((s) => !!s.opened[sessionId])
  if (!IOS || !liveActivitySupported()) return null
  const on = follows(live, sessionId, opened)
  const toggle = () => {
    const prefs = usePrefs.getState()
    // Accenderla con l'interruttore generale spento lo accende: l'intenzione è chiara.
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
