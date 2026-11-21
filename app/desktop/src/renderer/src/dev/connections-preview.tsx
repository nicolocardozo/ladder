// Anteprima di "Collega i tuoi abbonamenti" e di Impostazioni → Abbonamenti, con un host finto:
// l'accesso scorre davvero i passi (download, verifica, browser, fine) e si può annullare, uscire o cambiare account.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionId, ConnectionStatus, Profile, ProfileAgent } from '@shared/protocol'
import { AccountButton } from '@/components/app-sidebar'
import { ConnectionList } from '@/components/connections/connection-list'
import { Onboarding } from '@/components/connections/onboarding'
import { SignInNotice } from '@/components/connections/sign-in-notice'
import { connectionKey, type ConnectionActions } from '@/lib/connections'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { t } from '@shared/i18n'
import { CONNECTION_SCENARIOS, connectionAgents, connectionScenario, PREVIEW_PROFILES, previewProfileAgents, previewProfileConnections, type ConnectionScenario, type ConnectionSet } from './fixtures'

const btn = 'h-7 rounded-md border border-input px-2.5 text-[12px] text-secondary-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50'

const ACCOUNT: Record<ConnectionId, Partial<ConnectionStatus>> = {
  'claude-code': { plan: 'Max', email: 'alex@example.com' },
  codex: { plan: 'Plus', email: 'alex@example.com' },
  github: { user: 'alex-dev' }
}

