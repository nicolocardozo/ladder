// Session title from a small model: a separate Agent SDK query(), with no tools or settings.
import { tmpdir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { TITLE_SYSTEM, cleanTitle } from '../titles'
import { TextToolAttempt, TextUnsafe, claudeInitIsClean, claudeTextOnly, claudeToolUses, isTextBlocked } from '../text-safety'
import { claudeEnv } from './environment'

const TIMEOUT_MS = 30_000

/** Title proposed by Haiku (user's subscription, same login as the CLI); null if it fails or times out. */
export async function claudeTitle(cli: string | null, prompt: string, configDir: string | null = null): Promise<string | null> {
  try {
    const raw = await claudeText(cli, TITLE_SYSTEM, prompt, TIMEOUT_MS, configDir)
    return raw === null ? null : cleanTitle(raw)
  } catch (error) {
    // A title is a nice-to-have: if generation attempted a tool it is discarded, with no error for the user.
    if (isTextBlocked(error)) return null
    throw error
  }
}

/**
 * Free text from the small model (commit, PR, branch): same query() as titles, text ONLY and no tools (see
 * claudeTextOnly). null if it fails or times out; if the model tries to use a tool, generation stops and throws
 * TextToolAttempt (the diff is untrusted data).
 */
export async function claudeText(cli: string | null, system: string, prompt: string, timeoutMs: number, configDir: string | null = null, signal?: AbortSignal): Promise<string | null> {
  const abort = new AbortController()
  let blocked = null as string | null
  // Cancellation from outside (text.cancel): stops the query.
  if (signal?.aborted) return null
  signal?.addEventListener('abort', () => abort.abort(), { once: true })
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  const q = query({
    prompt,
    options: {
      // Neutral folder: no CLAUDE.md or project files.
      cwd: tmpdir(),
      env: claudeEnv(configDir),
      abortController: abort,
      ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
      model: 'haiku',
      systemPrompt: system,
      ...claudeTextOnly((name) => {
        blocked = name
        abort.abort()
      })
    }
  })
  try {
    for await (const message of q) {
      // Fail-closed: if the process starts with tools or MCP servers, generation does not even begin.
      if (message.type === 'system' && message.subtype === 'init' && !claudeInitIsClean(message)) {
        blocked = 'init'
        break
      }
      const uses = claudeToolUses(message)
      if (uses.length > 0 || (message.type === 'system' && (message as { subtype?: string }).subtype === 'permission_denied')) {
        blocked = uses[0] ?? 'permission_denied'
        break
      }
      if (blocked) break
      if (message.type === 'result') return message.subtype === 'success' ? message.result : null
    }
    if (blocked === null) return null
  } catch {
    if (blocked === null) return null
  } finally {
    clearTimeout(timer)
    abort.abort()
    q.close()
  }
  // Reached only if a tool was attempted or denied: never return text in that case.
  console.warn(`[text] tool attempt blocked: ${blocked}`)
  throw blocked === 'init' ? new TextUnsafe() : new TextToolAttempt(blocked ?? 'unknown')
}
