import { useEffect, useRef, useState } from 'react'
import { BadgeCheck, Bell, Bot, Check, Database, GitFork, Keyboard, Moon, Palette, Plug, SlidersHorizontal, Sun, type LucideIcon } from 'lucide-react'
import type { AcpAgentSpec, AgentStatus, AppPrefs, ChatFont } from '@shared/protocol'
import { request } from '@/lib/host-client'
import { getLocale, localeTag, LOCALES, plural, t } from '@shared/i18n'
import { AgentMark } from '@/components/agent-mark'
import { AgentCatalog } from '@/components/agents/agent-catalog'
import { liveAgentCatalogActions } from '@/lib/agent-catalog'
import { ConnectionList } from '@/components/connections/connection-list'
import { refreshConnections } from '@/lib/connections'
import { useApp } from '@/store/app-store'
import type { ThemeInfo } from '@shared/themes.generated'
import { LadderLockup } from '@/components/brand/logo'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { THEMES, useSettings, type SettingsSection } from '@/hooks/use-theme'
import { usePrefs } from '@/hooks/use-prefs'
import { useElementWidth } from '@/lib/use-element-width'
import { DefaultsSection } from '@/components/settings-defaults'
import { ShortcutsSection } from '@/components/settings-shortcuts'
import { Toggle } from '@/components/settings-parts'
import { ReadingBlocks } from '@/components/settings-reading'
import { SystemSection } from '@/components/settings-system'
import { WorkspaceSection } from '@/components/settings-workspace'
import { REQUEST_SOUNDS, system } from '@/lib/system-bridge'
import { cn } from '@/lib/utils'

/** Anteprima del tema con i suoi colori: sidebar, messaggio, risposta, richiesta, stati. */
function ThemePreview({ theme }: { theme: ThemeInfo }) {
  const t = theme.tokens
  return (
    <div className="flex h-[92px] overflow-hidden rounded-md" style={{ background: t.background, boxShadow: `inset 0 0 0 1px ${t.border}` }} aria-hidden>
      <div className="flex w-[30%] flex-col gap-1.5 p-2" style={{ background: t.sidebar, borderRight: `1px solid ${t.border}` }}>
        <span className="h-1.5 w-4/5 rounded-sm" style={{ background: t.textMuted, opacity: 0.6 }} />
        <span className="flex items-center gap-1">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: t.unread }} />
          <span className="h-1.5 flex-1 rounded-sm" style={{ background: t.text, opacity: 0.85 }} />
        </span>
        <span className="flex items-center gap-1 rounded-sm px-0.5 py-0.5" style={{ background: t.selection }}>
          <span className="size-1.5 shrink-0 rounded-full" style={{ border: `1.5px solid ${t.running}`, borderTopColor: 'transparent' }} />
          <span className="h-1.5 flex-1 rounded-sm" style={{ background: t.onSelection, opacity: 0.8 }} />
        </span>
        <span className="relative flex items-center gap-1 pl-1">
          <span className="absolute top-0 bottom-0 left-0 w-[2px]" style={{ background: t.waiting }} />
          <span className="h-1.5 flex-1 rounded-sm" style={{ background: t.textMuted, opacity: 0.7 }} />
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <span className="ml-auto h-3 w-3/5 rounded" style={{ background: t.surface, boxShadow: `inset 0 0 0 1px ${t.border}` }} />
        <span className="h-1.5 w-[90%] rounded-sm" style={{ background: t.text, opacity: 0.85 }} />
        <span className="h-1.5 w-[70%] rounded-sm" style={{ background: t.text, opacity: 0.85 }} />
        <span className="relative mt-auto flex h-5 items-center gap-1 rounded pl-2" style={{ background: t.surface, boxShadow: `inset 0 0 0 1px ${t.border}` }}>
          <span className="absolute top-1 bottom-1 left-1 w-[2px]" style={{ background: t.waiting }} />
          <span className="ml-1 h-1.5 w-1/3 rounded-sm" style={{ background: t.waiting }} />
          <span className="mr-1 ml-auto h-3 w-6 rounded-sm" style={{ background: t.accent }} />
        </span>
      </div>
    </div>
  )
}

