// Abbinamento salvato nel portachiavi (expo-secure-store). Per ora solo quello manuale di sviluppo (LAD-51 porterà QR,
// password e relay: `Pairing` crescerà con `relay` e `macId`, la forma resta questa).
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'

export interface Pairing {
  /** Indirizzo WebSocket del server locale dell'host (solo sviluppo). Con il relay: assente. */
  wsUrl: string
  /** Chiave pubblica Noise del Mac, base64url (da remote-identity.json). */
  macKey: string
  /** Nome del dispositivo, mostrato sul Mac. */
  device: string
  /** Nome del Mac, noto dopo la prima connessione: per il pill anche offline. */
  macName?: string
}

const KEY = 'ladder.pairing.v1'

export async function loadPairing(): Promise<Pairing | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY)
    return raw ? (JSON.parse(raw) as Pairing) : null
  } catch {
    return null
  }
}

export const savePairing = (pairing: Pairing) => SecureStore.setItemAsync(KEY, JSON.stringify(pairing))
export const clearPairing = () => SecureStore.deleteItemAsync(KEY)

export const defaultDeviceName = () => (Platform.OS === 'ios' ? 'iPhone' : 'Android phone')

