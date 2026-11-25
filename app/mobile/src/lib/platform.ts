import { Platform } from 'react-native'

export const IOS = Platform.OS === 'ios'
/** iOS 26 or later: bars, headers and sheets are glass (Liquid Glass) drawn by the system. */
export const GLASS = IOS && parseInt(String(Platform.Version), 10) >= 26
