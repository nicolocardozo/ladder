// Settings → Subscriptions → "Other agents": the installed CLIs (Gemini, Copilot, Cursor and the like) with their sign-in state.
// Ladder never sees the credentials: sign-in and sign-out run in Ladder's terminal with the agent's CLI, and the host re-reads the state
// when the process exits (`agent.connection` event, which updates the row without reopening Settings).
import { useEffect, useRef, useState } from 'react'
import { Check, CircleDashed, CircleHelp, Loader2, RotateCw, SquareTerminal } from 'lucide-react'
import type { OtherAgentConnection } from '@shared/protocol'
import { t } from '@shared/i18n'
import { MaskIcon, otherAgentIcon } from '@/components/agent-mark'
import { Button } from '@/components/ui/button'
import { useSettings } from '@/hooks/use-theme'
import { loadOtherAgents, loginOtherAgent, logoutOtherAgent, refreshOtherAgent, showOtherAgentTerminal } from '@/lib/other-agents'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'
import { ROW_ACTIONS_PLAIN, ROW_GRID_PLAIN, SIGN_OUT } from './connection-row'
import { TrailingSpace } from './profile-parts'

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t('Something went wrong. Try again.')
}

/** List of Other agents. Only installed CLIs: the others are added from Agents. */
export function OtherAgents() {
  const rows = useApp((s) => s.otherAgents)
  const [failed, setFailed] = useState(false)
  // lib/other-agents reads the list once; here we only retry if the read failed. Rows update with events and «Check again».
  useEffect(() => {
    setFailed(false)
    loadOtherAgents().catch(() => setFailed(true))
  }, [])
  const installed = (rows ?? []).filter((row) => row.installed)

  if (!rows) {
    return (
      <p role="status" className="mt-3 flex items-center gap-2 rounded-lg border border-border px-4 py-3.5 text-sm text-muted-foreground">
        {failed ? (
          t('Couldn’t read the other agents. Try again in a moment.')
        ) : (
          <>
            <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
            {t('Looking for agents on your Mac…')}
          </>
        )}
      </p>
    )
  }
  if (installed.length === 0) {
    return (
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg border border-border px-4 py-3.5">
        <p className="text-sm text-muted-foreground">{t('No other agent is installed on this Mac. Add more agents in Agents.')}</p>
        <Button variant="outline" size="sm" className="text-sm" onClick={() => useSettings.getState().setSection('agents')}>
          {t('Open Agents')}
        </Button>
      </div>
    )
  }
  return (
    <div role="list" aria-label={t('Other agents')} className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border">
      {installed.map((agent) => (
        <div key={agent.id} role="listitem">
          <OtherAgentRow agent={agent} />
        </div>
      ))}
    </div>
  )
}

