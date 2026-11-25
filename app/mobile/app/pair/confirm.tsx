import { Redirect, useRouter } from 'expo-router'
import { View } from 'react-native'
import { t } from '@shared/i18n'
import { PairStep } from '@/features/pair/PairStep'
import { payloadFingerprint, routeOf } from '@/lib/pair-link'
import { useApp } from '@/store/app'
import { usePairFlow } from '@/store/pair-flow'
import { Button } from '@/ui/Button'
import { Group, Row } from '@/ui/List'
import { Text } from '@/ui/Text'

/** Confirmation before connecting: Mac name, key fingerprint (the same one the Mac shows) and relay. */
export default function Confirm() {
  const router = useRouter()
  const payload = usePairFlow((s) => s.payload)
  const reset = usePairFlow((s) => s.reset)
  const set = usePairFlow((s) => s.set)
  const pairedTo = useApp((s) => (s.mode === 'remote' ? s.macName : null))
  if (!payload) return <Redirect href="/pair/camera" />
  const route = routeOf(payload)
  return (
    <PairStep
      icon="laptop"
      step={t('Pair with this Mac?')}
      title={payload.mac}
      body={t('Check that the fingerprint matches the one shown on your Mac.')}
      actions={
        <>
          <Button
            label={t('Pair')}
            variant="primary"
            onPress={() => {
              // Only from here do the password and device name become reachable.
              set({ confirmed: true })
              router.push(payload.pw ? '/pair/password' : '/pair/device')
            }}
          />
          <Button
            label={t('Cancel')}
            variant="quiet"
            onPress={() => {
              reset()
              router.back()
            }}
          />
        </>
      }
    >
      <View style={{ marginTop: 20, marginHorizontal: -16 }}>
        <Group>
          <Row label={t('Mac')} value={payload.mac} />
          <Row label={t('Key fingerprint')} value={payloadFingerprint(payload)} />
          <Row label={route.kind === 'relay' ? t('Relay') : t('Connection')} value={route.kind === 'relay' ? route.host : t('Direct (development)')} last />
        </Group>
      </View>
      {pairedTo ? (
        <Text variant="caption" tone="muted" style={{ marginTop: 12 }}>
          {t('This phone is paired with {mac}. Pairing again replaces it.', { mac: pairedTo })}
        </Text>
      ) : null}
    </PairStep>
  )
}
