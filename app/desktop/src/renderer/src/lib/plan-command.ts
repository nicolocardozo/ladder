// /plan <goal>: sends the agent the `plan_request` prompt, which asks for an executable plan through propose_plan.
// The prompt goes through the host so a project can replace it with [prompts] in .ladder/settings.toml.
import type { SessionSummary } from '@shared/protocol'
import { request } from '@/lib/host-client'

/** Rejects after reporting the error, so the composer can give the goal back. */
export async function runPlanCommand(session: Pick<SessionSummary, 'id' | 'projectId'>, goal: string, onError: (message: string | null) => void): Promise<void> {
  onError(null)
  try {
    const text = await request<string>({ type: 'prompt.render', projectId: session.projectId, name: 'plan_request', vars: { goal } })
    // A busy session queues it for the end of the current turn, like any message.
    await request({ type: 'session.send', sessionId: session.id, text })
  } catch (e) {
    onError((e as Error).message)
    throw e
  }
}
