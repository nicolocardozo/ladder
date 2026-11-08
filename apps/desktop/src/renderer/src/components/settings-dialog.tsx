import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bell, Bot, Check, Moon, Palette, Plug, Sun, type LucideIcon } from 'lucide-react'
import type { AcpAgentSpec, AgentStatus, AppPrefs, RegistryAgent } from '@shared/protocol'
import { request } from '@/lib/host-client'
import { useApp } from '@/store/app-store'
import type { ThemeInfo } from '@shared/themes.generated'
import { LadderLockup } from '@/components/brand/logo'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { THEMES, useSettings, type SettingsSection } from '@/hooks/use-theme'
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
  { id: 'appearance', label: 'Aspetto', icon: Palette },
  { id: 'notifications', label: 'Notifiche', icon: Bell },
  { id: 'agents', label: 'Agenti', icon: Bot },
  { id: 'integrations', label: 'Integrazioni', icon: Plug }
]

export function SettingsDialog() {
  const open = useSettings((s) => s.settingsOpen)
  const setOpen = useSettings((s) => s.setSettingsOpen)
  const section = useSettings((s) => s.section)
  const setSection = useSettings((s) => s.setSection)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[86vh] w-[min(920px,calc(100vw-48px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[190px] shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-3" aria-label="Sezioni delle impostazioni">
            <LadderLockup className="mx-1 mt-1 mb-4 h-[18px] w-auto" title="Ladder" />
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={section === item.id ? 'page' : undefined}
                onClick={() => setSection(item.id)}
                className={cn(
                  'flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  section === item.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                )}
              >
                <item.icon className="size-4" strokeWidth={1.75} />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
            {section === 'appearance' && <AppearanceSection open={open} />}
            {section === 'notifications' && <NotificationsSection />}
            {section === 'agents' && <AgentsSection />}
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
            <DialogTitle className="text-[17px] font-semibold">Aspetto</DialogTitle>
            <DialogDescription className="mt-1 max-w-[60ch] text-[13px] text-muted-foreground">
              Il tema cambia chat, navigazione, pannelli e dialoghi in tutte le finestre e resta dopo il riavvio. Il marchio e l’icona dell’app restano Circuit.
            </DialogDescription>
            <div ref={grid} className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3" role="radiogroup" aria-label="Tema">
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
                      <span className={cn('text-[13px]', selected ? 'font-semibold' : 'font-medium')}>{theme.name}</span>
                      {theme.id === 'circuit' && <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">predefinito</span>}
                      <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
                        {theme.appearance === 'dark' ? <Moon className="size-3" /> : <Sun className="size-3" />}
                        {theme.appearance === 'dark' ? 'Scuro' : 'Chiaro'}
                      </span>
                      {selected && <Check className="size-3.5 text-primary" aria-label="Selezionato" />}
                    </span>
                  </button>
                )
              })}
            </div>
    </>
  )
}

function usePrefs(): [AppPrefs | null, (patch: Partial<AppPrefs>) => void] {
  const prefs = useApp((s) => s.prefs)
  const update = (patch: Partial<AppPrefs>) => {
    if (prefs) useApp.getState().setPrefs({ ...prefs, ...patch })
    void window.ladder?.prefs.set(patch).then((next) => useApp.getState().setPrefs(next))
  }
  return [prefs, update]
}

function Toggle({ label, description, checked, onChange, disabled }: { label: string; description: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cn('flex items-start gap-3 py-3', disabled && 'opacity-60')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary [color-scheme:light] dark:[color-scheme:dark]" />
      <span className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="text-[12.5px] text-muted-foreground">{description}</span>
      </span>
    </label>
  )
}

function NotificationsSection() {
  const [prefs, update] = usePrefs()
  if (!prefs) return <p className="text-[13px] text-muted-foreground">Le preferenze sono disponibili nell’app.</p>
  const dnd = Boolean(prefs.dndUntil && prefs.dndUntil > Date.now())
  return (
    <>
      <DialogTitle className="text-[17px] font-semibold">Notifiche</DialogTitle>
      <DialogDescription className="mt-1 max-w-[62ch] text-[13px] text-muted-foreground">
        Approvazioni e domande arrivano subito, tranne se stai guardando quella sessione. Le risposte pronte solo per turni oltre un minuto, se non sei nel progetto, raccolte per progetto. Il clic porta alla sessione e all’elemento.
      </DialogDescription>
      <div className="mt-4 flex max-w-[62ch] flex-col divide-y divide-border">
        <Toggle label="Notifiche di macOS" description="Le richieste restano comunque in “In attesa” e nel badge del Dock." checked={prefs.notifications} onChange={(notifications) => update({ notifications })} />
        <Toggle label="Suono per approvazioni e domande" description="Solo per ciò che blocca un agente; le risposte pronte restano silenziose." checked={prefs.sound} disabled={!prefs.notifications} onChange={(sound) => update({ sound })} />
        <Toggle
          label="Non disturbare per 1 ora"
          description={
            dnd
              ? `Attivo fino alle ${new Date(prefs.dndUntil!).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}. “In attesa” e il badge continuano a contare.`
              : 'Sospende le notifiche; “In attesa” e il badge continuano a contare. Anche dal menu Ladder e da ⌘K.'
          }
          checked={dnd}
          onChange={(on) => update({ dndUntil: on ? Date.now() + 60 * 60_000 : null })}
        />
        <TestNotification />
      </div>
    </>
  )
}

/** Banner vero di macOS: al primo uso il sistema chiede il permesso; il clic riporta su Ladder. */
function TestNotification() {
  const [state, setState] = useState<'idle' | 'sent' | 'unsupported'>('idle')
  return (
    <div className="flex items-start gap-3 py-3">
      <button
        type="button"
        onClick={() => void window.ladder?.testNotification().then((ok) => setState(ok ? 'sent' : 'unsupported'))}
        className="h-8 shrink-0 rounded-md border border-input px-3 text-[13px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Invia una notifica di prova
      </button>
      <p role="status" className="text-[12.5px] text-muted-foreground">
        {state === 'sent'
          ? 'Inviata. Se non la vedi, abilita Ladder in Impostazioni di sistema → Notifiche.'
          : state === 'unsupported'
            ? 'Questo Mac non accetta notifiche da Ladder.'
            : 'Arriva anche con “Non disturbare”. La prima volta macOS ti chiede il permesso.'}
      </p>
    </div>
  )
}

function AgentsSection() {
  const [prefs, update] = usePrefs()
  const agents = useApp((s) => s.agents)
  return (
    <>
      <DialogTitle className="text-[17px] font-semibold">Agenti</DialogTitle>
      <DialogDescription className="mt-1 max-w-[62ch] text-[13px] text-muted-foreground">
        Claude Code e Codex hanno un adapter nativo. Gli altri agenti parlano ACP, il protocollo aperto tra editor e agenti: per aggiungerne uno basta il comando che lo avvia.
      </DialogDescription>
      <div className="mt-4 flex max-w-[66ch] flex-col divide-y divide-border rounded-lg border border-border">
        {agents.map((agent) => (
          <AgentRow key={agent.agent} agent={agent} />
        ))}
      </div>
      {prefs && (
        <label className="mt-5 flex max-w-[66ch] items-center gap-3">
          <span className="flex flex-col">
            <span className="text-[13px] font-medium">Sessioni attive insieme per agente</span>
            <span className="text-[12px] text-muted-foreground">Oltre il limite le sessioni aspettano “In coda” e partono da sole. Le sessioni nel terminale non contano.</span>
          </span>
          <select
            value={prefs.maxActive}
            onChange={(e) => update({ maxActive: Number(e.target.value) })}
            className="ml-auto h-8 shrink-0 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
      <AddAcpAgent />
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
      <span aria-hidden className={cn('mt-[6px] size-2 shrink-0 rounded-full', agent.available ? 'bg-success' : 'bg-muted-foreground/50')} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium">{agent.name}</span>
          <span className="text-[11.5px] text-muted-foreground">{agent.kind === 'acp' ? 'ACP' : 'nativo'}</span>
          {agent.version && <span className="font-mono text-[11px] text-faint">v{agent.version}</span>}
        </span>
        <span className={cn('text-[12px]', agent.available ? 'text-muted-foreground' : 'text-destructive')}>
          {agent.available ? [agent.account, agent.models.length ? `${agent.models.length} modelli` : null, agent.limits].filter(Boolean).join(' · ') || 'Pronto' : agent.error}
        </span>
        {agent.path && <span className="truncate font-mono text-[11px] text-faint">{agent.path}</span>}
      </span>
      {agent.kind === 'acp' && (
        <button type="button" disabled={busy} onClick={() => void remove()} className="h-7 shrink-0 rounded-md border border-input px-2.5 text-[12.5px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50">
          Togli
        </button>
      )}
    </div>
  )
}

/** "Aggiungi un agente": dal registro ufficiale ACP o con un comando scritto a mano. */
function AddAcpAgent() {
  const [tab, setTab] = useState<'registry' | 'custom'>('registry')
  const [registry, setRegistry] = useState<RegistryAgent[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [commandLine, setCommandLine] = useState('')

  useEffect(() => {
    if (tab !== 'registry' || registry) return
    request<RegistryAgent[]>({ type: 'agents.registry' })
      .then(setRegistry)
      .catch((e: Error) => setProblem(`Registro ACP non raggiungibile: ${e.message}`))
  }, [tab, registry])

  const add = async (spec: AcpAgentSpec) => {
    setBusy(spec.id || 'custom')
    setProblem(null)
    try {
      await request({ type: 'agents.add', spec })
      setRegistry((list) => list?.map((r) => (r.id === spec.id ? { ...r, added: true } : r)) ?? null)
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

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = (registry ?? []).filter((r) => tokens.every((t) => `${r.name} ${r.id} ${r.description}`.toLowerCase().includes(t)))
  const words = commandLine.trim().split(/\s+/).filter(Boolean)

  return (
    <section className="mt-6 flex max-w-[66ch] flex-col gap-2">
      <div className="flex items-center gap-1">
        <h3 className="mr-2 text-[13px] font-semibold">Aggiungi un agente ACP</h3>
        {(['registry', 'custom'] as const).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={cn('h-7 rounded-md px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50', tab === id ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60')}
          >
            {id === 'registry' ? 'Dal registro' : 'Comando'}
          </button>
        ))}
      </div>
      {tab === 'registry' ? (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cerca: gemini, opencode, goose…"
            aria-label="Cerca nel registro ACP"
            className="h-8 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:border-ring"
          />
          <div className="max-h-[260px] overflow-y-auto rounded-lg border border-border">
            {!registry && !problem && <p className="px-3 py-3 text-[12.5px] text-muted-foreground">Leggo il registro…</p>}
            {shown.map((r) => (
              <div key={r.id} className="flex items-start gap-3 border-b border-border px-3 py-2 last:border-0">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px] font-medium">
                    {r.name} <span className="font-mono text-[11px] font-normal text-faint">v{r.version}</span>
                  </span>
                  <span className="line-clamp-2 text-[12px] text-muted-foreground">{r.description}</span>
                  <span className="truncate font-mono text-[11px] text-faint">
                    {r.command} {r.args.join(' ')}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={r.added || busy === r.id}
                  onClick={() => void add({ id: r.id, name: r.name, command: r.command, args: r.args, source: 'registry' })}
                  className="h-7 shrink-0 rounded-md border border-input px-2.5 text-[12.5px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
                >
                  {r.added ? 'Aggiunto' : busy === r.id ? 'Aggiungo…' : 'Aggiungi'}
                </button>
              </div>
            ))}
          </div>
          <p className="text-[11.5px] text-muted-foreground">Gli agenti si avviano con npx o uvx al primo uso; il login lo fa l’agente stesso. Quelli distribuiti solo come binari arriveranno più avanti.</p>
        </>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim() && words.length) void add({ id: '', name: name.trim(), command: words[0], args: words.slice(1), source: 'custom' })
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome, per esempio Gemini" aria-label="Nome dell’agente" className="h-8 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:border-ring" />
          <input
            value={commandLine}
            onChange={(e) => setCommandLine(e.target.value)}
            placeholder="Comando, per esempio gemini --experimental-acp"
            aria-label="Comando dell’agente"
            spellCheck={false}
            className="h-8 rounded-md border border-input bg-background px-2 font-mono text-[12.5px] outline-none focus-visible:border-ring"
          />
          <button type="submit" disabled={!name.trim() || words.length === 0 || busy !== null} className="h-8 self-start rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50">
            {busy ? 'Aggiungo…' : 'Aggiungi'}
          </button>
        </form>
      )}
      {problem && <p className="text-[12.5px] text-destructive">{problem}</p>}
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
      <DialogTitle className="text-[17px] font-semibold">Integrazioni</DialogTitle>
      <DialogDescription className="mt-1 max-w-[62ch] text-[13px] text-muted-foreground">
        Servono a “Nuova sessione da…” (⌘⇧N) e al pannello Merge.
      </DialogDescription>
      <div className="mt-5 flex max-w-[62ch] flex-col gap-5">
        <section className="flex flex-col gap-1">
          <h3 className="text-[13px] font-semibold">GitHub</h3>
          <p className="text-[12.5px] text-muted-foreground">
            Ladder usa la CLI <code className="font-mono">gh</code> con il suo login: issue, PR, CI e commenti si leggono da lì e Ladder non conserva token. Se manca: <code className="font-mono">brew install gh</code>, poi <code className="font-mono">gh auth login</code>.
          </p>
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold">Linear</h3>
          <p className="text-[12.5px] text-muted-foreground">
            Crea una chiave API personale in Linear (Impostazioni → Sicurezza e accesso) e incollala qui. Si salva cifrata nel portachiavi di macOS e si usa solo per leggere le tue issue.
          </p>
          {linear?.connected ? (
            <div className="flex items-center gap-2 text-[12.5px]">
              <Check aria-hidden className="size-3.5 text-success" />
              <span>Collegato come {linear.name}</span>
              <button type="button" disabled={busy} onClick={() => void save(null)} className="ml-auto h-7 rounded-md border border-input px-2.5 text-[12.5px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50">
                Scollega
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
                aria-label="Chiave API di Linear"
                autoComplete="off"
                spellCheck={false}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[12.5px] outline-none focus-visible:border-ring"
              />
              <button type="submit" disabled={busy || !key.trim()} className="h-8 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50">
                {busy ? 'Provo…' : 'Collega'}
              </button>
            </form>
          )}
          {linear?.error && <p className="text-[12.5px] text-destructive">{linear.error}</p>}
        </section>
      </div>
    </>
  )
}
