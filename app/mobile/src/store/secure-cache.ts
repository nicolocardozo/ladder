// Copia locale cifrata per leggere le chat senza connessione. Le chat sono dati sensibili (codice, comandi): in AsyncStorage
// finirebbero in chiaro, e nei backup. Qui il testo è cifrato con ChaCha20-Poly1305 (@noble/ciphers, lo stesso del canale)
// e la chiave sta nel portachiavi, solo su questo dispositivo e solo a telefono sbloccato.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import * as SecureStore from 'expo-secure-store'

const KEY_ID = 'ladder.cache-key.v1'
const CACHE_KEY = 'ladder-cache-v2'
const NONCE_LEN = 12

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  // A blocchi: String.fromCharCode con troppi argomenti sfora lo stack.
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function key(create: boolean): Promise<Uint8Array | null> {
  const existing = await SecureStore.getItemAsync(KEY_ID)
  if (existing) return fromBase64(existing)
  if (!create) return null
  const fresh = crypto.getRandomValues(new Uint8Array(32))
  await SecureStore.setItemAsync(KEY_ID, toBase64(fresh), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY })
  return fresh
}

export async function writeSecureCache(data: unknown): Promise<void> {
  const k = await key(true)
  if (!k) return
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN))
  const sealed = chacha20poly1305(k, nonce).encrypt(encoder.encode(JSON.stringify(data)))
  const out = new Uint8Array(NONCE_LEN + sealed.length)
  out.set(nonce)
  out.set(sealed, NONCE_LEN)
  await AsyncStorage.setItem(CACHE_KEY, toBase64(out))
}

export async function readSecureCache<T>(): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY)
    const k = await key(false)
    if (!raw || !k) return null
    const bytes = fromBase64(raw)
    const plain = chacha20poly1305(k, bytes.subarray(0, NONCE_LEN)).decrypt(bytes.subarray(NONCE_LEN))
    return JSON.parse(decoder.decode(plain)) as T
  } catch {
    // Chiave persa, dato corrotto o cache vecchia: si riparte da zero.
    return null
  }
}

/** Cancella la copia e la chiave (scollegamento, "Forget this Mac"). */
export async function clearSecureCache(): Promise<void> {
  await AsyncStorage.removeItem(CACHE_KEY).catch(() => {})
  await AsyncStorage.removeItem('ladder-cache-v1').catch(() => {})
  await SecureStore.deleteItemAsync(KEY_ID).catch(() => {})
}
