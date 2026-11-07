// Dati d'esempio per la fase 0: la sidebar mostra progetti e stati senza collegarsi agli agenti.
import type { AgentId } from '@/lib/agents'

export type SessionState = 'idle' | 'running' | 'unread' | 'waiting' | 'error'

export interface SessionSummary {
  id: string
  title: string
  agent: AgentId
  state: SessionState
  /** Testo breve a destra della riga: età, "bozza", etichetta della richiesta. */
  note: string
  waitingLabel?: string
}

export interface ProjectSummary {
  id: string
  name: string
  branch: string
  sessions: SessionSummary[]
}

export const sampleProjects: ProjectSummary[] = [
  {
    id: 'acme-monorepo',
    name: 'acme-monorepo',
    branch: 'main',
    sessions: [
      { id: 'c1', title: 'Filtri tabella pagamenti', agent: 'claude-code', state: 'unread', note: '2 min' },
      { id: 'c2', title: 'Export CSV movimenti', agent: 'claude-code', state: 'running', note: '3 min' },
      { id: 'c3', title: 'Refactor form anagrafica', agent: 'codex', state: 'idle', note: 'bozza' }
    ]
  },
  {
    id: 'acme-vet',
    name: 'acme-vet',
    branch: 'feat/rebrand-ux',
    sessions: [
      { id: 'f1', title: 'Sessione con cookie httpOnly', agent: 'claude-code', state: 'waiting', note: '3 min', waitingLabel: 'Approvazione' },
      { id: 'f2', title: 'Fix tema scuro', agent: 'codex', state: 'idle', note: 'ieri' }
    ]
  },
  {
    id: 'sample-shop',
    name: 'sample-shop',
    branch: 'main',
    sessions: [
      { id: 'd1', title: 'Paginazione API', agent: 'claude-code', state: 'unread', note: '12 min' },
      { id: 'd2', title: 'Copy onboarding', agent: 'claude-code', state: 'unread', note: '25 min' }
    ]
  },
  { id: 'sample-client', name: 'sample-client', branch: 'main', sessions: [] },
  {
    id: 'acme-vet-mobile',
    name: 'acme-vet-mobile',
    branch: 'develop',
    sessions: [{ id: 'm1', title: 'Upgrade Expo', agent: 'codex', state: 'running', note: '8 min' }]
  },
  { id: 'mobile', name: 'mobile', branch: 'main', sessions: [] }
]

export interface ProjectAttention {
  waiting: number
  unread: number
  running: boolean
  error: boolean
}

export function projectAttention(project: ProjectSummary): ProjectAttention {
  return {
    waiting: project.sessions.filter((s) => s.state === 'waiting').length,
    unread: project.sessions.filter((s) => s.state === 'unread').length,
    running: project.sessions.some((s) => s.state === 'running'),
    error: project.sessions.some((s) => s.state === 'error')
  }
}
