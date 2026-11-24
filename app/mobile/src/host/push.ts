// Seam per le notifiche push (LAD-53): il token Expo del dispositivo va al Mac con `device.push.set`, che lo tiene sulla riga del
// dispositivo (mai nel log). Non è ancora collegato: LAD-53 chiamerà `sendPushToken` dopo il permesso delle notifiche e a ogni
// cambio del token, e con `null` quando l'utente le spegne.
import type { RemotePlatform } from '@shared/protocol'
import { request } from './controller'

export function sendPushToken(token: string | null, platform: RemotePlatform): Promise<unknown> {
  return request({ type: 'device.push.set', token, platform })
}
