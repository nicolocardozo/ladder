// Stato in memoria dell'abbinamento in corso (QR → conferma → password → nome del dispositivo). Il codice monouso e la
// password vivono solo qui e nella connessione: non finiscono mai nei log, nel portachiavi né nella cache.
import { create } from 'zustand'
import type { RemoteAuthErrorCode, RemotePairingPayload } from '@shared/protocol'

export interface PairFailure {
  code?: RemoteAuthErrorCode
  /** Categoria quando non c'è un codice dell'host. */
  kind?: 'key-changed' | 'unreachable' | 'mac-offline' | 'storage'
  reason?: string
  hostError?: string
}

interface PairFlow {
  payload: RemotePairingPayload | null
  password: string
  /** L'utente ha premuto "Pair" nella conferma: senza, password e nome del dispositivo non si aprono (un deep link non salta la conferma). */
  confirmed: boolean
  deviceName: string
  /** Ultimo errore, da mostrare nel passo giusto. */
  failure: PairFailure | null
  /** Solo sviluppo: il passo "nome del dispositivo" si collega da solo (lo imposta dev-driver). */
  autoConnect: boolean
  set: (patch: Partial<Omit<PairFlow, 'set' | 'reset'>>) => void
  reset: () => void
}

const empty = { payload: null, password: '', confirmed: false, deviceName: '', failure: null, autoConnect: false }

export const usePairFlow = create<PairFlow>((set) => ({ ...empty, set: (patch) => set(patch), reset: () => set(empty) }))
