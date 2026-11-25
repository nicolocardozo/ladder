// Nuova sessione dal telefono (LAD-89). Il caso comune è progetto + messaggio + Invia; agente, account, modello, effort e permesso
// stanno nelle opzioni, chiuse, con una riga di riepilogo. I valori di partenza li decide il Mac (`RemoteSnapshot.defaults`, vedi
// lib/new-session.ts). Un errore resta nel modulo, in chiaro, e il testo non si perde. A sessione creata si apre la sua chat
// nella pila delle Sessioni e lo sheet si chiude.
import * as Clipboard from 'expo-clipboard'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, View, useWindowDimensions } from 'react-native'
import { t } from '@shared/i18n'
import type { AgentId, Effort, PermissionLevel } from '@shared/protocol'
import { actions } from '@/host/actions'
import { canAct } from '@/host/controller'
import { commandFits } from '@/lib/attachments'
import { focusedRoute, openSession } from '@/lib/nav'
import { createCommand, effortName, findCreated, MAX_MESSAGE, messageError, projectSections, resolveForm, type FormInput, type Picks } from '@/lib/new-session'
import { rememberThumb } from '@/lib/sent-thumbs'
import { nativeSheets, useSheets } from '@/lib/sheets'
import { useOnce } from '@/lib/use-once'
import { useApp } from '@/store/app'
import { useDev } from '@/store/dev'
import { usePrefs } from '@/store/prefs'
import { alpha, useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { AgentMark } from '@/ui/AgentMark'
import { Button, IconButton } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import { Group, Row } from '@/ui/List'
import { SheetTitle } from '@/ui/NativeSheet'
import { Text } from '@/ui/Text'
import { TextInput } from '@/ui/TextInput'
import { AttachButton, AttachmentStrip, DictationNotice, MicButton, SuggestList, Waveform } from '../composer/parts'
import { useAttachments } from '../composer/useAttachments'
import { useDictation } from '../composer/useDictation'
import { useSuggest, type Selection } from '../composer/useSuggest'
import { levelName } from '../session/PermissionSheet'

type Step = 'form' | 'project' | 'agent' | 'account' | 'model' | 'effort' | 'permission'

/** Sopra questo numero di progetti compare la ricerca. */
const SEARCH_FROM = 8
const DRAFT_KEY = 'new-session'

export function NewSessionContent({ onClose: onCloseRaw }: { onClose: () => void }) {
  const onClose = useOnce(onCloseRaw)
  const { c } = useTheme()
  const router = useRouter()
  const projects = useApp((s) => s.projects)
  const projectGroups = useApp((s) => s.projectGroups)
  const defaults = useApp((s) => s.defaults)
  const agents = useApp((s) => s.agents)
  const profiles = useApp((s) => s.profiles)
  const permissionsMax = useApp((s) => s.permissionsMax)
  const allowFull = useApp((s) => s.prefs.allowFull)
  const online = useApp((s) => canAct(s.conn))
  const contextProjectId = useSheets((s) => s.newSessionProject)
  const lastProjectId = usePrefs((s) => s.lastProject)
  const draft = usePrefs((s) => s.drafts[DRAFT_KEY] ?? '')
  const setDraft = usePrefs((s) => s.setDraft)

  const input = useMemo<FormInput>(() => ({ projects, projectGroups, defaults, agents, profiles, permissionsMax, allowFull, contextProjectId, lastProjectId }), [projects, projectGroups, defaults, agents, profiles, permissionsMax, allowFull, contextProjectId, lastProjectId])
  // Il progetto di partenza si decide una volta, all'apertura: un aggiornamento dal Mac non deve spostarlo sotto le dita.
  const dev = __DEV__ ? useDev.getState().newSession : null
  const [picks, setPicks] = useState<Picks>(() => ({ projectId: dev?.project ?? resolveForm(input, { projectId: dev?.project }).projectId, ...(dev?.agent ? { agent: dev.agent as AgentId } : {}) }))
  const values = useMemo(() => resolveForm(input, picks), [input, picks])
  const [text, setText] = useState(draft)
  const [view, setView] = useState<Step>((dev?.step as Step | undefined) ?? 'form')
  const [open, setOpen] = useState(!!dev?.expand)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input_ = useRef<ComponentRef<typeof TextInput>>(null)
  const mounted = useRef(true)
  const att = useAttachments()
  const [sel, setSel] = useState<Selection>({ start: text.length, end: text.length })
  const [forced, setForced] = useState<Selection | null>(null)
  const textRef = useRef(text)
  textRef.current = text
  // Solo sviluppo: il driver porta il focus nel campo per provare la tastiera.
  const devFocus = useDev((d) => d.focusNewSession)
  useEffect(() => {
    if (__DEV__ && devFocus && view === 'form') setTimeout(() => input_.current?.focus(), 700)
  }, [devFocus, view])
  useEffect(() => () => void (mounted.current = false), [])
  // Solo sviluppo: il driver scrive nel campo e allega file locali.
  useEffect(() => {
    if (!__DEV__) return
    useDev.getState().setComposer((cmd) => {
      if (cmd.text !== undefined) {
        change(cmd.text)
        setSel({ start: cmd.text.length, end: cmd.text.length })
      }
      for (const uri of cmd.images ?? []) void att.addUri(uri)
    })
    return () => useDev.getState().setComposer(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const change = (v: string) => {
    setText(v)
    setDraft(DRAFT_KEY, v)
    if (error) setError(null)
  }
  const dict = useDictation({ getText: () => textRef.current, setText: change })
  const listening = dict.state === 'listening'
  // Qui i comandi non ci sono (la sessione non esiste ancora): solo i file del progetto scelto.
  const suggest = useSuggest({ projectId: values.projectId, text, selection: sel, setText: change, enabled: !sending })
  const typed = (v: string) => {
    if (listening) dict.stop()
    change(v)
    if (att.error) att.clearError()
  }
  const pickSuggestion = (value: string) => {
    const cursor = suggest.choose(value, 'file')
    if (cursor !== null) setForced({ start: cursor, end: cursor })
  }
  const pick = (patch: Picks) => {
    setPicks((p) => ({ ...p, ...patch }))
    setView('form')
    setError(null)
  }

  const project = projects.find((p) => p.id === values.projectId)
  const agentName = (agent: AgentId): string => agents.find((a) => a.agent === agent)?.name ?? agent
  const problem = messageError(text, att.ready.length)
  const payload = att.ready.map((f) => ({ name: f.name, mediaType: 'image/jpeg', data: f.base64 }))
  const command = createCommand(values, text, payload)
  const tooBig = !!command && !commandFits(text, att.ready)
  const canSend = online && !sending && !att.busy && !problem && !!command && !tooBig
  const reason = !online ? t('Reconnect to your Mac to send.') : tooBig ? t('The message and its images are too big to send together. Remove an image or shorten the text.') : problem === 'long' ? t('The message is too long ({max} characters at most).', { max: MAX_MESSAGE.toLocaleString() }) : !values.agent && values.projectId ? t('No agent is available for this project.') : null

  // Solo sviluppo: invio automatico per provare lo stato di invio.
  useEffect(() => {
    if (__DEV__ && dev?.send) setTimeout(() => void sendRef.current(), 1200)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = useCallback(async () => {
    if (!command || !canSend) return
    setSending(true)
    setError(null)
    for (const f of att.ready) rememberThumb(f.name, f.uri)
    // Sessioni di prima e ora d'invio: se la risposta non arriva (timeout, collegamento caduto) la sessione può esistere lo stesso.
    const known = new Set(Object.keys(useApp.getState().sessions))
    const startedAt = Date.now()
    const result = await actions.create(command)
    const created = result.ok ? result.session : findCreated(Object.values(useApp.getState().sessions), known, command, startedAt)
    if (!created) {
      if (!mounted.current) return
      setSending(false)
      setError(result.ok ? null : result.error)
      return
    }
    // Il Mac manda `session.upsert` di solito prima del risultato; se non fosse arrivato, la sessione entra comunque nello store.
    useApp.getState().applyEvent({ type: 'session.upsert', session: created })
    // Bozza e ultimo progetto si aggiornano comunque: anche con lo sheet già chiuso la sessione è nata.
    usePrefs.getState().setLastProject(command.projectId)
    setDraft(DRAFT_KEY, '')
    att.clear()
    if (!mounted.current) return
    // Come al tocco su una notifica (push-taps.ts): si chiude solo lo sheet, e solo dopo si apre la chat.
    if (nativeSheets() && router.canDismiss()) router.dismiss()
    else onClose()
    // La chat è una schermata della radice (copre i tab da sé). Si apre a sheet chiuso e solo se il quadro è ancora quello: collegamento
    // pieno, nessuno sheet in primo piano e non già lì (l'utente può essere andato altrove nel frattempo).
    setTimeout(() => {
      if (!canAct()) return
      const route = focusedRoute()
      if (route?.name.startsWith('sheet/') || (route?.name.startsWith('session/') && route.params?.id === created.id)) return
      openSession(router, created.id)
    }, 450)
    }, [command, canSend, onClose, router, setDraft, att])
  const sendRef = useRef(send)
  sendRef.current = send

  // Il progetto sparisce (tolto dal Mac) mentre il modulo è aperto: si ricalcola da solo; senza progetti non c'è nulla da fare.
  if (projects.length === 0) {
    return (
      <>
        <SheetTitle>{t('New session')}</SheetTitle>
        <View style={{ paddingHorizontal: 20, gap: 16 }}>
          <Text variant="body" tone="muted">
            {t('Add a project in Ladder on your Mac first, then start a session here.')}
          </Text>
          <Button label={t('Close')} onPress={onClose} />
        </View>
      </>
    )
  }

  if (view !== 'form') {
    return (
      <Picker view={view} onBack={() => setView('form')}>
        {view === 'project' ? <ProjectList input={input} selected={values.projectId} onPick={(id) => pick({ projectId: id, agent: undefined, profileId: undefined, model: undefined, effort: undefined, permission: undefined })} /> : null}
        {view === 'agent' ? (
          <Group>
            {values.agentOptions.map((agent, i) => (
              <Row key={agent} label={agentName(agent)} selected={agent === values.agent} onPress={() => pick({ agent, profileId: undefined, model: undefined, effort: undefined })} right={<AgentMark agent={agent} size={16} color={c.textMuted} />} last={i === values.agentOptions.length - 1} />
            ))}
          </Group>
        ) : null}
        {view === 'account' ? (
          <Group>
            {values.profileOptions.map((p, i) => (
              <Row key={p.id} label={p.name} detail={values.agent ? agents.find((a) => a.agent === values.agent && (p.isDefault ? !a.profileId || a.profileId.startsWith('default:') : a.profileId === p.id))?.account ?? undefined : undefined} selected={p.id === values.profile?.id} onPress={() => pick({ profileId: p.isDefault ? null : p.id, model: undefined, effort: undefined })} last={i === values.profileOptions.length - 1} />
            ))}
          </Group>
        ) : null}
        {view === 'model' ? (
          <Group>
            <Row label={defaultModelText(values.defaultModelLabel)} selected={values.model === null} onPress={() => pick({ model: null, effort: undefined })} last={values.modelOptions.length === 0} />
            {values.modelOptions.map((m, i) => (
              <Row key={m.id} label={m.label} selected={values.model === m.id} onPress={() => pick({ model: m.id, effort: undefined })} last={i === values.modelOptions.length - 1} />
            ))}
          </Group>
        ) : null}
        {view === 'effort' ? (
          <Group>
            <Row label={values.defaultEffort ? t('Default ({effort})', { effort: effortName(values.defaultEffort) }) : t('Default')} selected={values.effort === null} onPress={() => pick({ effort: null })} last={values.effortOptions.length === 0} />
            {values.effortOptions.map((e, i) => (
              <Row key={e} label={effortName(e)} selected={values.effort === e} onPress={() => pick({ effort: e as Effort })} last={i === values.effortOptions.length - 1} />
            ))}
          </Group>
        ) : null}
        {view === 'permission' ? (
          <Group>
            {values.levels.map((l, i) => (
              <Row
                key={l.level}
                label={levelName(l.level)}
                detail={l.reason === 'max' ? t('Above this project’s maximum ({max}).', { max: levelName(permissionsMax[values.projectId ?? ''] ?? 'full') }) : l.reason === 'full-off' ? t('Turned off on your Mac.') : levelHelp(l.level)}
                selected={l.level === values.permission}
                disabled={!l.allowed}
                onPress={l.allowed ? () => pick({ permission: l.level }) : undefined}
                last={i === values.levels.length - 1}
              />
            ))}
          </Group>
        ) : null}
      </Picker>
    )
  }

  const modelValue = values.model ? (values.modelOptions.find((m) => m.id === values.model)?.label ?? values.model) : defaultModelText(values.effectiveModelLabel)
  const effortValue = values.effort ? effortName(values.effort) : values.defaultEffort ? t('Default ({effort})', { effort: effortName(values.defaultEffort) }) : t('Default')
  const shortSummary = [values.agent ? agentName(values.agent) : null, values.effectiveModelLabel].filter(Boolean).join(' · ')
  const summary = [values.agent ? agentName(values.agent) : null, values.profileOptions.length > 1 ? values.profile?.name : null, values.effectiveModelLabel, values.effort ? effortName(values.effort) : null, levelName(values.permission)].filter(Boolean).join(' · ')

  return (
    <>
      <SheetTitle>{t('New session')}</SheetTitle>
      <Group>
        <Row label={t('Project')} value={project?.name ?? ''} onPress={() => setView('project')} last />
      </Group>
      {/* Come il composer della chat: il campo cresce con il testo (da tre righe), sotto ci sono allega, microfono, riepilogo delle opzioni e Invia. */}
      <View style={{ marginHorizontal: 16, marginTop: 12 }}>
        <View style={{ borderRadius: 22, backgroundColor: c.surface, borderWidth: 1, borderColor: listening ? c.accent : c.border, overflow: 'hidden' }}>
          {att.count > 0 ? (
            <View style={{ marginHorizontal: -4 }}>
              <AttachmentStrip items={att.items} onRemove={att.remove} disabled={sending} />
            </View>
          ) : null}
          <TextInput
            ref={input_}
            value={text}
            onChangeText={typed}
            onSelectionChange={(e) => {
              setSel(e.nativeEvent.selection)
              if (forced) setForced(null)
            }}
            selection={forced ?? undefined}
            placeholder={listening ? t('Listening…') : t('What should the agent do?')}
            placeholderTextColor={c.textMuted}
            multiline
            editable={!sending}
            accessibilityLabel={t('First message')}
            style={{ minHeight: 78, maxHeight: 168, color: c.text, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, fontSize: 16, lineHeight: 22 }}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, paddingLeft: 6, paddingRight: 8, paddingBottom: 8 }}>
            <AttachButton onPick={(source) => void att.pick(source)} hasClipboardImage={() => Clipboard.hasImageAsync()} disabled={sending} full={att.count >= 3} />
            <MicButton state={dict.state} onStart={() => void dict.start()} onStop={dict.stop} disabled={sending} />
            {listening ? <Waveform color={c.accent} /> : null}
            <Pressable
              onPress={() => setOpen((o) => !o)}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              accessibilityLabel={`${t('Options')}. ${summary}`}
              style={({ pressed }) => ({ flex: 1, minHeight: 44, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: RADIUS.md, backgroundColor: pressed ? c.selection : 'transparent' })}
            >
              <Icon name="sliders" size={16} color={c.textMuted} />
              <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                {open ? t('Options') : shortSummary}
              </Text>
              <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
                <Icon name="chevron-down" size={14} color={c.textMuted} />
              </View>
            </Pressable>
            <Pressable
              onPress={() => void send()}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSend, busy: sending }}
              accessibilityLabel={t('Send')}
              style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent, opacity: !canSend && !sending ? 0.35 : pressed ? 0.85 : 1 })}
            >
              {sending ? <ActivityIndicator color={c.onAccent} /> : <Icon name="arrow-up" size={20} color={c.onAccent} strokeWidth={2.2} />}
            </Pressable>
          </View>
        </View>
      </View>
      {suggest.trigger ? (
        <View style={{ marginHorizontal: 4 }}>
          <SuggestList kind="file" commands={[]} files={suggest.files} loading={suggest.loading} failed={suggest.failed} query={suggest.trigger.query} onCommand={() => {}} onFile={pickSuggestion} />
        </View>
      ) : null}
      {dict.problem || dict.download ? <DictationNotice problem={dict.problem} download={dict.download} onDismiss={dict.dismiss} onSettings={dict.openSettings} onRetry={() => void dict.start()} /> : null}
      {att.error ? (
        <Text variant="caption" tone="error" accessibilityRole="alert" style={{ paddingHorizontal: 20, paddingTop: 8 }}>
          {att.error}
        </Text>
      ) : null}
      {open ? (
        <View style={{ marginTop: 4 }}>
          <Group>
            <Row label={t('Agent')} value={values.agent ? agentName(values.agent) : '—'} onPress={values.agentOptions.length > 1 ? () => setView('agent') : undefined} last={false} />
            {values.profileOptions.length > 1 ? <Row label={t('Account')} value={values.profile?.name ?? ''} onPress={() => setView('account')} /> : null}
            <Row label={t('Model')} value={modelValue} onPress={values.modelOptions.length > 0 ? () => setView('model') : undefined} />
            {values.effortOptions.length > 0 ? <Row label={t('Effort')} value={effortValue} onPress={() => setView('effort')} /> : null}
            <Row label={t('Permission')} value={levelName(values.permission)} onPress={() => setView('permission')} last />
          </Group>
        </View>
      ) : null}
      <View style={{ paddingHorizontal: 16, paddingTop: 10, gap: 10 }}>
        {error ? (
          <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', padding: 12, borderRadius: RADIUS.md, backgroundColor: alpha(c.error, 0.12), borderWidth: 1, borderColor: alpha(c.error, 0.5) }}>
            <View style={{ marginTop: 2 }}>
              <Icon name="x" size={14} color={c.error} strokeWidth={2.4} />
            </View>
            <Text variant="body" style={{ flex: 1 }}>
              {error}
            </Text>
          </View>
        ) : null}
        {reason ? (
          <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
            {reason}
          </Text>
        ) : null}
      </View>
    </>
  )
}

