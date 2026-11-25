// Dettatura sul telefono. Mai il riconoscimento di rete: l'audio non lascia il telefono.
// - iOS 26: SpeechAnalyzer/SpeechTranscriber (modulo locale `ladder-speech`); il modello della lingua si scarica da Apple al primo uso,
//   con l'avanzamento nell'avviso, e poi si parte da soli.
// - iOS precedenti: expo-speech-recognition con `requiresOnDeviceRecognition` (SFSpeechRecognizer sul telefono).
// - Android 13+: expo-speech-recognition; il modello offline si scarica da solo (it/en) e poi si parte.
// Il testo arriva nel campo mentre si parla.
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

/** Livello del microfono (0..1): fuori da React per non ridisegnare il composer ogni 100 ms. */
export const useMeter = create<{ level: number }>(() => ({ level: 0 }))

export type DictationState = 'idle' | 'starting' | 'downloading' | 'listening'
/** Download del modello della lingua in corso: `fraction` è null quando il sistema non dice l'avanzamento (Android). */
export interface DictationDownload {
  locale: string
  fraction: number | null
  bytes: number | null
}
/** Perché non si può dettare: permesso negato, lingua non supportata, modello non sul telefono, errore del riconoscitore (dettaglio solo nel log). */
export type DictationProblem = { kind: 'denied' } | { kind: 'unsupported'; locale: string } | { kind: 'not-installed'; locale: string } | { kind: 'error' }

/** Nome della lingua per il messaggio ("italiano"), nella lingua dell'app. Hermes non ha Intl.DisplayNames: le due lingue dell'app bastano. */
export function languageName(locale: string): string {
  const base = locale.toLowerCase().split(/[-_]/)[0]
  return base === 'it' ? t('Italian') : base === 'en' ? t('English') : locale
}

