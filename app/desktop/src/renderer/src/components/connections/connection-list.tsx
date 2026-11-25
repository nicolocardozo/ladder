// The connection rows. State and commands come from the store and the host; the web preview replaces them with sample data.
// With `manageProfiles` (Settings → Subscriptions) Claude and Codex show one profile per row, with rename, remove and "Add account".
import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { ConnectionId, ConnectionStatus, Profile, ProfileAgent } from '@shared/protocol'
import { CONNECTION_ORDER, liveConnectionActions, type ConnectionActions } from '@/lib/connections'
import { hostProfileId, PROFILE_AGENTS, profilesOf } from '@/lib/profiles'
import { useApp } from '@/store/app-store'
import { ConnectionRow } from './connection-row'
import { AddProfile, ProfileRow, TrailingSpace } from './profile-parts'

/** Highlight of a row requested from outside: background only, no motion. */
const HIGHLIGHT = ['bg-accent/60', 'transition-colors']

export function ConnectionList({ statuses, profiles, profileStatuses, actions = liveConnectionActions, showTool, manageProfiles, focus, onFocused }: {
  /** Absent: reads the state from the store. */
  statuses?: Partial<Record<ConnectionId, ConnectionStatus>>
  /** Profiles and connections of the non-default profiles; absent: from the store. */
  profiles?: Profile[]
  profileStatuses?: Record<string, ConnectionStatus>
  actions?: ConnectionActions
  showTool?: boolean
  /** One profile per row and profile management (Settings). The first launch only shows the default connections. */
  manageProfiles?: boolean
  /** Row to move focus to (from the composer or the Merge panel). Absent: reads `connectionFocus` from the store. */
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
  /** Newly created profile: when its row has the "Sign in", focus goes there. State and not a ref: the effect restarts whatever the order of profile, state and `onCreated`. */
  const [created, setCreated] = useState<string | null>(null)

  /** Highlighted row: the timer doesn't depend on the focus effect (which restarts when the request is consumed), but stops on close. */
  const mark = useRef<{ row: HTMLElement; timer: number } | null>(null)
  const clearMark = () => {
    if (!mark.current) return
    window.clearTimeout(mark.current.timer)
    mark.current.row.classList.remove(...HIGHLIGHT)
    mark.current = null
  }
  useEffect(() => clearMark, [])

  // Focus goes to the row's button and the row scrolls into view; then the request is consumed (if Settings closes first, the dialog clears it).
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
    // "Sign in" appears when the new profile's state arrives: until then we wait.
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