function OtherAgentRow({ agent }: { agent: OtherAgentConnection }) {
  const [busy, setBusy] = useState<'refresh' | 'login' | 'logout' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const inTerminal = agent.terminalId !== null
  // The terminal may already be closed in the UI while the host hasn't said so yet: without a terminal there is nothing to show.
  const terminalOpen = useApp((s) => agent.terminalId !== null && s.terminals[agent.terminalId] !== undefined)
  // Without a sign-in command or a CLI to open (ACP-only program): no button, sign-in happens from the app or the agent's CLI.
  const noSignIn = agent.loginCommand === null && agent.openCommand === null
  // A check in progress with a still unknown state: only "Checking…". With an already known state, it stays and the check is added.
  const checkingOnly = agent.probing && agent.auth === 'unknown'
  const signIn = agent.loginCommand !== null ? t('Sign in') : t('Open terminal')

  // The text button «Check again» disappears while the state is unknown and the check runs: if focus was there, it returns to the button
  // that remains (the icon) once the check is done and a button is back.
  const wantRefocus = useRef(false)
  useEffect(() => {
    if (!wantRefocus.current || busy !== null || agent.probing) return
    const id = requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-agent-refresh="${CSS.escape(agent.id)}"]`)
      if (!target) return
      wantRefocus.current = false
      if (!document.activeElement || document.activeElement === document.body) target.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [busy, agent.probing, agent.auth, agent.id])

  function run(kind: 'refresh' | 'login' | 'logout', command: () => Promise<void>): void {
    wantRefocus.current = kind === 'refresh' && document.activeElement?.closest('[data-agent-refresh]') != null
    setBusy(kind)
    setError(null)
    command()
      .catch((e) => mounted.current && setError(messageOf(e)))
      .finally(() => mounted.current && setBusy(null))
  }

  const state = inTerminal ? (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
      {t('In the terminal')}
    </span>
  ) : checkingOnly ? (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
      {t('Checking…')}
    </span>
  ) : agent.auth === 'connected' ? (
    <span className="inline-flex items-center gap-1 text-xs text-success">
      <Check aria-hidden className="size-3" />
      {t('Connected')}
    </span>
  ) : agent.auth === 'needs-login' ? (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <CircleDashed aria-hidden className="size-3" />
      {t('Needs sign-in')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <CircleHelp aria-hidden className="size-3" />
      {t('Not checked')}
    </span>
  )

  const detail = inTerminal ? (
    t('Finish in the terminal. This row updates when you are done.')
  ) : agent.auth === 'connected' ? (
    agent.account ? t('Signed in as {account}', { account: agent.account }) : t('Ready to use.')
  ) : noSignIn ? (
    t('Sign in from the agent’s own app or CLI')
  ) : agent.auth === 'needs-login' ? (
    agent.loginCommand ? (
      <>
        {t('Sign in with')} <code className="rounded-sm bg-muted px-1 font-mono text-foreground">{agent.loginCommand}</code>
      </>
    ) : (
      t('Ladder opens {name} in a terminal and you sign in from there.', { name: agent.name })
    )
  ) : (
    t('Ladder couldn’t tell whether {name} is signed in.', { name: agent.name })
  )

  return (
    <div data-other-agent={agent.id} data-auth={agent.auth} className={cn(ROW_GRID_PLAIN, 'px-4 py-3.5')}>
      <MaskIcon icon={otherAgentIcon(agent)} name={agent.name} size={18} className="mt-0.5 text-foreground" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{agent.name}</span>
          {state}
          {agent.probing && !checkingOnly && !inTerminal && (
            <span role="status" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
              {t('Checking…')}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{detail}</p>
        {agent.auth === 'connected' && !agent.logoutCommand && agent.logoutHelp && <p className="text-xs text-muted-foreground">{agent.logoutHelp}</p>}
        <p className="truncate text-xs text-faint" title={agent.path ?? undefined}>
          {[t('Installed'), agent.version ? `v${agent.version}` : null].filter(Boolean).join(' · ')}
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className={ROW_ACTIONS_PLAIN}>
        {inTerminal ? (
          terminalOpen && (
            <Button
              data-primary
              variant="outline"
              size="sm"
              className="text-sm"
              aria-label={t('Show the terminal of {name}', { name: agent.name })}
              onClick={() => {
                if (agent.terminalId && !showOtherAgentTerminal(agent.terminalId)) setError(t('The terminal is already closed.'))
              }}
            >
              <SquareTerminal aria-hidden />
              {t('Show terminal')}
            </Button>
          )
        ) : (
          <>
            {agent.auth === 'unknown' && (
              <Button
                data-primary
                data-agent-refresh={agent.id}
                variant="outline"
                size="sm"
                className="text-sm aria-disabled:pointer-events-none aria-disabled:opacity-50"
                aria-disabled={busy !== null || agent.probing}
                aria-label={t('Check {name} again', { name: agent.name })}
                onClick={() => {
                  // aria-disabled and not disabled: the button keeps focus during the check.
                  if (busy === null && !agent.probing) run('refresh', () => refreshOtherAgent(agent.id))
                }}
              >
                {t('Check again')}
              </Button>
            )}
            {agent.auth !== 'connected' && !noSignIn && (
              <Button
                data-primary={agent.auth === 'needs-login' ? '' : undefined}
                variant={agent.auth === 'needs-login' ? 'outline' : 'ghost'}
                size="sm"
                className="text-sm"
                disabled={busy !== null}
                aria-label={agent.loginCommand !== null ? t('Sign in to {name}', { name: agent.name }) : t('Open {name} in a terminal', { name: agent.name })}
                onClick={() => run('login', () => loginOtherAgent(agent.id))}
              >
                {busy === 'login' && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
                {signIn}
              </Button>
            )}
            {agent.auth === 'connected' && agent.logoutCommand && (
              <Button variant="ghost" size="sm" className={SIGN_OUT} disabled={busy !== null} aria-label={t('Sign out of {name}', { name: agent.name })} onClick={() => run('logout', () => logoutOtherAgent(agent.id))}>
                {t('Sign out')}
              </Button>
            )}
            {agent.auth !== 'unknown' ? (
              <Button
                data-agent-refresh={agent.id}
                variant="ghost"
                size="icon-sm"
                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                aria-disabled={busy !== null || agent.probing}
                aria-label={t('Check {name} again', { name: agent.name })}
                title={t('Check again')}
                onClick={() => {
                  if (busy === null && !agent.probing) run('refresh', () => refreshOtherAgent(agent.id))
                }}
              >
                <RotateCw aria-hidden className={cn((busy === 'refresh' || agent.probing) && 'animate-spin motion-reduce:animate-none')} />
              </Button>
            ) : (
              <TrailingSpace />
            )}
          </>
        )}
      </div>
    </div>
  )
}
