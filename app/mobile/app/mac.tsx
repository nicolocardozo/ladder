// Mac e connessione: stato, da quanto, motivo, riprova. Il pill è pronto a diventare un selettore di Mac (v1: uno solo).
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '@shared/i18n'
import { disconnect, retryNow } from '@/host/controller'
import { duration } from '@/lib/format'
import { resetTo } from '@/lib/nav'
import { useApp } from '@/store/app'
import { useTheme } from '@/theme/theme'
import { Button } from '@/ui/Button'
import { useConnectionText } from '@/ui/ConnectionPill'
import { Group, Row } from '@/ui/List'
import { ScreenHeader } from '@/ui/ScreenHeader'

/** Da quanto un Mac è offline prima di offrire "Pair again". */
const LONG_OFFLINE_MS = 10 * 60_000

export default function Mac() {
  const { c } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { title, detail, tone } = useConnectionText()
  const conn = useApp((s) => s.conn)
  const mode = useApp((s) => s.mode)
  const macName = useApp((s) => s.macName)
  // Un Mac offline da molto può aver cambiato chiave (o essere stato reinstallato) senza poterlo dire: si offre di abbinare di nuovo.
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  const longOffline = conn.kind === 'mac-offline' && Date.now() - conn.at > LONG_OFFLINE_MS
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title={t('Your Mac')} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        <Group>
          <Row label={t('Name')} value={macName ?? t('Unknown')} />
          <Row label={t('Status')} value={tone === 'ok' ? t('Connected') : title} />
          {detail && tone !== 'ok' ? <Row label={t('Details')} value={detail} /> : null}
          {conn.kind === 'connected' && mode === 'remote' ? <Row label={t('Connected for')} value={duration(Date.now() - conn.since)} /> : null}
          <Row label={t('Connection')} value={mode === 'demo' ? t('Demo (on this phone)') : t('Encrypted channel')} last />
        </Group>
        {mode === 'remote' && conn.kind !== 'connected' ? (
          <View style={{ padding: 16 }}>
            <Button label={t('Try again')} variant="primary" onPress={retryNow} />
          </View>
        ) : null}
        {longOffline ? (
          <Group footer={t('Your Mac has been offline for a while. If you reinstalled Ladder or reset its key, pair again. Nothing changes until you confirm.')}>
            <Row label={t('Pair again')} onPress={() => router.push('/pair/camera')} last />
          </Group>
        ) : null}
        <Group footer={mode === 'demo' ? t('Exit demo returns to the welcome screen.') : undefined}>
          <Row
            label={mode === 'demo' ? t('Exit demo') : t('Forget this Mac')}
            destructive
            last
            onPress={() => {
              void disconnect().then(() => resetTo(router, '/welcome'))
            }}
          />
        </Group>
      </ScrollView>
    </View>
  )
}