const defaultModelText = (label: string | null | undefined): string => (label ? t('Default ({model})', { model: label }) : t('Default'))

const levelHelp = (level: PermissionLevel): string =>
  ({
    plan: t('Reads and plans. Changes nothing.'),
    ask: t('Asks before editing files or running commands.'),
    edit: t('Edits files freely. Asks before running commands.'),
    full: t('Runs everything without asking.')
  })[level]

const TITLES: Record<Exclude<Step, 'form'>, () => string> = {
  project: () => t('Project'),
  agent: () => t('Agent'),
  account: () => t('Account'),
  model: () => t('Model'),
  effort: () => t('Effort'),
  permission: () => t('Permission')
}

/** Una scelta dentro lo sheet: indietro e titolo, poi l'elenco. */
function Picker({ view, onBack, children }: { view: Exclude<Step, 'form'>; onBack: () => void; children: ReactNode }) {
  // Lo sheet è alto quanto il contenuto: un elenco lungo scorre dentro, senza superare i due terzi dello schermo.
  const { height } = useWindowDimensions()
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 4 }}>
        <IconButton icon="chevron-left" label={t('Back')} onPress={onBack} />
        <Text variant="headline" accessibilityRole="header" style={{ flex: 1 }}>
          {TITLES[view]()}
        </Text>
      </View>
      <ScrollView style={{ maxHeight: height * 0.62 }} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </>
  )
}

