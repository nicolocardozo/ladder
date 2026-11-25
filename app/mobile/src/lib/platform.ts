import { Platform } from 'react-native'

export const IOS = Platform.OS === 'ios'
/** iOS 26 o più: barre, header e sheet sono di vetro (Liquid Glass) disegnato dal sistema. */
export const GLASS = IOS && parseInt(String(Platform.Version), 10) >= 26