type Section = SettingsSection

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'subscriptions', label: 'Subscriptions', icon: BadgeCheck },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'defaults', label: 'New sessions', icon: SlidersHorizontal },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'workspace', label: 'Workspace', icon: GitFork },
  { id: 'system', label: 'Data and system', icon: Database },
  { id: 'integrations', label: 'Integrations', icon: Plug }
]

export function SettingsDialog() {
  const open = useSettings((s) => s.settingsOpen)
  const setOpen = useSettings((s) => s.setSettingsOpen)
  const section = useSettings((s) => s.section)
  const setSection = useSettings((s) => s.setSection)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Dimensioni fisse: passando da una sezione all'altra la finestra non si muove. */}
      <DialogContent className="flex h-[min(760px,calc(100vh-48px))] w-[min(1120px,calc(100vw-48px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[210px] shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-3" aria-label={t('Settings sections')}>
            <LadderLockup className="mx-1 mt-1 mb-4 h-[18px] w-auto" title="Ladder" />
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                // Il focus all'apertura va sulla sezione aperta, non sulla prima dell'elenco.
                autoFocus={section === item.id && section !== 'appearance'}
                aria-current={section === item.id ? 'page' : undefined}
                onClick={() => setSection(item.id)}
                className={cn(
                  'flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  section === item.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                )}
              >
                <item.icon className="size-4" strokeWidth={1.75} />
                {t(item.label)}
              </button>
            ))}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-8 py-7">
            {section === 'appearance' && <AppearanceSection open={open} />}
            {section === 'notifications' && <NotificationsSection />}
            {section === 'subscriptions' && <SubscriptionsSection />}
            {section === 'agents' && <AgentsSection />}
            {section === 'defaults' && <DefaultsSection />}
            {section === 'shortcuts' && <ShortcutsSection />}
            {section === 'workspace' && <WorkspaceSection />}
            {section === 'system' && <SystemSection />}
            {section === 'integrations' && <IntegrationsSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AppearanceSection({ open }: { open: boolean }) {
  const current = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const grid = useRef<HTMLDivElement>(null)

  // All'apertura il focus va sul tema in uso, non sul primo della griglia.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  return (
    <>
            <div className="flex items-start justify-between gap-8">
              <div className="min-w-0">
                <DialogTitle className="text-xl font-semibold">{t('Appearance')}</DialogTitle>
                <DialogDescription className="mt-1 max-w-[60ch] text-sm text-muted-foreground">
                  {t('The theme changes chat, navigation, panels and dialogs in every window, and stays after a restart. The logo takes on the theme colors too; the app icon in the Dock stays Circuit.')}
                </DialogDescription>
              </div>
              <LanguagePicker />
            </div>
            <div ref={grid} className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3" role="radiogroup" aria-label={t('Theme')}>
              {THEMES.map((theme) => {
                const selected = theme.id === current
                return (
                  <button
                    key={theme.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setTheme(theme.id)}
                    className={cn(
                      'flex flex-col gap-2 rounded-lg border p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                      selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-input'
                    )}
                  >
                    <ThemePreview theme={theme} />
                    <span className="flex items-center gap-2 px-0.5 pb-0.5">
                      <span className={cn('text-sm', selected ? 'font-semibold' : 'font-medium')}>{theme.name}</span>
                      {theme.id === 'circuit' && <span className="rounded border border-border px-1 text-xs text-muted-foreground">{t('default')}</span>}
                      <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                        {theme.appearance === 'dark' ? <Moon className="size-3" /> : <Sun className="size-3" />}
                        {theme.appearance === 'dark' ? t('Dark') : t('Light')}
                      </span>
                      {selected && <Check className="size-3.5 text-primary" aria-label={t('Selected')} />}
                    </span>
                  </button>
                )
              })}
            </div>
            <ChatFontPicker />
            <ChatWidthPicker />
            <ReadingBlocks />
    </>
  )
}