/** Progetti nelle sezioni del Mac; con molti progetti si cerca per nome. */
function ProjectList({ input, selected, onPick }: { input: FormInput; selected: string | null; onPick: (id: string) => void }) {
  const { c } = useTheme()
  const [query, setQuery] = useState('')
  const sections = useMemo(() => projectSections(input.projects, input.projectGroups), [input.projects, input.projectGroups])
  const q = query.trim().toLowerCase()
  const shown = sections.map((s) => ({ ...s, projects: q ? s.projects.filter((p) => p.name.toLowerCase().includes(q)) : s.projects })).filter((s) => s.projects.length > 0)
  return (
    <>
      {input.projects.length > SEARCH_FROM ? (
        <View style={{ marginHorizontal: 16, marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 44, borderRadius: RADIUS.lg, backgroundColor: c.surface }}>
          <Icon name="search" size={16} color={c.textMuted} />
          <TextInput value={query} onChangeText={setQuery} placeholder={t('Search projects')} placeholderTextColor={c.textMuted} autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" accessibilityLabel={t('Search projects')} style={{ flex: 1, color: c.text, fontSize: 17, paddingVertical: 8 }} />
        </View>
      ) : null}
      {shown.length === 0 ? (
        <Text variant="body" tone="muted" style={{ paddingHorizontal: 20, paddingTop: 20 }}>
          {t('No projects match.')}
        </Text>
      ) : null}
      {shown.map((s) => (
        <Group key={s.id} title={s.name ?? undefined}>
          {s.projects.map((p, i) => (
            <Row key={p.id} label={p.name} detail={p.branch ?? undefined} selected={p.id === selected} onPress={() => onPick(p.id)} last={i === s.projects.length - 1} />
          ))}
        </Group>
      ))}
    </>
  )
}
