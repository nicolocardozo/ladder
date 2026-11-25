// Fake host for resuming handoffs and delegations and for the plan limit: validates like the host and passes the command to the preview page.
import type { HostCommand } from '@shared/protocol'
import { registerPreviewHandler } from './shortcuts-preview'

type Of<T extends HostCommand['type']> = Extract<HostCommand, { type: T }>

export interface AgentFlowSink {
  currentAgent: () => string
  stop: (command: Of<'session.handoff.stop'>) => void
  resume: (command: Of<'session.handoff.resume'>) => void
  delegation: (command: Of<'session.delegation.resume'>) => void
  limit: (command: Of<'session.limit.respond'>) => void
}

let sink: AgentFlowSink | null = null
let registered = false

/** An "acp:gemini" agent makes the host answer with an error, to see how reassignment and the agent choice show it. */
const UNAVAILABLE = { ok: false as const, error: 'Gemini is not available right now. Try again in a moment.' }

export function installAgentFlowPreview(next: AgentFlowSink): void {
  sink = next
  if (registered) return
  registered = true
  registerPreviewHandler((command) => {
    if (!sink) return undefined
    switch (command.type) {
      case 'session.handoff.stop':
        sink.stop(command)
        return { ok: true, data: null }
      case 'session.handoff.resume':
        if (command.agent === sink.currentAgent()) return { ok: false, error: 'The session already runs on this agent.' }
        if (command.agent === 'acp:gemini') return UNAVAILABLE
        sink.resume(command)
        return { ok: true, data: null }
      case 'session.delegation.resume':
        sink.delegation(command)
        return { ok: true, data: null }
      case 'session.limit.respond':
        if (command.agent === 'acp:gemini') return UNAVAILABLE
        sink.limit(command)
        return { ok: true, data: null }
      default:
        return undefined
    }
  })
}
