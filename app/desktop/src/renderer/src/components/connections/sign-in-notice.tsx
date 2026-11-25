// Above the composer: the agent is not connected, so the session would fail at the first message. The button leads to the right row.
import { CircleDashed, Loader2 } from 'lucide-react'
import type { AgentId, ConnectionId } from '@shared/protocol'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { CONNECTION_NAME, connectionOfAgent, needsSignIn } from '@/lib/connections'
import { connectionFor, hostProfileId, isProfileAgent, normalizeProfileId, useProfiles } from '@/lib/profiles'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app-store'

/** Connection to make before using the agent, or null if all is fine (or if it is an ACP agent, which handles login itself). */
export function useSignInNeeded(agent: AgentId, profileId?: string | null): { id: ConnectionId; profileId?: string; signingIn: boolean } | null {
  const id = connectionOfAgent(agent)
  const status = useApp((s) => (id && isProfileAgent(agent) ? connectionFor(s, agent, profileId) : id ? s.connections[id] : undefined))
  if (!id || !status) return null
  const signingIn = Boolean(status.login)
  return signingIn || needsSignIn(status) ? { id, ...(hostProfileId(profileId) ? { profileId: hostProfileId(profileId) } : {}), signingIn } : null
}

export function SignInNotice({ agent, profileId, className }: { agent: AgentId; profileId?: string | null; className?: string }) {
  const needed = useSignInNeeded(agent, profileId)
  const profiles = useProfiles(agent)
  if (!needed) return null
  // With several accounts we say which: "Claude (Lavoro)".
  const profile = profiles.length > 1 ? profiles.find((p) => p.id === (isProfileAgent(agent) ? normalizeProfileId(agent, needed.profileId) : needed.profileId)) : undefined
  const name = profile ? `${CONNECTION_NAME[needed.id]} (${profile.name})` : CONNECTION_NAME[needed.id]
  return (
    <div role="status" className={cn('flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm', className)}>
      {needed.signingIn ? <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" /> : <CircleDashed aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1">{needed.signingIn ? t('Signing in to {name}…', { name }) : t('{name} isn’t signed in. Sign in to start a session.', { name })}</span>
      <Button variant="outline" size="sm" className="shrink-0 text-sm" aria-label={needed.signingIn ? t('Show the sign in to {name}', { name }) : t('Sign in to {name}', { name })} onClick={() => useApp.getState().focusConnection(needed.id, needed.profileId)}>
        {needed.signingIn ? t('Show') : t('Sign in')}
      </Button>
    </div>
  )
}
