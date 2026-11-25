// Dettatura sul telefono (LAD-92): expo-speech-recognition con `requiresOnDeviceRecognition: true`. Mai il riconoscimento di rete:
// se la lingua non ha il modello sul telefono si dice come ottenerlo, e basta. Il testo arriva nel campo mentre si parla.
import * as Haptics from 'expo-haptics'
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Linking, Platform } from 'react-native'
import { create } from 'zustand'
import { getLocale, t } from '@shared/i18n'
import { contextualStrings, dictationLocale, MAX_DICTATION_MS, mergeTranscript, meterLevel, onDeviceStatus, SILENCE_MS } from '@/lib/dictation'
import { useApp } from '@/store/app'
import { useDev } from '@/store/dev'
import { useToast } from '@/ui/toast'

/** Livello del microfono (0..1): fuori da React per non ridisegnare il composer ogni 100 ms. */
export const useMeter = create<{ level: number }>(() => ({ level: 0 }))

export type DictationState = 'idle' | 'starting' | 'listening'
/** Perché non si può dettare: permesso negato, lingua non supportata, modello non ancora sul telefono. */
export type DictationProblem = { kind: 'denied' } | { kind: 'unsupported'; locale: string } | { kind: 'not-installed'; locale: string } | { kind: 'error'; message: string }

/** Nome della lingua per il messaggio ("italiano"), nella lingua dell'app. Hermes non ha Intl.DisplayNames: le due lingue dell'app bastano. */
export function languageName(locale: string): string {
  const base = locale.toLowerCase().split(/[-_]/)[0]
  return base === 'it' ? t('Italian') : base === 'en' ? t('English') : locale
}

