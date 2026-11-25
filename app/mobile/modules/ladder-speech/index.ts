// On-phone dictation with SpeechAnalyzer (iOS 26): local native module. On earlier iOS and on Android it is absent (`null`):
// there expo-speech-recognition is used (src/features/composer/useDictation.ts).
import { requireOptionalNativeModule } from 'expo'

/** `installed`: ready. `supported`: can be downloaded. `downloading`: already downloading. `unsupported`: the language isn't available. */
export type AssetStatus = 'installed' | 'supported' | 'downloading' | 'unsupported'

export type LadderSpeechEvents = {
  /** Current transcript: `isFinal` closes the sentence (interim ones arrive while speaking). */
  result: (e: { text: string; isFinal: boolean }) => void
  /** Microphone level, 0..1. */
  level: (e: { level: number }) => void
  /** Model download progress, 0..1. */
  progress: (e: { fraction: number }) => void
  end: () => void
  error: (e: { message: string }) => void
}

export interface LadderSpeechModule {
  addListener<K extends keyof LadderSpeechEvents>(name: K, listener: LadderSpeechEvents[K]): { remove(): void }
  /** iOS 26 with the transcriber available on this device. */
  isAvailable(): boolean
  /** Language model status and, if the system reports it, the bytes to download. */
  assetStatus(locale: string): Promise<{ status: AssetStatus; bytes: number | null }>
  /** Downloads and installs the language model (`progress` events). Resolves when the model is ready. */
  install(locale: string): Promise<void>
  /** Microphone permission: `granted`, `denied` or `undetermined`. */
  micPermission(): Promise<'granted' | 'denied' | 'undetermined'>
  requestMic(): Promise<boolean>
  /** Starts listening: `result`, `level`, `end`, `error` events. */
  start(locale: string, contextualStrings: string[]): Promise<void>
  /** Stops and finishes the sentence in progress (the last final `result` arrives, then `end`). */
  stop(): Promise<void>
  /** Stops immediately, without a final result. */
  abort(): void
}

export default requireOptionalNativeModule<LadderSpeechModule>('LadderSpeech')
