// On-phone dictation. Never network recognition: the audio does not leave the phone.
// - iOS 26: SpeechAnalyzer/SpeechTranscriber (local module `ladder-speech`); the language model is downloaded from Apple on first use,
//   with progress in the notice, and then it starts on its own.
// - Earlier iOS: expo-speech-recognition with `requiresOnDeviceRecognition` (SFSpeechRecognizer on the phone).
// - Android 13+: expo-speech-recognition; the offline model downloads on its own (it/en) and then it starts.
// The text reaches the field while speaking.
import * as Haptics from 'expo-haptics'
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Linking, Platform } from 'react-native'
import { create } from 'zustand'
import LadderSpeech from '../../../modules/ladder-speech'
import { getLocale, t } from '@shared/i18n'
import { contextualStrings, dictationLocale, MAX_DICTATION_MS, mergeTranscript, meterLevel, onDeviceStatus, SILENCE_MS } from '@/lib/dictation'
import { useApp } from '@/store/app'
import { useDev } from '@/store/dev'

/** Microphone level (0..1): outside React so the composer isn't redrawn every 100 ms. */
export const useMeter = create<{ level: number }>(() => ({ level: 0 }))

export type DictationState = 'idle' | 'starting' | 'downloading' | 'listening'
/** Language model download in progress: `fraction` is null when the system doesn't report progress (Android). */
export interface DictationDownload {
  locale: string
  fraction: number | null
  bytes: number | null
}
/** Why dictation can't run: permission denied, unsupported language, model not on the phone, recognizer error (detail only in the log). */
export type DictationProblem = { kind: 'denied' } | { kind: 'unsupported'; locale: string } | { kind: 'not-installed'; locale: string } | { kind: 'error' }

/** Language name for the message ("Italian"), in the app's language. Hermes has no Intl.DisplayNames: the app's two languages are enough. */
export function languageName(locale: string): string {
  const base = locale.toLowerCase().split(/[-_]/)[0]
  return base === 'it' ? t('Italian') : base === 'en' ? t('English') : locale
}

