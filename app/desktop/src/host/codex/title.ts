// Session title from a small Codex model: ephemeral app-server thread, read-only.
import { tmpdir } from 'node:os'
import { TextToolAttempt, TextUnsafe, codexRefuse, isPlainServerName, codexTextConfig, codexToolItem, isTextBlocked, mcpServerNames } from '../text-safety'
import { TITLE_SYSTEM, cleanTitle } from '../titles'
import { codexEnv } from './environment'
import { CodexRpc } from './rpc'

const TIMEOUT_MS = 40_000

/** The smallest model on the account ("mini"); null if none: the title stays provisional. */
export function smallCodexModel(models: { id: string; label: string }[]): string | null {
  return models.find((m) => /mini/i.test(m.id) || /mini/i.test(m.label))?.id ?? null
}

export async function codexTitle(cli: string, version: string, model: string, prompt: string, configDir: string | null = null): Promise<string | null> {
  try {
    const raw = await codexText(cli, version, model, TITLE_SYSTEM, prompt, TIMEOUT_MS, configDir)
    return raw === null ? null : cleanTitle(raw)
  } catch (error) {
    // A title is a nice-to-have: if generation attempted a tool it is discarded, with no error for the user.
    if (isTextBlocked(error)) return null
    throw error
  }
}

/**
 * Free text from the small model (commit, PR, branch): same ephemeral thread as titles, text ONLY. Barriers: read-only,
 * every command asks for an approval that is rejected (approvalPolicy 'untrusted'), tool features off, every user MCP server disabled by name (config/read),
 * every tool request rejected and any item that is not text stops the turn. In that case it throws TextToolAttempt
 * (the diff is untrusted data). null if it fails or times out.
 * A temporary CODEX_HOME is not used: it would require copying auth.json (credentials), and a refreshed token in the copy
 * would invalidate the user's; with credentials in the Keychain it would not work at all.
 */
export async function codexText(cli: string, version: string, model: string, system: string, prompt: string, timeoutMs: number, configDir: string | null = null, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null
  let reply = ''
  let blocked = null as string | null
  let unsafe = false as boolean
  let threadId = null as string | null
  let turnId = null as string | null
  let finish: (ok: boolean) => void = () => undefined
  const done = new Promise<boolean>((resolve) => (finish = resolve))
  /** A tool was attempted: turn/interrupt (better that it stops by itself), then the process is closed. */
  const block = (tool: string): void => {
    if (blocked !== null) return
    blocked = tool
    // After the event loop turn: the rejection reply to the request goes first, then the interrupt.
    setImmediate(() => {
      if (threadId && turnId) void rpc.request('turn/interrupt', { threadId, turnId }, 2_000).catch(() => undefined).finally(() => finish(false))
      else finish(false)
    })
  }
  const rpc = new CodexRpc(
    cli,
    await codexEnv(configDir),
    (method, params) => {
      if (method === 'turn/started') turnId = (params.turn as { id?: string } | undefined)?.id ?? turnId
      const tool = codexToolItem(method, params)
      if (tool) block(tool)
      if (method === 'item/completed') {
        const item = params.item as { type?: string; text?: string } | undefined
        if (item?.type === 'agentMessage') reply = String(item.text ?? '')
      } else if (method === 'turn/completed') {
        finish((params.turn as { status?: string } | undefined)?.status === 'completed')
      }
    },
    // No approvals or tools: every request gets an explicit rejection and stops generation.
    async (request) => {
      const { reply, tool } = codexRefuse(request.method)
      if (tool) block(tool)
      return reply
    }
  )
  // On timeout the process is stopped: pending requests fail immediately and the catch returns null.
  const timer = setTimeout(() => {
    finish(false)
    rpc.kill()
  }, timeoutMs)
  void rpc.exited.then(() => finish(false))
  // Cancellation from outside (text.cancel): the process is stopped.
  const cancel = (): void => {
    finish(false)
    rpc.kill()
  }
  signal?.addEventListener('abort', cancel, { once: true })
  // Cancelled while the process was starting (await codexEnv): the event has already passed, so check again here.
  if (signal?.aborted) cancel()
  try {
    await rpc.initialize(version)
    // MCP servers from the user's config: without the names they cannot be turned off, so without them nothing is generated (fail-closed).
    // Reply of a different shape than expected (null) or a non-simple name: nothing is generated.
    const names = mcpServerNames(await rpc.request('config/read', { includeLayers: false, cwd: tmpdir() }, 15_000))
    if (!names || !names.every(isPlainServerName)) {
      unsafe = true
      throw new TextUnsafe()
    }
    const started = await rpc.request<{ thread: { id: string } }>('thread/start', {
      cwd: tmpdir(),
      model,
      ephemeral: true,
      // 'untrusted': every command, even read-only, asks for an approval, which is rejected (tested on Codex 0.167 with cat, ls, pwd, git --version; with 'never' and 'on-request' a read-only command runs without asking).
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      developerInstructions: system,
      config: codexTextConfig(names)
    })
    threadId = started.thread.id
    const turn = await rpc.request<{ turn?: { id?: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      effort: 'low',
      serviceTierForTurn: 'default'
    })
    turnId = turn.turn?.id ?? turnId
    const ok = await done
    if (blocked === null) return ok ? reply : null
  } catch {
    if (blocked === null && !unsafe) return null
  } finally {
    clearTimeout(timer)
    rpc.kill()
  }
  // Reached only if a tool was attempted or the configuration cannot be made safe: never return text.
  if (unsafe) throw new TextUnsafe()
  console.warn(`[text] tool attempt blocked: ${blocked}`)
  throw new TextToolAttempt(blocked ?? 'unknown')
}
