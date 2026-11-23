// Le righe dei collegamenti. Stato e comandi vengono dallo store e dall'host; l'anteprima web li sostituisce con dati di prova.
// Con `manageProfiles` (Impostazioni → Abbonamenti) Claude e Codex mostrano un profilo per riga, con rinomina, rimozione e "Add account".
import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { ConnectionId, ConnectionStatus, Profile, ProfileAgent } from '@shared/protocol'
import { CONNECTION_ORDER, liveConnectionActions, type ConnectionActions } from '@/lib/connections'
import { hostProfileId, PROFILE_AGENTS, profilesOf } from '@/lib/profiles'
import { useApp } from '@/store/app-store'
import { ConnectionRow } from './connection-row'
import { AddProfile, ProfileRow, TrailingSpace } from './profile-parts'

/** Evidenziazione di una riga richiesta da fuori: solo il fondo, niente movimento. */
const HIGHLIGHT = ['bg-accent/60', 'transition-colors']

export function ConnectionList({ statuses, profiles, profileStatuses, actions = liveConnectionActions, showTool, manageProfiles, focus, onFocused }: {
  /** Assente: legge lo stato dallo store. */
  statuses?: Partial<Record<ConnectionId, ConnectionStatus>>
  /** Profili e collegamenti dei profili non predefiniti; assenti: dallo store. */
  profiles?: Profile[]
  profileStatuses?: Record<string, ConnectionStatus>
  actions?: ConnectionActions
  showTool?: boolean
  /** Un profilo per riga e gestione dei profili (Impostazioni). Il primo avvio mostra solo i collegamenti predefiniti. */
  manageProfiles?: boolean
  /** Riga su cui portare il focus (dal composer o dal pannello Merge). Assente: legge `connectionFocus` dallo store. */
  focus?: { id: ConnectionId; profileId?: string | null; nonce: number; highlight?: boolean } | null
  onFocused?: (nonce: number) => void
}) {
  const stored = useApp((s) => s.connections)
  const storedProfiles = useApp((s) => s.profiles)
  const storedProfileStatuses = useApp((s) => s.profileConnections)
  const storedFocus = useApp((s) => s.connectionFocus)
  const list = statuses ?? stored
  const allProfiles = profiles ?? storedProfiles
  const profileList = profileStatuses ?? storedProfileStatuses
  const target = focus === undefined ? storedFocus : focus
  const root = useRef<HTMLDivElement>(null)
  /** Profilo appena creato: quando la sua riga ha il "Sign in", il focus va lì. Stato e non ref: l'effetto riparte quale che sia l'ordine fra profilo, stato e `onCreated`. */
  const [created, setCreated] = useState<string | null>(null)

  /** Riga evidenziata: il timer non dipende dall'effetto del focus (che riparte quando la richiesta si consuma), ma si ferma alla chiusura. */
  const mark = useRef<{ row: HTMLElement; timer: number } | null>(null)
  const clearMark = () => {
    if (!mark.current) return
    window.clearTimeout(mark.current.timer)
    mark.current.row.classList.remove(...HIGHLIGHT)
    mark.current = null
  }
  useEffect(() => clearMark, [])

  // Il focus va sul bottone della riga e la riga si porta in vista; poi la richiesta si consuma (se le Impostazioni si chiudono prima, la toglie il dialog).
  useEffect(() => {
    if (!target) return
    let consumed = false
    const consume = () => {
      if (consumed) return
      consumed = true
      if (onFocused) onFocused(target.nonce)
      else useApp.getState().consumeConnectionFocus(target.nonce)
    }
    const frame = requestAnimationFrame(() => {
      const row = root.current?.querySelector<HTMLElement>(`[data-connection="${target.id}"][data-profile="${hostProfileId(target.profileId) ?? 'default'}"]`)
      row?.scrollIntoView({ block: 'nearest' })
      const button = row?.querySelector<HTMLElement>('[data-primary]:not(:disabled)') ?? row?.querySelector<HTMLElement>('button:not(:disabled)')
      button?.focus()
      if (row && target.highlight) {
        clearMark()
        row.classList.add(...HIGHLIGHT)
        mark.current = { row, timer: window.setTimeout(clearMark, 1800) }
      }
      consume()
    })
    return () => cancelAnimationFrame(frame)
  }, [target, onFocused])

  useEffect(() => {
    const id = created
    if (!id) return
    const row = root.current?.querySelector<HTMLElement>(`[data-profile="${id}"]`)
    // Il "Sign in" compare quando arriva lo stato del nuovo profilo: finché manca si aspetta.
    const button = row?.querySelector<HTMLElement>('[data-primary]:not(:disabled)')
    if (!row || !button) return
    setCreated(null)
    row.scrollIntoView({ block: 'nearest' })
    button.focus()
  }, [created, allProfiles, profileList])

  return (
    <div ref={root} role="list" aria-label={t('Subscriptions')} className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {CONNECTION_ORDER.map((id) => {
        const agent = PROFILE_AGENTS.find((a) => a === id) as ProfileAgent | undefined
        if (!manageProfiles || !agent) {
          return (
            <div key={id} role="listitem">
              <ConnectionRow id={id} status={list[id] ?? null} actions={actions} showTool={showTool} trailing={manageProfiles ? <TrailingSpace /> : undefined} />
            </div>
          )
        }
        const own = profilesOf(allProfiles, agent)
        return (
          <div key={id} role="listitem" className="divide-y divide-border">
            {own.map((profile) => (
              <ProfileRow key={profile.id} agent={agent} profile={profile} count={own.length} status={(profile.isDefault ? list[agent] : profileList[profile.id]) ?? null} actions={actions} showTool={showTool} />
            ))}
            <AddProfile agent={agent} actions={actions} onCreated={(profile) => setCreated(profile.id)} />
          </div>
        )
      })}
    </div>
  )
}
