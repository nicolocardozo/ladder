// Abbinamento e chiave del dispositivo, nel portachiavi (expo-secure-store, solo su questo telefono e a telefono sbloccato).
// La chiave Ed25519 del dispositivo si crea una volta sola e la privata non esce mai: serve a firmare `pair` e `auth`.
import { ed25519 } from '@noble/curves/ed25519.js'
import * as SecureStore from 'expo-secure-store'
import * as Device from 'expo-device'
import { Platform } from 'react-native'
import { fromBase64Url, generateDeviceKey, toBase64Url, type DeviceKeyPair } from '@shared/remote/pairing'

/** Cosa serve per ritrovare il Mac e presentarsi: nessuna password, nessun codice monouso. */
export interface Pairing {
  /** Nome del Mac, noto dal QR e riconfermato a ogni hello. */
  macName: string
  /** Chiave pubblica X25519 del Mac, base64url: la chiave statica dell'handshake Noise. */
  macKey: string
  /** Relay e id del Mac su quel relay; con solo `ws` (sviluppo) si va direttamente al Mac. */
  relay?: string
  id?: string
  ws?: string
  /** Id del dispositivo, assegnato dal Mac all'abbinamento. */
  deviceId: string
  /** Nome con cui il Mac ci conosce. */
  deviceName: string
}

const PAIRING_KEY = 'ladder.pairing.v2'
const DEVICE_KEY = 'ladder.device-key.v1'
const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

export async function loadPairing(): Promise<Pairing | null> {
  try {
    const raw = await SecureStore.getItemAsync(PAIRING_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<Pairing>
    return typeof p.macKey === 'string' && typeof p.deviceId === 'string' && (p.ws || (p.relay && p.id)) ? (p as Pairing) : null
  } catch {
    return null
  }
}

export const savePairing = (pairing: Pairing) => SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(pairing), OPTIONS)
export const clearPairing = async () => {
  await SecureStore.deleteItemAsync(PAIRING_KEY)
  // Abbinamento provvisorio della prima versione (chiave grezza): non serve più.
  await SecureStore.deleteItemAsync('ladder.pairing.v1').catch(() => {})
}

/** La chiave del dispositivo; se non c'è la si crea (solo con `create`). */
export async function loadDeviceKey(create: boolean): Promise<DeviceKeyPair | null> {
  const existing = await SecureStore.getItemAsync(DEVICE_KEY)
  if (existing) {
    const secretKey = fromBase64Url(existing)
    return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
  }
  if (!create) return null
  const fresh = generateDeviceKey()
  await SecureStore.setItemAsync(DEVICE_KEY, toBase64Url(fresh.secretKey), OPTIONS)
  return fresh
}

export const clearDeviceKey = () => SecureStore.deleteItemAsync(DEVICE_KEY)

/** Nome del telefono proposto all'abbinamento ("Zoë's iPhone"); senza nome di sistema, il modello o la piattaforma. */
export function defaultDeviceName(): string {
  return Device.deviceName || Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Android phone')
}

export const devicePlatform = (): 'ios' | 'android' => (Platform.OS === 'ios' ? 'ios' : 'android')