export function useDictation(opts: { getText: () => string; setText: (text: string) => void }) {
  const [state, setState] = useState<DictationState>('idle')
  const [problem, setProblem] = useState<DictationProblem | null>(null)
  const projects = useApp((s) => s.projects)
  // Testo del campo prima della dettatura e frasi già chiuse dal riconoscitore (Android le chiude una alla volta).
  const base = useRef('')
  const committed = useRef('')
  const lastVoice = useRef(0)
  const stateRef = useRef<DictationState>('idle')
  const timers = useRef<{ silence?: ReturnType<typeof setInterval>; max?: ReturnType<typeof setTimeout> }>({})
  stateRef.current = state

  const clearTimers = () => {
    if (timers.current.silence) clearInterval(timers.current.silence)
    if (timers.current.max) clearTimeout(timers.current.max)
    timers.current = {}
  }

  const finish = useCallback(() => {
    clearTimers()
    useMeter.setState({ level: 0 })
    if (stateRef.current !== 'idle') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    setState('idle')
  }, [])

  const stop = useCallback(() => {
    try {
      ExpoSpeechRecognitionModule.stop()
    } catch {
      finish()
    }
  }, [finish])

  useSpeechRecognitionEvent('start', () => {
    lastVoice.current = Date.now()
    setState('listening')
  })
  useSpeechRecognitionEvent('end', finish)
  useSpeechRecognitionEvent('volumechange', (e) => {
    const level = meterLevel(e.value)
    if (e.value > 1) lastVoice.current = Date.now()
    useMeter.setState({ level })
  })
  useSpeechRecognitionEvent('result', (e) => {
    const spoken = e.results[0]?.transcript ?? ''
    if (spoken.trim()) lastVoice.current = Date.now()
    if (e.isFinal) committed.current = mergeTranscript(committed.current, spoken)
    opts.setText(mergeTranscript(base.current, e.isFinal ? committed.current : mergeTranscript(committed.current, spoken)))
  })
  useSpeechRecognitionEvent('error', (e) => {
    clearTimers()
    useMeter.setState({ level: 0 })
    setState('idle')
    // "Niente voce" non è un errore da mostrare: si è solo stati zitti.
    if (e.error === 'no-speech' || e.error === 'speech-timeout' || e.error === 'aborted') return
    const locale = dictationLocale(getLocale())
    if (e.error === 'not-allowed') setProblem({ kind: 'denied' })
    else if (e.error === 'language-not-supported') setProblem({ kind: Platform.OS === 'android' ? 'not-installed' : 'unsupported', locale })
    else if (e.error === 'service-not-allowed') setProblem({ kind: 'unsupported', locale })
    else setProblem({ kind: 'error', message: e.message || t('Dictation stopped unexpectedly.') })
  })

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return
    setProblem(null)
    const locale = dictationLocale(getLocale())
    // Android prima della 13 (API 33) ignora `requiresOnDeviceRecognition` e può usare il riconoscitore di rete: lì non si detta mai.
    if (Platform.OS === 'android' && Number(Platform.Version) < 33) return setProblem({ kind: 'unsupported', locale })
    setState('starting')
    try {
      // iOS vuole anche l'autorizzazione al riconoscimento (anche sul telefono); Android solo il microfono.
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      if (!perm.granted) {
        setState('idle')
        return setProblem({ kind: 'denied' })
      }
      // Solo sul telefono: senza il modello della lingua non si parte (e non si ripiega sulla rete).
      let supported: string[] = []
      let installed: string[] = []
      try {
        const l = await ExpoSpeechRecognitionModule.getSupportedLocales({})
        supported = l.locales
        installed = l.installedLocales
      } catch {
        // Android 12 e precedenti: nessun elenco; decide supportsOnDeviceRecognition.
      }
      const status = onDeviceStatus(locale, supported, installed, ExpoSpeechRecognitionModule.supportsOnDeviceRecognition())
      if (!status.ok) {
        setState('idle')
        return setProblem({ kind: status.reason, locale })
      }
      base.current = opts.getText()
      committed.current = ''
      ExpoSpeechRecognitionModule.start({
        lang: locale,
        interimResults: true,
        continuous: true,
        requiresOnDeviceRecognition: true,
        addsPunctuation: true,
        contextualStrings: contextualStrings(projects.map((p) => p.name)),
        volumeChangeEventOptions: { enabled: true, intervalMillis: 100 }
      })
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      // Silenzio prolungato o 5 minuti: si ferma da sola.
      timers.current.silence = setInterval(() => {
        if (Date.now() - lastVoice.current > SILENCE_MS) stop()
      }, 500)
      timers.current.max = setTimeout(stop, MAX_DICTATION_MS)
    } catch (e) {
      clearTimers()
      setState('idle')
      setProblem({ kind: 'error', message: e instanceof Error ? e.message : t('Dictation stopped unexpectedly.') })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, stop])

  // Uscendo dalla schermata la dettatura si ferma (il microfono non resta acceso).
  useEffect(
    () => () => {
      clearTimers()
      if (stateRef.current !== 'idle') {
        try {
          ExpoSpeechRecognitionModule.abort()
        } catch {
          // già fermo
        }
      }
      useMeter.setState({ level: 0 })
    },
    []
  )

  /** Android: scarica il modello della lingua. iOS: il modello si scarica da Impostazioni (Generali > Tastiera > Dettatura). */
  const downloadModel = useCallback(async (locale: string) => {
    try {
      const r = await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale })
      useToast.getState().show(r.status === 'download_success' ? t('The dictation model is ready.') : t('Downloading the dictation model…'))
      if (r.status === 'download_success') setProblem(null)
    } catch {
      useToast.getState().show(t('Could not start the download. Try it from the Google app settings.'), 'error')
    }
  }, [])

  // Solo sviluppo: il driver forza uno stato per vedere l'interfaccia dove il microfono non c'è (simulatore).
  const forced = __DEV__ ? useDev((s) => s.dictation) : null
  if (forced === 'listening') return { state: 'listening' as DictationState, problem: null, dismiss: () => {}, start, stop: () => useDev.setState({ dictation: null }), downloadModel, openSettings: () => {} }
  if (forced) return { state: 'idle' as DictationState, problem: (forced === 'denied' ? { kind: 'denied' } : { kind: forced, locale: dictationLocale(getLocale()) }) as DictationProblem, dismiss: () => useDev.setState({ dictation: null }), start, stop, downloadModel, openSettings: () => {} }

  return { state, problem, dismiss: () => setProblem(null), start, stop, downloadModel, openSettings: () => void Linking.openSettings() }
}
