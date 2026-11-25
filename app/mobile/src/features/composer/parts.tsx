// Pezzi del composer di LAD-92, condivisi tra la chat e lo sheet "Nuova sessione": miniature degli allegati, menu "+", microfono con onda,
// elenco dei suggerimenti ("/" e "@") e avviso della dettatura.
import { useEffect, useState } from 'react'
import { ActionSheetIOS, ActivityIndicator, Image, Platform, Pressable, ScrollView, View } from 'react-native'
import { t } from '@shared/i18n'
import type { SlashCommand } from '@shared/protocol'
import { splitPath } from '@/lib/composer-suggest'
import { useReduceMotion } from '@/lib/use-reduce-motion'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { MIN_TOUCH, Button } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import { Row } from '@/ui/List'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import type { Draft, AttachSource } from './useAttachments'
import { languageName, useMeter, type DictationProblem, type DictationState } from './useDictation'

const THUMB = 64

/** Miniature sopra il campo: tocca la x per togliere; mentre l'immagine si prepara c'è un indicatore. */
export function AttachmentStrip({ items, onRemove, disabled }: { items: Draft[]; onRemove: (id: string) => void; disabled?: boolean }) {
  const { c } = useTheme()
  if (items.length === 0) return null
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 10, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 2 }}>
      {items.map((d, i) => (
        <View key={d.id} accessible accessibilityLabel={t('Photo {n} of {total}', { n: i + 1, total: items.length })} accessibilityState={{ busy: d.status === 'processing' }} style={{ width: THUMB, height: THUMB }}>
          <Image source={{ uri: d.uri }} accessibilityIgnoresInvertColors style={{ width: THUMB, height: THUMB, borderRadius: RADIUS.lg, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border }} />
          {d.status === 'processing' ? (
            <View style={{ position: 'absolute', inset: 0, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(c.background, 0.55) }}>
              <ActivityIndicator color={c.text} />
            </View>
          ) : null}
          <Pressable
            onPress={() => onRemove(d.id)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={t('Remove photo {n}', { n: i + 1 })}
            hitSlop={{ top: 12, bottom: 4, left: 12, right: 12 }}
            style={{ position: 'absolute', top: -7, right: -7, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: c.text, borderWidth: 2, borderColor: c.background }}
          >
            <Icon name="x" size={12} color={c.background} strokeWidth={2.6} />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  )
}

/** Il "+" del composer: su iOS il menu nativo (action sheet), su Android un foglio con tre righe. */
export function AttachButton({ onPick, hasClipboardImage, disabled, full }: { onPick: (source: AttachSource) => void; hasClipboardImage: () => Promise<boolean>; disabled?: boolean; full?: boolean }) {
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  const [paste, setPaste] = useState(false)
  const press = async () => {
    const canPaste = await hasClipboardImage().catch(() => false)
    if (Platform.OS === 'ios') {
      const options = [t('Take photo'), t('Photo library'), ...(canPaste ? [t('Paste image')] : []), t('Cancel')]
      const sources: AttachSource[] = ['camera', 'library', ...(canPaste ? (['clipboard'] as const) : [])]
      ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: options.length - 1 }, (i) => {
        if (i < sources.length) onPick(sources[i])
      })
      return
    }
    setPaste(canPaste)
    setOpen(true)
  }
  const choose = (source: AttachSource) => {
    setOpen(false)
    // Il foglio si chiude prima che parta il selettore di sistema.
    setTimeout(() => onPick(source), 260)
  }
  return (
    <>
      <Pressable
        onPress={() => void press()}
        disabled={disabled || full}
        accessibilityRole="button"
        accessibilityLabel={t('Attach images')}
        accessibilityHint={full ? t('You can attach up to {n} images.', { n: 3 }) : undefined}
        accessibilityState={{ disabled: !!(disabled || full) }}
        style={({ pressed }) => ({ width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.selection : c.surface, borderWidth: 1, borderColor: c.border, opacity: disabled || full ? 0.4 : 1 })}
      >
        <Icon name="plus" size={22} color={c.text} />
      </Pressable>
      {Platform.OS === 'android' ? (
        <Sheet visible={open} onClose={() => setOpen(false)} title={t('Attach images')}>
          <View style={{ paddingBottom: 12 }}>
            <View style={{ marginHorizontal: 16, borderRadius: RADIUS.lg, backgroundColor: c.surface, overflow: 'hidden' }}>
              <Row label={t('Take photo')} right={<Icon name="camera" size={20} color={c.textMuted} />} onPress={() => choose('camera')} last={false} />
              <Row label={t('Photo library')} right={<Icon name="image" size={20} color={c.textMuted} />} onPress={() => choose('library')} last={!paste} />
              {paste ? <Row label={t('Paste image')} right={<Icon name="clipboard" size={20} color={c.textMuted} />} onPress={() => choose('clipboard')} last /> : null}
            </View>
          </View>
        </Sheet>
      ) : null}
    </>
  )
}

