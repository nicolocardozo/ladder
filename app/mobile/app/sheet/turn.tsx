import { useEffect } from 'react'
import { useSheets } from '@/lib/sheets'
import { TurnContent } from '@/features/session/TurnSheet'
import { NativeSheet } from '@/ui/NativeSheet'

export default function TurnRoute() {
  const turn = useSheets((s) => s.turn)
  // Il turno non resta in memoria quando lo sheet si chiude.
  useEffect(() => () => useSheets.setState({ turn: null }), [])
  return <NativeSheet>{turn ? <TurnContent turn={turn} /> : null}</NativeSheet>
}