/** iOS 26 con SpeechAnalyzer disponibile: il percorso senza limiti di lingua installata. */
const analyzerAvailable = (): boolean => Platform.OS === 'ios' && !!LadderSpeech && LadderSpeech.isAvailable()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function useDictation(opts: { getText: () => string; setText: (text: string) => void }) {
  const [state, setState] = useState<DictationState>('idle')
  const [problem, setProblem] = useState<DictationProblem | null>(null)
  const [download, setDownload] = useState<DictationDownload | null>(null)
  const projects = useApp((s) => s.projects)
  // Testo del campo prima della dettatura e frasi già chiuse dal riconoscitore (Android le chiude una alla volta).
  const base = useRef('')
  const committed = useRef('')
  const lastVoice = useRef(0)
  const stateRef = useRef<DictationState>('idle')
  // Generazione: ogni avvio, ogni chiusura dell'avviso e lo smontaggio la fanno salire. Dopo ogni attesa (permesso, download, avvio
  // nativo) un avvio che trova una generazione diversa è stato superato o annullato e si ferma lì, senza toccare lo stato.
  const gen = useRef(0)
  // Android: il download del modello si tenta una volta sola per avvio.
  const triedDownload = useRef(false)
  const timers = useRef<{ silence?: ReturnType<typeof setInterval>; max?: ReturnType<typeof setTimeout> }>({})

  /** Cambia lo stato anche per chi lo legge prima del prossimo rendering (gli eventi nativi arrivano a raffica). */
  const go = (next: DictationState) => {
    stateRef.current = next
    setState(next)
  }
  // Gli eventi del riconoscitore contano solo se questo composer sta ascoltando (o sta per): con due composer montati, o a dettatura
  // finita, il testo non arriva a chi non ha chiesto nulla.
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

  /** Errore del riconoscitore: all'utente un testo tradotto, il dettaglio solo nel log. */
  const fail = useCallback((detail: string) => {
    if (__DEV__ || detail) console.warn('[dictation]', detail)
    clearTimers()
    useMeter.setState({ level: 0 })
    go('idle')
    setProblem({ kind: 'error' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // expo-speech-recognition (iOS prima della 26, Android).
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
    // "Niente voce" non è un errore da mostrare: si è solo stati zitti.
    if (e.error === 'no-speech' || e.error === 'speech-timeout' || e.error === 'aborted') return
    const locale = dictationLocale(getLocale())
    if (e.error === 'not-allowed') setProblem({ kind: 'denied' })
    else if (e.error === 'language-not-supported') {
      // Android: il modello della lingua non c'è. Se non si è ancora provato, si scarica e si riparte; solo dopo un tentativo fallito si dice.
      if (Platform.OS === 'android' && !triedDownload.current) void downloadThenBegin(locale, ++gen.current)
      else setProblem({ kind: Platform.OS === 'android' ? 'not-installed' : 'unsupported', locale })
    } else if (e.error === 'service-not-allowed') setProblem({ kind: 'unsupported', locale })
    else fail(e.message || e.error)
  })

  // SpeechAnalyzer (iOS 26): gli stessi eventi dal modulo locale.
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

  /** Android: scarica da sé il modello offline della lingua e aspetta che sia installato. Niente avanzamento dal sistema. */
  const androidDownload = useCallback(async (locale: string, my: number): Promise<boolean> => {
    setDownload({ locale, fraction: null, bytes: null })
    go('downloading')
    try {
      const r = await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale })
      if (r.status === 'download_success') return true
      // Accodato (o finestra di sistema su Android 13): si aspetta che il modello compaia fra quelli installati.
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
            // Annullata mentre partiva (x, nuovo avvio, smontaggio): il microfono si spegne.
            if (gen.current !== my) {
              LadderSpeech?.abort()
              return
            }
            // Già finita (stop durante l'avvio): non si torna in ascolto.
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
      // Silenzio prolungato o 5 minuti: si ferma da sola.
      timers.current.silence = setInterval(() => {
        if (Date.now() - lastVoice.current > SILENCE_MS) stop()
      }, 500)
      timers.current.max = setTimeout(stop, MAX_DICTATION_MS)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, stop, fail]
  )

  /** Android: scarica il modello (una volta per avvio) e, se c'è, parte. */
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
        // iOS 26: solo il microfono; il modello della lingua si scarica qui, senza passare da Impostazioni.
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
      // Android prima della 13 (API 33) ignora `requiresOnDeviceRecognition` e può usare il riconoscitore di rete: lì non si detta mai.
      if (Platform.OS === 'android' && Number(Platform.Version) < 33) return setProblem({ kind: 'unsupported', locale })
      go('starting')
      // iOS vuole anche l'autorizzazione al riconoscimento (anche sul telefono); Android solo il microfono.
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      if (gen.current !== my) return
      if (!perm.granted) {
        go('idle')
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

  // Uscendo dalla schermata la dettatura si ferma (il microfono non resta acceso).
  useEffect(
    () => () => {
      clearTimers()
      gen.current++
      if (stateRef.current === 'listening' || stateRef.current === 'starting') {
        try {
          if (analyzerAvailable()) LadderSpeech?.abort()
          else ExpoSpeechRecognitionModule.abort()
        } catch {
          // già fermo
        }
      }
      stateRef.current = 'idle'
      useMeter.setState({ level: 0 })
    },
    []
  )

  /** La x dell'avviso: chiude il messaggio; durante un download o un avvio rinuncia a partire da sola. */
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
        // già fermo
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Solo sviluppo: il driver forza uno stato per vedere l'interfaccia dove il microfono non c'è (simulatore).
  const forced = __DEV__ ? useDev((s) => s.dictation) : null
  if (forced === 'listening') return { state: 'listening' as DictationState, problem: null, download: null, dismiss: () => {}, start, stop: () => useDev.setState({ dictation: null }), openSettings: () => {} }
  if (forced === 'downloading') return { state: 'downloading' as DictationState, problem: null, download: { locale: dictationLocale(getLocale()), fraction: 0.42, bytes: 142_000_000 } as DictationDownload, dismiss: () => useDev.setState({ dictation: null }), start, stop, openSettings: () => {} }
  if (forced) return { state: 'idle' as DictationState, problem: (forced === 'denied' ? { kind: 'denied' } : { kind: forced, locale: dictationLocale(getLocale()) }) as DictationProblem, download: null, dismiss: () => useDev.setState({ dictation: null }), start, stop, openSettings: () => {} }

  return { state, problem, download, dismiss, start, stop, openSettings: () => void Linking.openSettings() }
}
