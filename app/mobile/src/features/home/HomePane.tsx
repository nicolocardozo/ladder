import { View } from 'react-native'
import { HomeContent } from './HomeContent'

/** Home fissa a sinistra su schermi da 600 pt in su (tablet, pieghevoli). */
export function HomePane({ width }: { width: number }) {
  return (
    <View style={{ width }}>
      <HomeContent docked />
    </View>
  )
}