const CHAT_FONTS: { id: ChatFont; label: string }[] = [
  { id: 'system-mono', label: 'System monospace' },
  { id: 'system-sans', label: 'System sans' },
  { id: 'mona-sans', label: 'Mona Sans' },
  { id: 'monaspace-neon', label: 'Monaspace Neon' }
]

/** Font della chat: solo risposte e messaggi, il resto dell'app non cambia. Ogni voce è resa nel suo font, sotto l'anteprima. */
function ChatFontPicker() {
  const [prefs, update] = usePrefs()
  if (!prefs) return null
  const current = prefs.chatFont
  return (
    <section className="mt-8" aria-labelledby="chat-font-title">
      <h3 id="chat-font-title" className="text-sm font-semibold">{t('Chat font')}</h3>
      <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">{t('Used for replies and your messages in every session. The rest of the app keeps its font.')}</p>
      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2" role="radiogroup" aria-label={t('Chat font')}>
        {CHAT_FONTS.map((font) => {
          const selected = font.id === current
          return (
            <button
              key={font.id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-chat-font={font.id}
              tabIndex={selected ? 0 : -1}
              onClick={() => update({ chatFont: font.id })}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
                if (!step) return
                e.preventDefault()
                const next = CHAT_FONTS[(CHAT_FONTS.indexOf(font) + step + CHAT_FONTS.length) % CHAT_FONTS.length]
                update({ chatFont: next.id })
                e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-chat-font='${next.id}']`)?.focus()
              }}
              className={cn(
                'flex h-9 items-center gap-2 rounded-md border px-3 text-left font-[family-name:var(--font-chat)] text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-input'
              )}
            >
              <span className={selected ? 'font-semibold' : 'font-medium'}>{t(font.label)}</span>
              {font.id === 'system-mono' && <span className="rounded border border-border px-1 font-sans text-xs text-muted-foreground">{t('default')}</span>}
              {selected && <Check className="ml-auto size-3.5 text-primary" aria-hidden="true" />}
            </button>
          )
        })}
      </div>
      <div data-chat-font={current} aria-label={t('Preview')} role="group" className="mt-3 rounded-lg border border-border p-4">
        <p className="max-w-[62ch] font-[family-name:var(--font-chat)] text-[length:var(--chat-size)] leading-[var(--chat-leading)] text-foreground">
          {t('The agent explains what it changed and why, in the font you picked.')}
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-[var(--code-bg)] px-3 py-2 font-mono text-xs leading-5 text-foreground">const total = items.reduce((sum, item) =&gt; sum + item.price, 0)</pre>
      </div>
    </section>
  )
}

/** Anteprima di una finestra larga 1200 px, rimpicciolita per stare nel dialogo: a scala reale 75, 100 ch e tutta la vista non si distinguerebbero. */
const PREVIEW_WINDOW = 1200
function WidthPreview({ width }: { width: AppPrefs['chatWidth'] }) {
  const [measure, frame] = useElementWidth()
  const zoom = frame > 0 ? Math.min(1, (frame - 2) / PREVIEW_WINDOW) : 1
  return (
    <div ref={measure} data-chat-width={width} aria-label={t('Preview')} role="group" className="mt-3 overflow-hidden rounded-lg border border-border">
      <div style={{ width: PREVIEW_WINDOW, zoom }} className="px-6 py-4">
        <div className="chat-measure">
          <p className="font-[family-name:var(--font-chat)] text-[length:var(--chat-size)] leading-[var(--chat-leading)] text-foreground">
            {t('Lines end where the width you picked says, so long answers stay easy to read in a narrow window and on a wide monitor alike. Code and tables below can use the whole window.')}
          </p>
        </div>
        <pre className="mt-3 overflow-hidden rounded-md border border-border bg-[var(--code-bg)] px-3 py-2 font-mono text-xs leading-5 text-foreground">const total = items.reduce((sum, item) =&gt; sum + item.price, 0)</pre>
      </div>
    </div>
  )
}

const CHAT_WIDTHS: { id: AppPrefs['chatWidth']; label: string; hint: string }[] = [
  { id: 'comfortable', label: 'Comfortable', hint: 'About 75 characters per line' },
  { id: 'wide', label: 'Wide', hint: 'About 100 characters per line' },
  { id: 'full', label: 'Full', hint: 'The whole width of the window' }
]

/** Larghezza della chat: limite del testo in caratteri del font scelto. Codice, tabelle e output dei comandi possono uscirne. */
function ChatWidthPicker() {
  const [prefs, update] = usePrefs()
  if (!prefs) return null
  const current = prefs.chatWidth
  return (
    <section className="mt-8" aria-labelledby="chat-width-title">
      <h3 id="chat-width-title" className="text-sm font-semibold">{t('Chat width')}</h3>
      <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">{t('How wide replies and your messages can get. Code, tables and command output may use more room. The message box follows the same width.')}</p>
      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2" role="radiogroup" aria-label={t('Chat width')}>
        {CHAT_WIDTHS.map((width) => {
          const selected = width.id === current
          return (
            <button
              key={width.id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-chat-width-option={width.id}
              tabIndex={selected ? 0 : -1}
              onClick={() => update({ chatWidth: width.id })}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
                if (!step) return
                e.preventDefault()
                const next = CHAT_WIDTHS[(CHAT_WIDTHS.indexOf(width) + step + CHAT_WIDTHS.length) % CHAT_WIDTHS.length]
                update({ chatWidth: next.id })
                e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-chat-width-option='${next.id}']`)?.focus()
              }}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-input'
              )}
            >
              <span className="flex w-full items-center gap-2 text-sm">
                <span className={selected ? 'font-semibold' : 'font-medium'}>{t(width.label)}</span>
                {width.id === 'comfortable' && <span className="rounded border border-border px-1 text-xs text-muted-foreground">{t('default')}</span>}
                {selected && <Check className="ml-auto size-3.5 text-primary" aria-hidden="true" />}
              </span>
              <span className="text-xs text-muted-foreground">{t(width.hint)}</span>
            </button>
          )
        })}
      </div>
      <WidthPreview width={current} />
    </section>
  )
}

