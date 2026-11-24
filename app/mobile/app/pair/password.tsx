import { useRouter } from 'expo-router'
import { TextInput } from 'react-native'
import { Redirect } from 'expo-router'
import { t } from '@shared/i18n'
import { PairStep } from '@/features/pair/PairStep'
import { usePairFlow } from '@/store/pair-flow'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Button } from '@/ui/Button'
import { Text } from '@/ui/Text'
import { authMessage } from '@/ui/auth-text'

/** Password del Mac per i telefoni nuovi (solo se il codice dice `pw`). La verifica la fa il Mac, al `pair`. */
export default function Password() {
  const { c } = useTheme()
  const router = useRouter()
  const { payload, confirmed, password, failure, set } = usePairFlow()
  // Senza conferma (per esempio da un link diretto) non si va oltre: si riparte dall'inizio.
  if (!payload || !confirmed) return <Redirect href="/" />
  const wrong = failure?.code === 'wrong-password' || failure?.code === 'password-required'
  return (
    <PairStep
      icon="lock"
      step={t('Step 3 of 4')}
      title={t('Password')}
      body={t('Your Mac asks for a password before it adds a new phone.')}
      actions={<Button label={t('Continue')} variant="primary" disabled={password.length === 0} onPress={() => router.replace('/pair/device')} />}
    >
      <TextInput
        value={password}
        onChangeText={(value) => set({ password: value, failure: null })}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        autoFocus
        placeholder={t('Password')}
        placeholderTextColor={c.textMuted}
        accessibilityLabel={t('Password')}
        onSubmitEditing={() => password && router.replace('/pair/device')}
        style={{ marginTop: 24, minHeight: 52, borderRadius: RADIUS.lg, backgroundColor: c.surface, color: c.text, paddingHorizontal: 16, fontSize: 17, borderWidth: wrong ? 1.5 : 0, borderColor: c.error }}
      />
      {wrong && failure?.code ? (
        <Text variant="body" tone="error" style={{ marginTop: 10 }} accessibilityLiveRegion="polite">
          {authMessage(failure.code, failure.hostError)}
        </Text>
      ) : null}
    </PairStep>
  )
}
