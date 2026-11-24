import { Redirect, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { TextInput, View } from 'react-native'
import { t } from '@shared/i18n'
import { PairStep } from '@/features/pair/PairStep'
import { startPairing, type PairOutcome } from '@/host/controller'
import { authNext } from '@/lib/auth-errors'
import { reasonKind } from '@/lib/connection'
import { usePairFlow, type PairFailure } from '@/store/pair-flow'
import { defaultDeviceName } from '@/store/pairing'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Button } from '@/ui/Button'
import { Text } from '@/ui/Text'
import { authMessage } from '@/ui/auth-text'

function failureText(f: PairFailure): string {
  if (f.code) return authMessage(f.code, f.hostError)
  if (f.kind === 'storage') return t('Ladder could not save the pairing on this phone. Try again.')
  if (f.kind === 'key-changed') return t('This code does not match your Mac. Ask your Mac for a new code.')
  if (f.kind === 'mac-offline') return t('Your Mac is not reachable right now. Make sure it is awake and Ladder is open, then try again.')
  return reasonKind(f.reason) === 'timeout' ? t('Your Mac did not answer. Make sure it is awake and Ladder is open, then try again.') : t('Could not reach your Mac. Check that Ladder is open on it, then try again.')
}

/** Nome del dispositivo, poi `pair`. Gli errori restano qui, con l'azione giusta (codice nuovo, password, riprova). */
export default function Device() {
  const { c } = useTheme()
  const router = useRouter()
  const { payload, confirmed, password, deviceName, failure, autoConnect, set, reset } = usePairFlow()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!deviceName) set({ deviceName: defaultDeviceName() })
  }, [deviceName, set])
  // Solo sviluppo: il driver di prova preme "Connect" al posto nostro (una volta).
  const auto = useRef(false)
  useEffect(() => {
    if (__DEV__ && autoConnect && payload && confirmed && deviceName && !auto.current) {
      auto.current = true
      void connect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect, payload, deviceName])
  // Senza conferma (per esempio da un link diretto) non si va oltre: si riparte dall'inizio.
  if (!payload || !confirmed) return <Redirect href="/" />

  const needsNewCode = !!failure && ((failure.code && authNext(failure.code) === 'new-code') || failure.kind === 'key-changed')

  const connect = async () => {
    setBusy(true)
    set({ failure: null })
    let outcome: PairOutcome
    try {
      outcome = await startPairing(payload, { password: payload.pw ? password : undefined, deviceName: deviceName.trim() || defaultDeviceName() })
    } finally {
      setBusy(false)
    }
    if (outcome.ok) {
      router.replace('/pair/notifications')
      return
    }
    const next: PairFailure = outcome.kind === 'denied' ? { code: outcome.code, hostError: outcome.error } : { kind: outcome.kind, ...('reason' in outcome ? { reason: outcome.reason } : {}) }
    set({ failure: next })
    if (next.code && authNext(next.code) === 'password') router.replace('/pair/password')
  }

  return (
    <PairStep
      icon="laptop"
      step={t('Step 4 of 4')}
      title={t('Name this phone')}
      body={t('Your Mac shows this name in its list of paired devices, so you can recognise the phone and remove it later.')}
      actions={
        needsNewCode ? (
          <Button label={t('Scan a new code')} variant="primary" onPress={() => {
              reset()
              router.replace('/pair/camera')
            }} />
        ) : (
          <Button label={busy ? t('Connecting…') : failure ? t('Try again') : t('Connect')} variant="primary" disabled={busy || !deviceName.trim()} onPress={connect} />
        )
      }
    >
      <TextInput
        value={deviceName}
        onChangeText={(value) => set({ deviceName: value })}
        autoCorrect={false}
        editable={!busy}
        placeholder={t('Device name')}
        placeholderTextColor={c.textMuted}
        accessibilityLabel={t('Device name')}
        style={{ marginTop: 24, minHeight: 52, borderRadius: RADIUS.lg, backgroundColor: c.surface, color: c.text, paddingHorizontal: 16, fontSize: 17 }}
      />
      {failure ? (
        <View style={{ marginTop: 16 }}>
          <Text variant="body" tone="error" accessibilityLiveRegion="polite">
            {failureText(failure)}
          </Text>
        </View>
      ) : null}
    </PairStep>
  )
}