/** Lingua dell'interfaccia: inglese per default. Cambia subito tutta l'app, senza riavviare. */
function LanguagePicker() {
  const [prefs, update] = usePrefs()
  const current = prefs?.locale ?? getLocale()
  return (
    <div className="flex shrink-0 items-center gap-3" role="radiogroup" aria-label={t('Language')}>
      <span className="text-sm font-medium">{t('Language')}</span>
      <div className="flex gap-1 rounded-md bg-muted p-0.5">
        {LOCALES.map((locale) => (
          <button
            key={locale.id}
            type="button"
            role="radio"
            aria-checked={current === locale.id}
            onClick={() => update({ locale: locale.id })}
            className={cn('h-7 rounded-sm px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50', current === locale.id ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}
          >
            {locale.name}
          </button>
        ))}
      </div>
    </div>
  )
}

function NotificationsSection() {
  const [prefs, update] = usePrefs()
  if (!prefs) return <p className="text-sm text-muted-foreground">{t('Preferences are available in the app.')}</p>
  const dnd = Boolean(prefs.dndUntil && prefs.dndUntil > Date.now())
  return (
    <>
      <DialogTitle className="text-xl font-semibold">{t('Notifications')}</DialogTitle>
      <DialogDescription className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
        {t('Approvals and questions arrive right away, unless you’re looking at that session. Finished replies only for turns over a minute, when you’re not in the project, grouped by project. Clicking takes you to the session and the item.')}
      </DialogDescription>
      <div className="mt-6 flex flex-col divide-y divide-border rounded-lg border border-border">
        <Toggle label={t('macOS notifications')} description={t('Requests still stay in “Waiting” and in the Dock badge.')} checked={prefs.notifications} onChange={(notifications) => update({ notifications })} />
        <Toggle label={t('Sound for approvals and questions')} description={t('Only for what blocks an agent; finished replies stay silent.')} checked={prefs.sound} disabled={!prefs.notifications} onChange={(sound) => update({ sound })} />
        <SoundRow />
        <Toggle
          label={t('Do Not Disturb for 1 hour')}
          description={
            dnd
              ? t('On until {time}. “Waiting” and the badge keep counting.', { time: new Date(prefs.dndUntil!).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }) })
              : t('Pauses notifications; “Waiting” and the badge keep counting. Also from the Ladder menu and ⌘K.')
          }
          checked={dnd}
          onChange={(on) => update({ dndUntil: on ? Date.now() + 60 * 60_000 : null })}
        />
        <TestNotification />
      </div>
    </>
  )
}

