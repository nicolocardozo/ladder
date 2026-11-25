// In-memory state of the pairing in progress (QR → confirm → password → device name). The one-time code and the
// password live only here and in the connection: they never end up in logs, the keychain or the cache.
import { create } from 'zustand'
import type { RemoteAuthErrorCode, RemotePairingPayload } from '@shared/protocol'

export interface PairFailure {
  code?: RemoteAuthErrorCode
  /** Category when the host sent no code. */
  kind?: 'key-changed' | 'unreachable' | 'mac-offline' | 'storage'
  reason?: string
  hostError?: string
}

interface PairFlow {
  payload: RemotePairingPayload | null
  password: string
  /** The user pressed "Pair" in the confirmation: without it, password and device name stay closed (a deep link does not skip the confirmation). */
  confirmed: boolean
  deviceName: string
  /** Last error, to show in the right step. */
  failure: PairFailure | null
  /** Development only: the "device name" step connects on its own (set by dev-driver). */
  autoConnect: boolean
  set: (patch: Partial<Omit<PairFlow, 'set' | 'reset'>>) => void
  reset: () => void
}

const empty = { payload: null, password: '', confirmed: false, deviceName: '', failure: null, autoConnect: false }

export const usePairFlow = create<PairFlow>((set) => ({ ...empty, set: (patch) => set(patch), reset: () => set(empty) }))