/** Onda del microfono: le ultime ~1,5 secondi di livello, a barre che scorrono. */
export function Waveform({ color, bars = 14 }: { color: string; bars?: number }) {
  const reduce = useReduceMotion()
  const [levels, setLevels] = useState<number[]>(() => Array(bars).fill(0))
  useEffect(() => {
    if (reduce) return
    const id = setInterval(() => setLevels((l) => [...l.slice(1), useMeter.getState().level]), 70)
    return () => clearInterval(id)
  }, [reduce])
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 28 }}>
      {levels.map((l, i) => (
        <View key={i} style={{ width: 3, height: reduce ? 8 : 4 + Math.round(l * 22), borderRadius: 1.5, backgroundColor: color, opacity: reduce ? 0.6 : 0.35 + l * 0.65 }} />
      ))}
    </View>
  )
}

/** Il microfono: avvia o ferma la dettatura. In ascolto è pieno e ferma al tocco. */
export function MicButton({ state, onStart, onStop, disabled }: { state: DictationState; onStart: () => void; onStop: () => void; disabled?: boolean }) {
  const { c } = useTheme()
  const listening = state === 'listening'
  const busy = state === 'starting'
  return (
    <Pressable
      onPress={listening ? onStop : onStart}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={listening ? t('Stop dictation') : t('Dictate')}
      accessibilityState={{ selected: listening, busy, disabled: !!disabled }}
      style={({ pressed }) => ({ width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: listening ? c.accent : pressed ? c.selection : 'transparent', opacity: disabled ? 0.4 : 1 })}
    >
      {busy ? <ActivityIndicator size="small" color={c.textMuted} /> : <Icon name={listening ? 'stop' : 'mic'} size={listening ? 18 : 22} color={listening ? c.onAccent : c.textMuted} />}
    </Pressable>
  )
}

/** Perché la dettatura non parte e cosa fare. Mai un ripiego sul riconoscimento in rete. */
export function DictationNotice({ problem, onDismiss, onSettings, onDownload }: { problem: DictationProblem; onDismiss: () => void; onSettings: () => void; onDownload: (locale: string) => void }) {
  const { c } = useTheme()
  const android = Platform.OS === 'android'
  let text: string
  let action: { label: string; run: () => void } | null = null
  switch (problem.kind) {
    case 'denied':
      text = t('Dictation needs access to the microphone and speech recognition. Turn them on in Settings.')
      action = { label: t('Open Settings'), run: onSettings }
      break
    case 'not-installed': {
      const lang = languageName(problem.locale)
      text = android ? t('Dictation needs the on-device model for {language}. Download it once and it works offline.', { language: lang }) : t('Dictation needs the on-device model for {language}. Turn on Dictation and add {language} in Settings > General > Keyboard.', { language: lang })
      action = android ? { label: t('Download model'), run: () => onDownload(problem.locale) } : { label: t('Open Settings'), run: onSettings }
      break
    }
    case 'unsupported':
      text = t('Dictation needs the on-device model for {language}, and this phone doesn’t have one. Ladder never sends your voice to a server.', { language: languageName(problem.locale) })
      break
    default:
      text = problem.message
  }
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ marginHorizontal: 12, marginTop: 8, padding: 12, gap: 8, borderRadius: RADIUS.lg, backgroundColor: alpha(c.waiting, 0.12), borderWidth: 1, borderColor: alpha(c.waiting, 0.5) }}>
      <Text variant="body">{text}</Text>
      <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
        <Button label={t('Dismiss')} variant="quiet" onPress={onDismiss} style={{ paddingHorizontal: 12 }} />
        {action ? <Button label={action.label} variant="secondary" onPress={action.run} style={{ paddingHorizontal: 12 }} /> : null}
      </View>
    </View>
  )
}

