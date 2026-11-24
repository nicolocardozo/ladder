import { Stack } from 'expo-router'
import { useEffect } from 'react'
import { usePairFlow } from '@/store/pair-flow'
import { useTheme } from '@/theme/theme'

/**
 * Il flusso di abbinamento è una pila sua. Quando si esce (indietro, annulla, errore abbandonato, fine) il codice e la password
 * si cancellano dalla memoria: un abbinamento non completato non lascia nulla, e un link non si riusa.
 */
export default function PairLayout() {
  const { c } = useTheme()
  const reset = usePairFlow((s) => s.reset)
  useEffect(() => () => reset(), [reset])
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.background } }} />
}
