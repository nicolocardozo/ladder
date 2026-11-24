import { useRouter } from 'expo-router'
import { TextInput } from 'react-native'
import { t } from '@shared/i18n'
import { PairStep } from '@/features/pair/PairStep'
import { usePairFlow } from '@/store/pair-flow'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { Button } from '@/ui/Button'

/** Password, se il Mac ne ha una (la verifica arriva con LAD-51). */
export default function Password() {
  const { c } = useTheme()
  const router = useRouter()
  const { draft, set } = usePairFlow()
  return (
    <PairStep
      icon="lock"
      step={t('Step 3 of 4')}
      title={t('Password')}
      body={t('If you set a password on your Mac for new phones, enter it here. Otherwise, continue.')}
      actions={<Button label={t('Continue')} variant="primary" onPress={() => router.push('/pair/device')} />}
    >
      <TextInput
        value={draft.password}
        onChangeText={(password) => set({ password })}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={t('Password (optional)')}
        placeholderTextColor={c.textMuted}
        accessibilityLabel={t('Password')}
        style={{ marginTop: 24, minHeight: 52, borderRadius: RADIUS.lg, backgroundColor: c.surface, color: c.text, paddingHorizontal: 16, fontSize: 17 }}
      />
    </PairStep>
  )
}