export function ConnectionsPreview() {
  const [scenario, setScenario] = useState<ConnectionScenario>('first-run')
  const [statuses, setStatuses] = useState<ConnectionSet>(() => connectionScenario('first-run'))
  const [screen, setScreen] = useState<'onboarding' | 'settings'>('onboarding')
  // Profili (LAD-23): due account Claude e uno Codex; i collegamenti dei non predefiniti stanno a parte, per id del profilo.
  const [profiles, setProfiles] = useState<Profile[]>(PREVIEW_PROFILES)
  const [profileStatuses, setProfileStatuses] = useState<Record<string, ConnectionStatus>>(() => previewProfileConnections('first-run'))
  const timers = useRef<Record<string, number[]>>({})
  const created = useRef(0)

  const patch = useCallback((id: ConnectionId, change: Partial<ConnectionStatus>, profileId?: string) => {
    if (profileId) setProfileStatuses((s) => ({ ...s, [profileId]: { ...s[profileId], ...change } }))
    else setStatuses((s) => ({ ...s, [id]: { ...s[id], ...change } }))
  }, [])
  const clear = (key: string) => {
    timers.current[key]?.forEach((timer) => window.clearTimeout(timer))
    timers.current[key] = []
  }
  useEffect(() => () => Object.keys(timers.current).forEach(clear), [])

  // Le stesse viste dell'app leggono lo store: lo si tiene allineato (notice sopra il composer, pulsante dell'account).
  useEffect(() => {
    useApp.setState({ connections: statuses, agents: connectionAgents(statuses), profiles, profileConnections: profileStatuses, profileAgents: previewProfileAgents(profileStatuses) })
  }, [statuses, profiles, profileStatuses])

  const choose = (next: ConnectionScenario) => {
    Object.keys(timers.current).forEach(clear)
    setScenario(next)
    setStatuses(connectionScenario(next))
    setProfiles(PREVIEW_PROFILES)
    setProfileStatuses(previewProfileConnections(next))
    // Le simulazioni in corso nel set di prova ripartono da dove stanno: il download avanza da solo.
    if (next === 'downloading') simulate('codex', true, connectionScenario(next).codex.login)
  }

  /** Passi dell'accesso con tempi brevi: download (se manca lo strumento), verifica, installazione, browser, fine. */
  const simulate = (id: ConnectionId, download: boolean, from?: ConnectionStatus['login'], profileId?: string) => {
    const key = connectionKey(id, profileId)
    clear(key)
    const later = (ms: number, fn: () => void) => (timers.current[key] ??= []).push(window.setTimeout(fn, ms))
    const step = (stage: NonNullable<ConnectionStatus['login']>['stage'], extra: Partial<NonNullable<ConnectionStatus['login']>> = {}) =>
      patch(id, { error: null, login: { stage, progress: null, bytes: null, total: null, url: null, code: null, ...extra } }, profileId)
    let at = 0
    if (download) {
      const total = 350_000_000
      const start = from?.progress ?? 0
      for (let p = Math.round(start * 10); p <= 10; p++) {
        later((at += 450), () => step('downloading', { progress: p / 10, bytes: Math.round((total * p) / 10), total }))
      }
      later((at += 700), () => step('verifying'))
      later((at += 900), () => step('installing'))
      later((at += 900), () => patch(id, { state: 'unauthenticated', source: 'downloaded', version: '0.58.0' }, profileId))
    }
    later((at += 400), () => step('waiting-browser', { url: 'https://example.com/login', code: id === 'github' ? 'ABCD-1234' : null }))
    later((at += 3200), () => step('finishing'))
    later((at += 900), () => patch(id, { ...ACCOUNT[id], ...(profileId ? { plan: 'Pro', email: 'alex@studio-example.it' } : {}), state: 'connected', login: null, error: null, source: id === 'claude-code' ? 'bundled' : 'downloaded', version: statusesVersion(id) }, profileId))
  }
  const statusesVersion = (id: ConnectionId) => (id === 'claude-code' ? '2.1.4' : id === 'codex' ? '0.58.0' : '2.62.0')

  const actions: ConnectionActions = {
    login: (id, switchAccount, profileId) => {
      if (switchAccount) patch(id, { state: 'unauthenticated', plan: null, email: null, user: null }, profileId)
      const current = profileId ? profileStatuses[profileId] : statuses[id]
      simulate(id, current?.state === 'missing', undefined, profileId)
    },
    cancel: (id, profileId) => {
      clear(connectionKey(id, profileId))
      patch(id, { login: null, error: t('Login cancelled.') }, profileId)
    },
    logout: (id, profileId) => patch(id, { state: 'unauthenticated', plan: null, email: null, user: null, error: null }, profileId),
    // Host finto: i nomi sono unici per agente, come in quello vero.
    createProfile: async (agent: ProfileAgent, name) => {
      if (profiles.some((p) => p.agent === agent && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`An account named “${name}” already exists.`)
      const profile: Profile = { id: `${agent}-new-${++created.current}`, agent, name, configDir: `/tmp/ladder/profiles/${agent}-${created.current}`, isDefault: false, addedAt: Date.now() }
      setProfiles((list) => [...list, profile])
      setProfileStatuses((s) => ({ ...s, [profile.id]: { ...connectionScenario('first-run')[agent], profileId: profile.id, state: 'unauthenticated', source: 'bundled', version: '2.1.4' } }))
      return profile
    },
    renameProfile: async (profileId, name) => {
      const current = profiles.find((p) => p.id === profileId)!
      if (profiles.some((p) => p.id !== profileId && p.agent === current.agent && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`An account named “${name}” already exists.`)
      const profile = { ...current, name }
      setProfiles((list) => list.map((p) => (p.id === profileId ? profile : p)))
      return profile
    },
    removeProfile: async (profileId) => {
      setProfiles((list) => list.filter((p) => p.id !== profileId))
      setProfileStatuses(({ [profileId]: _gone, ...rest }) => rest)
    }
  }

  return (
    <div className="flex w-[900px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {CONNECTION_SCENARIOS.map((item) => (
          <button key={item.id} type="button" aria-pressed={scenario === item.id} onClick={() => choose(item.id)} className={cn(btn, scenario === item.id && 'border-ring/60 bg-accent text-foreground')}>
            {item.label}
          </button>
        ))}
        <span className="flex-1" />
        {(['onboarding', 'settings'] as const).map((id) => (
          <button key={id} type="button" aria-pressed={screen === id} onClick={() => setScreen(id)} className={cn(btn, screen === id && 'border-ring/60 bg-accent text-foreground')}>
            {id === 'onboarding' ? 'Schermata di primo avvio' : 'Impostazioni → Abbonamenti'}
          </button>
        ))}
      </div>
      <div className="flex h-[700px] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-[0_18px_44px_rgb(3_8_20/0.25)]">
        {screen === 'onboarding' ? (
          <div className="flex min-h-0 flex-1">
            <Onboarding key={scenario} statuses={statuses} actions={actions} onDone={() => setScreen('settings')} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-7">
            <div>
              <h2 className="text-xl font-semibold">{t('Subscriptions')}</h2>
              <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
                {t('Sign in with the plans you already pay for. Ladder opens your browser and you come back connected, without installing anything or using the Terminal.')}
              </p>
            </div>
            <div className="max-w-[640px]">
              <ConnectionList statuses={statuses} profiles={profiles} profileStatuses={profileStatuses} actions={actions} showTool manageProfiles focus={null} />
            </div>
            <div className="flex max-w-[640px] flex-col gap-2">
              <p className="text-xs text-muted-foreground">Sopra il composer, con l’agente non collegato</p>
              <SignInNotice agent="claude-code" />
              <SignInNotice agent="codex" />
            </div>
            <div className="flex max-w-[264px] flex-col gap-2">
              <p className="text-xs text-muted-foreground">Pulsante dell’account nella sidebar</p>
              <div className="flex rounded-lg bg-sidebar p-2">
                <AccountButton />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