/** iOS 26 with SpeechAnalyzer available: the path with no installed-language limit. */
const analyzerAvailable = (): boolean => Platform.OS === 'ios' && !!LadderSpeech && LadderSpeech.isAvailable()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function useDictation(opts: { getText: () => string; setText: (text: string) => void }) {
  const [state, setState] = useState<DictationState>('idle')
  const [problem, setProblem] = useState<DictationProblem | null>(null)
  const [download, setDownload] = useState<DictationDownload | null>(null)
  const projects = useApp((s) => s.projects)
  // Field text before dictation and the sentences already closed by the recognizer (Android closes them one at a time).
  const base = useRef('')
  const committed = useRef('')
  const lastVoice = useRef(0)
  const stateRef = useRef<DictationState>('idle')
  // Generation: every start, every notice dismissal and unmount bump it. After every wait (permission, download, native
  // start) a start that finds a different generation has been superseded or cancelled and stops there, without touching state.
  const gen = useRef(0)
  // Android: the model download is attempted only once per start.
  const triedDownload = useRef(false)
  const timers = useRef<{ silence?: ReturnType<typeof setInterval>; max?: ReturnType<typeof setTimeout> }>({})

  /** Changes the state also for whoever reads it before the next render (native events arrive in bursts). */
  const go = (next: DictationState) => {
    stateRef.current = next
    setState(next)
  }
  // The recognizer's events count only if this composer is listening (or about to): with two composers mounted, or after dictation
  // has ended, the text doesn't reach someone who asked for nothing.
  const live = () => stateRef.current === 'listening' || stateRef.current === 'starting'

  const clearTimers = () => {
    if (timers.current.silence) clearInterval(timers.current.silence)
    if (timers.current.max) clearTimeout(timers.current.max)
    timers.current = {}
  }

  const finish = useCallback(() => {
    if (!live()) return
    clearTimers()
    useMeter.setState({ level: 0 })
    if (stateRef.current === 'listening') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    go('idle')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stop = useCallback(() => {
    try {
      if (analyzerAvailable()) void LadderSpeech?.stop()
      else ExpoSpeechRecognitionModule.stop()
    } catch {
      finish()
    }
  }, [finish])

  const hear = useCallback((spoken: string, isFinal: boolean) => {
    if (!live()) return
    if (spoken.trim()) lastVoice.current = Date.now()
    if (isFinal) committed.current = mergeTranscript(committed.current, spoken)
    opts.setText(mergeTranscript(base.current, isFinal ? committed.current : mergeTranscript(committed.current, spoken)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Recognizer error: the user gets a translated text, the detail goes only to the log. */
  const fail = useCallback((detail: string) => {
    if (__DEV__ || detail) console.warn('[dictation]', detail)
    clearTimers()
    useMeter.setState({ level: 0 })
    go('idle')
    setProblem({ kind: 'error' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // expo-speech-recognition (iOS before 26, Android).
  useSpeechRecognitionEvent('start', () => {
    if (!live()) return
    lastVoice.current = Date.now()
    go('listening')
  })
  useSpeechRecognitionEvent('end', finish)
  useSpeechRecognitionEvent('volumechange', (e) => {
    if (!live()) return
    const level = meterLevel(e.value)
    if (e.value > 1) lastVoice.current = Date.now()
    useMeter.setState({ level })
  })
  useSpeechRecognitionEvent('result', (e) => hear(e.results[0]?.transcript ?? '', e.isFinal))
  useSpeechRecognitionEvent('error', (e) => {
    if (!live()) return
    clearTimers()
    useMeter.setState({ level: 0 })
    go('idle')
    // "No speech" is not an error to show: we were just silent.
    if (e.error === 'no-speech' || e.error === 'speech-timeout' || e.error === 'aborted') return
    const locale = dictationLocale(getLocale())
    if (e.error === 'not-allowed') setProblem({ kind: 'denied' })
    else if (e.error === 'language-not-supported') {
      // Android: the language model isn't there. If we haven't tried yet, it is downloaded and we restart; only after a failed attempt do we say so.
      if (Platform.OS === 'android' && !triedDownload.current) void downloadThenBegin(locale, ++gen.current)
      else setProblem({ kind: Platform.OS === 'android' ? 'not-installed' : 'unsupported', locale })
    } else if (e.error === 'service-not-allowed') setProblem({ kind: 'unsupported', locale })
    else fail(e.message || e.error)
  })

  // SpeechAnalyzer (iOS 26): the same events from the local module.
  useEffect(() => {
    if (!LadderSpeech) return
    const subs = [
      LadderSpeech.addListener('result', (e) => hear(e.text, e.isFinal)),
      LadderSpeech.addListener('level', (e) => {
        if (!live()) return
        if (e.level > 0.15) lastVoice.current = Date.now()
        useMeter.setState({ level: e.level })
      }),
      LadderSpeech.addListener('progress', (e) => setDownload((d) => (d ? { ...d, fraction: e.fraction } : d))),
      LadderSpeech.addListener('end', finish),
      LadderSpeech.addListener('error', (e) => {
        if (live()) fail(e.message)
      })
    ]
    return () => subs.forEach((x) => x.remove())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finish, hear, fail])

  /** Android: downloads the offline language model itself and waits for it to be installed. No progress from the system. */
  const androidDownload = useCallback(async (locale: string, my: number): Promise<boolean> => {
    setDownload({ locale, fraction: null, bytes: null })
    go('downloading')
    try {
      const r = await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale })
      if (r.status === 'download_success') return true
      // Queued (or a system dialog on Android 13): wait for the model to appear among the installed ones.
      const want = locale.toLowerCase().split('-')[0]
      for (let i = 0; i < 90 && gen.current === my; i++) {
        await sleep(2000)
        if (gen.current !== my) return false
        const l = await ExpoSpeechRecognitionModule.getSupportedLocales({})
        if (l.installedLocales.some((x) => x.toLowerCase().split(/[-_]/)[0] === want)) return true
      }
      return false
    } catch {
      return false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const begin = useCallback(
    (locale: string, my: number) => {
      clearTimers()
      base.current = opts.getText()
      committed.current = ''
      const ctx = contextualStrings(projects.map((p) => p.name))
      lastVoice.current = Date.now()
      if (analyzerAvailable()) {
        void LadderSpeech!.start(locale, ctx).then(
          () => {
            // Cancelled while starting (x, new start, unmount): the microphone is turned off.
            if (gen.current !== my) {
              LadderSpeech?.abort()
              return
            }
            // Already finished (stop during start): we don't go back to listening.
            if (stateRef.current !== 'starting') return
            lastVoice.current = Date.now()
            go('listening')
          },
          (e: unknown) => {
            if (gen.current !== my) return
            clearTimers()
            fail(e instanceof Error ? e.message : String(e))
          }
        )
      } else {
        ExpoSpeechRecognitionModule.start({
          lang: locale,
          interimResults: true,
          continuous: true,
          requiresOnDeviceRecognition: true,
          addsPunctuation: true,
          contextualStrings: ctx,
          volumeChangeEventOptions: { enabled: true, intervalMillis: 100 }
        })
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      // Prolonged silence or 5 minutes: it stops on its own.
      timers.current.silence = setInterval(() => {
        if (Date.now() - lastVoice.current > SILENCE_MS) stop()
      }, 500)
      timers.current.max = setTimeout(stop, MAX_DICTATION_MS)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, stop, fail]
  )

  /** Android: downloads the model (once per start) and, if it is there, starts. */
  const downloadThenBegin = useCallback(
    async (locale: string, my: number) => {
      triedDownload.current = true
      const ok = await androidDownload(locale, my)
      if (gen.current !== my) return
      setDownload(null)
      if (!ok) {
        go('idle')
        return setProblem({ kind: 'not-installed', locale })
      }
      go('starting')
      begin(locale, my)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [androidDownload, begin]
  )

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return
    const my = ++gen.current
    triedDownload.current = false
    setProblem(null)
    const locale = dictationLocale(getLocale())
    try {
      if (analyzerAvailable()) {
        // iOS 26: only the microphone; the language model is downloaded here, without going through Settings.
        go('starting')
        let mic = await LadderSpeech!.micPermission()
        if (gen.current !== my) return
        if (mic === 'undetermined') mic = (await LadderSpeech!.requestMic()) ? 'granted' : 'denied'
        if (gen.current !== my) return
        if (mic !== 'granted') {
          go('idle')
          return setProblem({ kind: 'denied' })
        }
        const info = await LadderSpeech!.assetStatus(locale)
        if (gen.current !== my) return
        if (info.status === 'unsupported') {
          go('idle')
          return setProblem({ kind: 'unsupported', locale })
        }
        if (info.status !== 'installed') {
          setDownload({ locale, fraction: 0, bytes: info.bytes })
          go('downloading')
          await LadderSpeech!.install(locale)
          if (gen.current !== my) return
          setDownload(null)
        }
        go('starting')
        return begin(locale, my)
      }
      // Android before 13 (API 33) ignores `requiresOnDeviceRecognition` and may use the network recognizer: dictation never runs there.
      if (Platform.OS === 'android' && Number(Platform.Version) < 33) return setProblem({ kind: 'unsupported', locale })
      go('starting')
      // iOS also wants the speech recognition authorization (also on the phone); Android only the microphone.
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      if (gen.current !== my) return
      if (!perm.granted) {
        go('idle')
        return setProblem({ kind: 'denied' })
      }
      // On the phone only: without the language model it doesn't start (and doesn't fall back to the network).
      let supported: string[] = []
      let installed: string[] = []
      try {
        const l = await ExpoSpeechRecognitionModule.getSupportedLocales({})
        supported = l.locales
        installed = l.installedLocales
      } catch {
        // Android 12 and earlier: no list; supportsOnDeviceRecognition decides.
      }
      if (gen.current !== my) return
      const status = onDeviceStatus(locale, supported, installed, ExpoSpeechRecognitionModule.supportsOnDeviceRecognition())
      if (!status.ok && status.reason === 'not-installed' && Platform.OS === 'android') return await downloadThenBegin(locale, my)
      if (!status.ok) {
        go('idle')
        return setProblem({ kind: status.reason, locale })
      }
      begin(locale, my)
    } catch (e) {
      if (gen.current !== my) return
      setDownload(null)
      fail(e instanceof Error ? e.message : String(e))
    }
  }, [begin, downloadThenBegin, fail])

  // Leaving the screen stops dictation (the microphone doesn't stay on).
  useEffect(
    () => () => {
      clearTimers()
      gen.current++
      if (stateRef.current === 'listening' || stateRef.current === 'starting') {
        try {
          if (analyzerAvailable()) LadderSpeech?.abort()
          else ExpoSpeechRecognitionModule.abort()
        } catch {
          // already stopped
        }
      }
      stateRef.current = 'idle'
      useMeter.setState({ level: 0 })
    },
    []
  )

  /** The notice's x: closes the message; during a download or a start it gives up starting on its own. */
  const dismiss = useCallback(() => {
    setProblem(null)
    if (stateRef.current === 'downloading' || stateRef.current === 'starting') {
      gen.current++
      setDownload(null)
      go('idle')
      try {
        if (analyzerAvailable()) LadderSpeech?.abort()
        else ExpoSpeechRecognitionModule.abort()
      } catch {
        // already stopped
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Development only: the driver forces a state to see the interface where there is no microphone (simulator).
  const forced = __DEV__ ? useDev((s) => s.dictation) : null
  if (forced === 'listening') return { state: 'listening' as DictationState, problem: null, download: null, dismiss: () => {}, start, stop: () => useDev.setState({ dictation: null }), openSettings: () => {} }
  if (forced === 'downloading') return { state: 'downloading' as DictationState, problem: null, download: { locale: dictationLocale(getLocale()), fraction: 0.42, bytes: 142_000_000 } as DictationDownload, dismiss: () => useDev.setState({ dictation: null }), start, stop, openSettings: () => {} }
  if (forced) return { state: 'idle' as DictationState, problem: (forced === 'denied' ? { kind: 'denied' } : { kind: forced, locale: dictationLocale(getLocale()) }) as DictationProblem, download: null, dismiss: () => useDev.setState({ dictation: null }), start, stop, openSettings: () => {} }

  return { state, problem, download, dismiss, start, stop, openSettings: () => void Linking.openSettings() }
}