/** Suono delle richieste: uno dei suoni di sistema di macOS, con prova. Vale quando il suono è acceso. */
function SoundRow() {
  const [prefs, update] = usePrefs()
  const [note, setNote] = useState<string | null>(null)
  if (!prefs) return null
  const off = !prefs.notifications || !prefs.sound
  const play = async () => {
    setNote(null)
    if (await system.playSound(prefs.soundName)) return
    // Il suono predefinito non ha un file da riprodurre, e fuori dall'app installata la pagina può non leggere quelli di sistema:
    // il banner di prova usa il suono scelto.
    const sent = await system.testNotification()
    setNote(sent ? t('Played with a test notification.') : t('This Mac doesn’t accept notifications from Ladder.'))
  }
  return (
    <div className={cn('flex items-center justify-between gap-6 px-4 py-3.5', off && 'opacity-60')}>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{t('Sound')}</span>
        <span role="status" className="text-sm text-muted-foreground">
          {note ?? t('The sound for approvals and questions. “Default” is the macOS notification sound.')}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <Select value={prefs.soundName} disabled={off} onValueChange={(value) => update({ soundName: value as AppPrefs['soundName'] })}>
          <SelectTrigger aria-label={t('Sound')} className="w-[140px]">
            <SelectValue>{(value: string) => (value === 'default' ? t('Default') : value)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {REQUEST_SOUNDS.map((name) => (
              <SelectItem key={name} value={name}>
                {name === 'default' ? t('Default') : name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button type="button" disabled={off} onClick={() => void play()} className="h-8 shrink-0 rounded-md border border-input px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50">
          {t('Play')}
        </button>
      </div>
    </div>
  )
}

/** Banner vero di macOS: al primo uso il sistema chiede il permesso; il clic riporta su Ladder. */
function TestNotification() {
  const [state, setState] = useState<'idle' | 'sent' | 'unsupported'>('idle')
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <p role="status" className="text-sm text-muted-foreground">
        {state === 'sent'
          ? t('Sent. If you don’t see it, enable Ladder in System Settings → Notifications.')
          : state === 'unsupported'
            ? t('This Mac doesn’t accept notifications from Ladder.')
            : t('It arrives even with “Do Not Disturb” on. The first time, macOS asks for permission.')}
      </p>
      <button
        type="button"
        onClick={() => void window.ladder?.testNotification().then((ok) => setState(ok ? 'sent' : 'unsupported'))}
        className="h-8 shrink-0 rounded-md border border-input px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {t('Send a test notification')}
      </button>
    </div>
  )
}

/** Claude, ChatGPT / Codex e GitHub: stato, account, accesso dal browser, esci e cambia account. Qui si torna dal primo avvio. */
function SubscriptionsSection() {
  // Lo stato può essere cambiato fuori da Ladder (logout dal Terminale): all'apertura si rilegge.
  useEffect(() => refreshConnections(), [])
  return (
    <>
      <DialogTitle className="text-xl font-semibold">{t('Subscriptions')}</DialogTitle>
      <DialogDescription className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
        {t('Sign in with the plans you already pay for. Ladder opens your browser and you come back connected, without installing anything or using the Terminal.')}
      </DialogDescription>
      <div className="mt-6 max-w-[640px]">
        <ConnectionList showTool manageProfiles />
      </div>
    </>
  )
}

function AgentsSection() {
  const [prefs, update] = usePrefs()
  const agents = useApp((s) => s.agents)
  return (
    <>
      <DialogTitle className="text-xl font-semibold">{t('Agents')}</DialogTitle>
      <DialogDescription className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
        {t('Claude Code and Codex have a native adapter. Other agents speak ACP, the open protocol between editors and agents: to add one, all you need is the command that starts it.')}
      </DialogDescription>
      <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-start gap-8">
        <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {agents.map((agent) => (
          <AgentRow key={agent.agent} agent={agent} />
        ))}
      </div>
      {prefs && (
        <div className="flex items-center gap-3">
          <span className="flex flex-col">
            <span className="text-sm font-medium">{t('Concurrent sessions per agent')}</span>
            <span className="text-xs text-muted-foreground">{t('Beyond the limit, sessions wait as “Queued” and start on their own. Terminal sessions don’t count.')}</span>
          </span>
          <Select value={prefs.maxActive} onValueChange={(value) => update({ maxActive: Number(value) })}>
            <SelectTrigger aria-label={t('Concurrent sessions per agent')} className="ml-auto w-[68px] shrink-0">
              <SelectValue className="tabular-nums" />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <SelectItem key={n} value={n}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {prefs && (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          <Toggle
            label={t('Ask agents to keep going on long tasks (Edit and Full access)')}
            description={t('Adds a short note so agents work through the task instead of stopping to ask. Applies to new sessions.')}
            checked={prefs.autonomyHint}
            onChange={(autonomyHint) => update({ autonomyHint })}
          />
          <Toggle
            label={t('Flag turns that stop without asking')}
            description={t('Experimental. Marks a turn that ends with no changes, commands or questions, and offers to tell the agent to keep going.')}
            checked={prefs.stallHint}
            onChange={(stallHint) => update({ stallHint })}
          />
        </div>
      )}
        </div>
      <AddAcpAgent />
      </div>
    </>
  )
}

function AgentRow({ agent }: { agent: AgentStatus }) {
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    await request({ type: 'agents.remove', id: agent.agent.replace(/^acp:/, '') }).catch(() => undefined)
    setBusy(false)
  }
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <AgentMark agent={agent.agent} size={18} className={cn('mt-0.5', agent.available ? 'text-foreground' : 'text-muted-foreground')} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{agent.name}</span>
          {!agent.available && <span className="text-xs font-medium text-destructive">{t('not available')}</span>}
          <span className="text-xs text-muted-foreground">{agent.kind === 'acp' ? 'ACP' : t('native')}</span>
          {agent.version && <span className="font-mono text-xs text-faint">v{agent.version}</span>}
        </span>
        <span className={cn('text-xs', agent.available ? 'text-muted-foreground' : 'text-destructive')}>
          {agent.available ? [agent.account, agent.email, agent.models.length ? plural(agent.models.length, '{n} model', '{n} models') : null, agent.limits].filter(Boolean).join(' · ') || t('Ready') : agent.error}
        </span>
        {agent.path && <span className="truncate font-mono text-xs text-faint">{agent.path}</span>}
      </span>
      {agent.kind === 'acp' && (
        <button type="button" disabled={busy} onClick={() => void remove()} className="h-7 shrink-0 rounded-md border border-input px-2.5 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50">
          {t('Remove')}
        </button>
      )}
    </div>
  )
}

/** "Aggiungi un agente": dal registro ufficiale ACP o con un comando scritto a mano. */
function AddAcpAgent() {
  const [tab, setTab] = useState<'registry' | 'custom'>('registry')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [commandLine, setCommandLine] = useState('')

  const add = async (spec: AcpAgentSpec) => {
    setBusy(spec.id || 'custom')
    setProblem(null)
    try {
      await request({ type: 'agents.add', spec })
      if (spec.source === 'custom') {
        setName('')
        setCommandLine('')
      }
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const words = commandLine.trim().split(/\s+/).filter(Boolean)

  return (
    <section className="col-span-full flex min-w-0 max-w-[720px] flex-col gap-2">
      <div className="flex items-center gap-1">
        <h3 className="mr-2 text-sm font-semibold">{t('Add an agent')}</h3>
        {(['registry', 'custom'] as const).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={cn('h-7 rounded-md px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50', tab === id ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60')}
          >
            {id === 'registry' ? t('Catalog') : t('Command')}
          </button>
        ))}
      </div>
      {tab === 'registry' ? (
        <AgentCatalog actions={liveAgentCatalogActions} />
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim() && words.length) void add({ id: '', name: name.trim(), command: words[0], args: words.slice(1), source: 'custom' })
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Name, e.g. Gemini')} aria-label={t('Agent name')} className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring" />
          <input
            value={commandLine}
            onChange={(e) => setCommandLine(e.target.value)}
            placeholder={t('Command, e.g. gemini --experimental-acp')}
            aria-label={t('Agent command')}
            spellCheck={false}
            className="h-8 rounded-md border border-input bg-background px-2 font-mono text-sm outline-none focus-visible:border-ring"
          />
          <button type="submit" disabled={!name.trim() || words.length === 0 || busy !== null} className="h-8 self-start rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50">
            {busy ? t('Adding…') : t('Add')}
          </button>
        </form>
      )}
      {problem && <p className="text-sm text-destructive">{problem}</p>}
    </section>
  )
}

function IntegrationsSection() {
  const [linear, setLinear] = useState<{ connected: boolean; name: string | null; error: string | null } | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.ladder?.linear.status().then(setLinear)
  }, [])
  const save = async (value: string | null) => {
    setBusy(true)
    try {
      const status = await window.ladder?.linear.setKey(value)
      if (status) setLinear(status)
      if (status?.connected || value === null) setKey('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DialogTitle className="text-xl font-semibold">{t('Integrations')}</DialogTitle>
      <DialogDescription className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
        {t('Used by “New session from…” (⌘⇧N) and the Merge panel.')}
      </DialogDescription>
      <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-start gap-4">
        <section className="flex flex-col gap-1 rounded-lg border border-border p-4">
          <h3 className="text-sm font-semibold">GitHub</h3>
          <p className="text-sm text-muted-foreground">{t('GitHub is connected from Subscriptions: Ladder signs in with your browser and keeps no tokens of its own.')}</p>
          <button
            type="button"
            onClick={() => useApp.getState().focusConnection('github')}
            className="mt-1 h-7 self-start rounded-md border border-input px-2.5 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {t('Open Subscriptions')}
          </button>
        </section>
        <section className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <h3 className="text-sm font-semibold">Linear</h3>
          <p className="text-sm text-muted-foreground">
            {t('Create a personal API key in Linear (Settings → Security & access) and paste it here. It’s stored encrypted in the macOS Keychain and only used to read your issues.')}
          </p>
          {linear?.connected ? (
            <div className="flex items-center gap-2 text-sm">
              <Check aria-hidden className="size-3.5 text-success" />
              <span>{t('Connected as {name}', { name: linear.name ?? '' })}</span>
              <button type="button" disabled={busy} onClick={() => void save(null)} className="ml-auto h-7 rounded-md border border-input px-2.5 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50">
                {t('Disconnect')}
              </button>
            </div>
          ) : (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (key.trim()) void save(key)
              }}
            >
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="lin_api_…"
                aria-label={t('Linear API key')}
                autoComplete="off"
                spellCheck={false}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-sm outline-none focus-visible:border-ring"
              />
              <button type="submit" disabled={busy || !key.trim()} className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50">
                {busy ? t('Checking…') : t('Connect')}
              </button>
            </form>
          )}
          {linear?.error && <p className="text-sm text-destructive">{linear.error}</p>}
        </section>
      </div>
    </>
  )
}
