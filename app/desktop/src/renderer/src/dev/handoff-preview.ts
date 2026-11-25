// Fake host for session.handoff: validates like the host and passes the command to the preview page, which simulates the flow in the chat.
import type { HostCommand } from '@shared/protocol'
import { registerPreviewHandler } from './shortcuts-preview'

type HandoffCommand = Extract<HostCommand, { type: 'session.handoff' }>

let sink: ((command: HandoffCommand) => void) | null = null
let registered = false

/** `agent` of the preview session, to reject a handoff to the same agent. */
export function installHandoffPreview(currentAgent: () => string, onHandoff: (command: HandoffCommand) => void): void {
  sink = onHandoff
  if (registered) return
  registered = true
  registerPreviewHandler((command) => {
    if (command.type !== 'session.handoff') return undefined
    if (command.agent === currentAgent()) return { ok: false, error: 'The session already runs on this agent.' }
    // With the note "fail" the host answers with an error, to see how the dialog shows it.
    if (command.note?.trim().toLowerCase() === 'fail') return { ok: false, error: 'Codex is not available right now. Try again in a moment.' }
    sink?.(command)
    return { ok: true, data: null }
  })
}
