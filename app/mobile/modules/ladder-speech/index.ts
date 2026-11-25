// Dettatura sul telefono con SpeechAnalyzer (iOS 26): modulo nativo locale. Su iOS precedenti e su Android non c'è (`null`):
// lì si usa expo-speech-recognition (src/features/composer/useDictation.ts).
import { requireOptionalNativeModule } from 'expo'

/** `installed`: pronto. `supported`: si può scaricare. `downloading`: già in scarico. `unsupported`: la lingua non c'è. */
export type AssetStatus = 'installed' | 'supported' | 'downloading' | 'unsupported'

export type LadderSpeechEvents = {
  /** Trascrizione corrente: `isFinal` chiude la frase (le provvisorie arrivano mentre si parla). */
  result: (e: { text: string; isFinal: boolean }) => void
  /** Livello del microfono, 0..1. */
  level: (e: { level: number }) => void
  /** Avanzamento del download del modello, 0..1. */
  progress: (e: { fraction: number }) => void
  end: () => void
  error: (e: { message: string }) => void
}

export interface LadderSpeechModule {
  addListener<K extends keyof LadderSpeechEvents>(name: K, listener: LadderSpeechEvents[K]): { remove(): void }
  /** iOS 26 con il trascrittore disponibile su questo dispositivo. */
  isAvailable(): boolean
  /** Stato del modello della lingua e, se il sistema lo dice, i byte da scaricare. */
  assetStatus(locale: string): Promise<{ status: AssetStatus; bytes: number | null }>
  /** Scarica e installa il modello della lingua (eventi `progress`). Risolve a modello pronto. */
  install(locale: string): Promise<void>
  /** Permesso del microfono: `granted`, `denied` o `undetermined`. */
  micPermission(): Promise<'granted' | 'denied' | 'undetermined'>
  requestMic(): Promise<boolean>
  /** Inizia ad ascoltare: eventi `result`, `level`, `end`, `error`. */
  start(locale: string, contextualStrings: string[]): Promise<void>
  /** Ferma e conclude la frase in corso (arriva l'ultimo `result` finale, poi `end`). */
  stop(): Promise<void>
  /** Ferma subito, senza risultato finale. */
  abort(): void
}

export default requireOptionalNativeModule<LadderSpeechModule>('LadderSpeech')
