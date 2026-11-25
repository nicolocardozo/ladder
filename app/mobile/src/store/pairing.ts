// Pairing and device key, in the keychain (expo-secure-store, only on this phone and while unlocked).
// The device's Ed25519 key is created once and the private half never leaves: it signs `pair` and `auth`.
import { ed25519 } from '@noble/curves/ed25519.js'
import * as SecureStore from 'expo-secure-store'
import * as Device from 'expo-device'
import { Platform } from 'react-native'
import { fromBase64Url, generateDeviceKey, toBase64Url, type DeviceKeyPair } from '@shared/remote/pairing'

/** What is needed to find the Mac and introduce oneself: no password, no one-time code. */
export interface Pairing {
  /** The Mac's name, known from the QR and reconfirmed on every hello. */
  macName: string
  /** The Mac's X25519 public key, base64url: the static key of the Noise handshake. */
  macKey: string
  /** Relay and the Mac's id on that relay; with only `ws` (development) it connects directly to the Mac. */
  relay?: string
  id?: string
  ws?: string
  /** Device id, assigned by the Mac at pairing. */
  deviceId: string
  /** Name the Mac knows us by. */
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
  // Provisional pairing from the first version (raw key): no longer needed.
  await SecureStore.deleteItemAsync('ladder.pairing.v1').catch(() => {})
}

/** The device key; if missing it is created (only with `create`). */
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

/** Phone name proposed at pairing ("Alex's iPhone"); without a system name, the model or the platform. */
export function defaultDeviceName(): string {
  return Device.deviceName || Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Android phone')
}

export const devicePlatform = (): 'ios' | 'android' => (Platform.OS === 'ios' ? 'ios' : 'android')