/** Elenco sopra il campo con i comandi ("/") o i file ("@"). Resta nel flusso: sopra la tastiera, sotto la chat. */
export function SuggestList({ kind, commands, files, loading, failed, query, onCommand, onFile }: { kind: 'command' | 'file'; commands: SlashCommand[]; files: string[]; loading: boolean; failed: boolean; query: string; onCommand: (name: string) => void; onFile: (path: string) => void }) {
  const { c } = useTheme()
  const empty = kind === 'command' ? commands.length === 0 : files.length === 0
  const note = empty ? (failed ? t('Could not load suggestions.') : loading ? (kind === 'command' ? t('Loading commands…') : t('Searching files…')) : kind === 'command' ? t('No commands match.') : query ? t('No files match.') : t('Type to search the project’s files.')) : null
  return (
    <View style={{ marginHorizontal: 12, marginTop: 8, maxHeight: 236, borderRadius: RADIUS.lg, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, overflow: 'hidden' }} accessibilityLabel={kind === 'command' ? t('Commands') : t('Files')}>
      <ScrollView keyboardShouldPersistTaps="always" keyboardDismissMode="none">
        {note ? (
          <View accessibilityLiveRegion="polite" style={{ minHeight: MIN_TOUCH, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {loading && !failed ? <ActivityIndicator size="small" color={c.textMuted} /> : null}
            <Text variant="body" tone="muted">
              {note}
            </Text>
          </View>
        ) : null}
        {kind === 'command'
          ? commands.map((cmd) => (
              <Pressable key={cmd.name} onPress={() => onCommand(cmd.name)} accessibilityRole="button" accessibilityLabel={`/${cmd.name}. ${cmd.description}`} style={({ pressed }) => ({ minHeight: MIN_TOUCH, paddingHorizontal: 14, paddingVertical: 6, justifyContent: 'center', backgroundColor: pressed ? c.selection : 'transparent' })}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                  <Text variant="code" style={{ color: c.accent }}>
                    {`/${cmd.name}`}
                  </Text>
                  {cmd.hint ? (
                    <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                      {cmd.hint}
                    </Text>
                  ) : null}
                </View>
                {cmd.description ? (
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {cmd.description}
                  </Text>
                ) : null}
              </Pressable>
            ))
          : files.map((path) => {
              const { name, dir } = splitPath(path)
              return (
                <Pressable key={path} onPress={() => onFile(path)} accessibilityRole="button" accessibilityLabel={path} style={({ pressed }) => ({ minHeight: MIN_TOUCH, paddingHorizontal: 14, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: pressed ? c.selection : 'transparent' })}>
                  <Icon name="file" size={18} color={c.textMuted} />
                  <View style={{ flex: 1 }}>
                    <Text variant="body" numberOfLines={1}>
                      {name}
                    </Text>
                    {dir ? (
                      <Text variant="caption" tone="muted" numberOfLines={1} ellipsizeMode="head">
                        {dir}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              )
            })}
      </ScrollView>
    </View>
  )
}
