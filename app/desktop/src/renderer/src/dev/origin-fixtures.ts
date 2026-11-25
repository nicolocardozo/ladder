// Session origins for the web preview: sessions started from the CLI or by an agent, and the parent chat with the MCP tool row.
import type { CliStatus, HostCommand, SessionSummary } from '@shared/protocol'
import { ConversationBuilder, normalFixture, type Fixture } from './fixtures'
import { planSession } from './plan-fixtures'
import { registerPreviewHandler } from './shortcuts-preview'

export type OriginScenario = 'cli' | 'agent' | 'parent'

export const ORIGIN_SCENARIOS: { id: OriginScenario; label: string }[] = [
  { id: 'cli', label: 'Origin: from the terminal' },
  { id: 'agent', label: 'Origin: from an agent' },
  { id: 'parent', label: 'Origin: parent chat (MCP tool)' }
]

export interface OriginFixture extends Fixture {
  sessions: SessionSummary[]
  /** Session to show in the banner and the sidebar mark (the parent chat has none). */
  originSessionId: string | null
}

const PARENT = 'origin-parent'
const CHILD = 'origin-child'

export function originFixture(scenario: OriginScenario): OriginFixture {
  const parent = planSession(PARENT, 'Authentication migration', { run: 'idle' })
  const child = planSession(CHILD, 'Fix the refresh tests', { agent: 'codex', run: 'running', origin: { kind: 'agent', sessionId: PARENT, agent: 'claude-code' } })
  const fromCli = planSession('origin-cli', 'Rename the table components', { run: 'idle', origin: { kind: 'cli' } })
  const sessions = [parent, child, fromCli]
  if (scenario === 'cli') return { ...normalFixture(), sessions, originSessionId: fromCli.id }
  if (scenario === 'agent') return { ...normalFixture(), sessions, originSessionId: child.id }
  const b = new ConversationBuilder(Date.now() - 20 * 60_000, 'o')
  b.turn()
  b.user('Have Codex fix the refresh tests and tell me when it is done.', 0)
  b.assistant('I am starting a session with Codex and waiting for the result.', false, 3_000)
  b.tool('other', 'mcp__ladder__ladder_start_session', 'Starts a session with Codex', null, { output: JSON.stringify({ sessionId: CHILD, title: 'Fix the refresh tests', status: 'running' }), ms: 900 })
  b.tool('other', 'mcp__ladder__ladder_wait', 'Waits for the session', null, { output: JSON.stringify({ sessionId: CHILD, status: 'idle' }), ms: 40_000 })
  b.assistant('Codex is done: the refresh tests pass.', false, 2_000)
  b.end({ durationMs: 55_000 })
  b.shiftToNow(30_000)
  return { items: b.items, run: 'idle', activity: null, firstUnreadSeq: null, sessions, originSessionId: null }
}

// ── Fake cli.status ────────────────────────────────────────────────────────

export type CliCase = 'installed' | 'missing' | 'no-path'

let current: CliStatus = { installed: true, path: '/Users/dev/.local/bin/ladder', inPath: true, socket: '/tmp/ladder.sock' }
const CASES: Record<CliCase, CliStatus> = {
  installed: current,
  missing: { installed: false, path: '/Users/dev/.local/bin/ladder', inPath: true, socket: '/tmp/ladder.sock' },
  'no-path': { installed: true, path: '/Users/dev/.local/bin/ladder', inPath: false, socket: null }
}

export function setCliCase(id: CliCase): void {
  current = CASES[id]
}

let installed = false
/** Answers cli.status, cli.install and cli.uninstall; the fake host (installSettingsPreview) must already be active. */
export function installCliPreview(): void {
  if (installed) return
  installed = true
  registerPreviewHandler((command: HostCommand) => {
    if (command.type === 'cli.status') return { ok: true, data: current }
    if (command.type === 'cli.install') {
      current = { ...current, installed: true }
      return { ok: true, data: current }
    }
    if (command.type === 'cli.uninstall') {
      current = { ...current, installed: false }
      return { ok: true, data: current }
    }
    return undefined
  })
}
