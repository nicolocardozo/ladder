import { Stack } from 'expo-router'
import { useEffect } from 'react'
import { usePairFlow } from '@/store/pair-flow'
import { useTheme } from '@/theme/theme'

/**
 * The pairing flow is its own stack. When it is left (back, cancel, abandoned error, end) the code and the password
 * are wiped from memory: an incomplete pairing leaves nothing behind, and a link is not reused.
 */
export default function PairLayout() {
  const { c } = useTheme()
  const reset = usePairFlow((s) => s.reset)
  useEffect(() => () => reset(), [reset])
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.background } }} />
}
