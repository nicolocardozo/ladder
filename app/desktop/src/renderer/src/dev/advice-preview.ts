// Fake host for advice and "Implement with…": validates like the host and passes the command to the preview page, which simulates the flow in the chat.
import type { HostCommand } from '@shared/protocol'
import { registerPreviewHandler } from './shortcuts-preview'

type Of<T extends HostCommand['type']> = Extract<HostCommand, { type: T }>

export interface AdvicePreviewSink {
  /** Agent of the preview session: lets "Implement with…" know whether the plan stays in the session. */
  currentAgent: () => string
  advise: (command: Of<'session.advise'>) => string
  stop: (command: Of<'session.advice.stop'>) => void
  forward: (command: Of<'session.advice.forward'>) => void
  implement: (command: Of<'session.implement'>) => string
}

let sink: AdvicePreviewSink | null = null
let registered = false

export function installAdvicePreview(next: AdvicePreviewSink): void {
  sink = next
  if (registered) return
  registered = true
  registerPreviewHandler((command) => {
    if (!sink) return undefined
    switch (command.type) {
      case 'session.advise': {
        const ids = command.agents.map((a) => a.agent)
        if (ids.length === 0 || ids.length > 4) return { ok: false, error: 'Choose between one and four agents.' }
        if (new Set(ids).size !== ids.length) return { ok: false, error: 'A committee needs different agents.' }
        // With «fail» in the question the host answers with an error, to see how the dialog shows it.
        if (command.question.trim().toLowerCase() === 'fail') return { ok: false, error: 'Codex is not available right now. Try again in a moment.' }
        return { ok: true, data: sink.advise(command) }
      }
      case 'session.advice.stop':
        sink.stop(command)
        return { ok: true, data: null }
      case 'session.advice.forward':
        if (command.note?.trim().toLowerCase() === 'fail') return { ok: false, error: 'The session is not available to receive the advice.' }
        sink.forward(command)
        return { ok: true, data: null }
      case 'session.implement':
        if (command.plan.trim() === '') return { ok: false, error: 'The plan is empty.' }
        // A «fail» comment makes the handoff to another agent fail, to see the error in the panel.
        if (command.agent !== sink.currentAgent() && command.comments.some((c) => c.text.trim().toLowerCase() === 'fail')) return { ok: false, error: 'Codex is not available right now. Try again in a moment.' }
        return { ok: true, data: sink.implement(command) }
      default:
        return undefined
    }
  })
}
